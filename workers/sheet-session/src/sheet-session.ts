/**
 * SheetSession — Durable Object for per-Sheet collaborative session state.
 *
 * One DO instance exists per `records_sheets.id`. It is the *real-time relay*
 * for that sheet — not the source of truth.
 *
 * Responsibilities (this DO owns):
 *   - Presence: who is connected, with last-seen + optional cursor metadata.
 *   - Recent edits ring buffer (size RING_BUFFER_SIZE) so a late-joining tab
 *     can catch up on the last N cell updates without re-reading the DB.
 *   - Authoritative monotonic `seq` assignment for every broadcast edit so
 *     clients can apply updates deterministically and detect gaps.
 *   - Optimistic update fan-out: a client posts a `cell_update`, the DO
 *     stamps it with `seq + userId` and broadcasts to every other socket.
 *
 * NOT responsibilities (intentionally out of scope here):
 *   - Persisting edits to D1. The REST API in the Pages project
 *     (`functions/api/records/...`) is the source of truth: it writes to
 *     D1 first, then POSTs to this DO's `/broadcast` endpoint to fan out.
 *     This DO trusts its caller.
 *   - Authorization. The Pages Function that routes the WebSocket upgrade
 *     (or the REST call to /broadcast) is responsible for verifying the
 *     user can read/write this sheet before forwarding into the DO.
 *   - Conflict resolution. We assign a sequence number; we do not run OT
 *     or CRDTs. Last-write-wins per cell, ordered by `seq`.
 *
 * Persistence: only `lastSeq` is written to durable storage so that across
 * DO eviction + revival the seq numbers remain monotonic. The ring buffer
 * is in-memory only — losing it on eviction is acceptable since clients
 * fall back to a REST refetch when they detect a seq gap.
 *
 * Hosting note: this class lives in its own Worker because Cloudflare
 * Pages cannot host DO classes. The Pages project binds to this Worker
 * via `script_name` in its `wrangler.toml`.
 *
 * Follow-ups (deliberately deferred):
 *   - Hibernation API (acceptWebSocket) for cost reduction once load
 *     justifies it. Today we keep sockets in plain JS state.
 *   - Presence eviction policy (currently relies on socket close events;
 *     no idle-timeout sweeper yet).
 *   - Ring buffer size tuning under real traffic (200 is a guess).
 */

interface ConnectedSocket {
  ws: WebSocket;
  sessionId: string;
  userId: string;
  joinedAt: number;
  cursor?: { rowId: string; columnKey: string } | null;
}

interface EditEvent {
  type: 'cell_update';
  seq: number;
  userId: string;
  rowId: string;
  columnKey: string;
  value: unknown;
  /** Echoed back so the originating client can reconcile its optimistic state. */
  clientSeq?: number;
  ts: number;
}

interface PresenceSnapshotEntry {
  sessionId: string;
  userId: string;
  joinedAt: number;
  cursor?: { rowId: string; columnKey: string } | null;
}

const RING_BUFFER_SIZE = 200;

/**
 * Inbound message shapes accepted from clients over the WebSocket.
 */
type InboundMessage =
  | {
      type: 'cell_update';
      rowId: string;
      columnKey: string;
      value: unknown;
      clientSeq?: number;
    }
  | {
      type: 'presence';
      cursor?: { rowId: string; columnKey: string } | null;
    }
  | { type: 'ping' };

/**
 * Outbound message shapes broadcast to clients.
 */
type OutboundMessage =
  | EditEvent
  | { type: 'presence_join'; sessionId: string; userId: string; joinedAt: number }
  | { type: 'presence_leave'; sessionId: string; userId: string }
  | { type: 'presence_cursor'; sessionId: string; userId: string; cursor: { rowId: string; columnKey: string } | null }
  | {
      type: 'snapshot';
      lastSeq: number;
      recentEdits: EditEvent[];
      presence: PresenceSnapshotEntry[];
    }
  | { type: 'pong'; ts: number }
  | { type: 'error'; message: string };

/**
 * Minimal Durable Object types. We avoid pulling in the full
 * @cloudflare/workers-types DurableObject namespace here; the surface we
 * touch is small and stable.
 */
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/**
 * Env for this Worker. The DO is a pure relay; it does not consume any
 * bindings beyond its own DO state. The Worker has a self-referential
 * `SHEET_SESSION` DO binding so the runtime can host the class — it is
 * not used from inside the class itself.
 */
export interface Env {
  SHEET_SESSION: DurableObjectNamespace;
}

export class SheetSession {
  private state: DurableObjectState;
  // env is intentionally unused (DO is a pure relay) but kept so the
  // constructor signature matches the Cloudflare contract.
  // @ts-expect-error — kept for constructor signature compatibility.
  private env: Env;
  private sockets = new Map<string, ConnectedSocket>();
  private recentEdits: EditEvent[] = [];
  private lastSeq = 0;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Lazy hydration of `lastSeq` from durable storage. Called via
   * blockConcurrencyWhile on first request so concurrent requests can't
   * race past an unhydrated counter.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.initialized) return;
      const stored = await this.state.storage.get<number>('lastSeq');
      this.lastSeq = typeof stored === 'number' ? stored : 0;
      this.initialized = true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      return this.handleConnect(request, url);
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      return this.handleBroadcast(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ---------------------------------------------------------------------
  // /connect — WebSocket upgrade
  // ---------------------------------------------------------------------

  private handleConnect(request: Request, url: URL): Response {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // The Pages Function handler is expected to have authenticated the
    // user and to pass identity in via query params. The DO trusts this.
    const userId = url.searchParams.get('userId');
    const sessionId = url.searchParams.get('sessionId') ?? crypto.randomUUID();
    if (!userId) {
      return new Response('userId required', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.registerSocket(server, sessionId, userId);

    return new Response(null, { status: 101, webSocket: client });
  }

  private registerSocket(ws: WebSocket, sessionId: string, userId: string): void {
    const conn: ConnectedSocket = {
      ws,
      sessionId,
      userId,
      joinedAt: Date.now(),
      cursor: null,
    };
    this.sockets.set(sessionId, conn);

    // Send the snapshot first so the client has presence + recent edits
    // before any subsequent broadcast arrives.
    this.sendTo(conn, {
      type: 'snapshot',
      lastSeq: this.lastSeq,
      recentEdits: [...this.recentEdits],
      presence: [...this.sockets.values()].map((s) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        joinedAt: s.joinedAt,
        cursor: s.cursor ?? null,
      })),
    });

    // Announce join to everyone else.
    this.broadcast(
      { type: 'presence_join', sessionId, userId, joinedAt: conn.joinedAt },
      sessionId,
    );

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(conn, event).catch((err) => {
        this.sendTo(conn, {
          type: 'error',
          message: err instanceof Error ? err.message : 'unknown error',
        });
      });
    });

    const onClose = () => this.unregisterSocket(sessionId);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  private unregisterSocket(sessionId: string): void {
    const conn = this.sockets.get(sessionId);
    if (!conn) return;
    this.sockets.delete(sessionId);
    this.broadcast(
      { type: 'presence_leave', sessionId, userId: conn.userId },
      sessionId,
    );
  }

  private async handleMessage(conn: ConnectedSocket, event: MessageEvent): Promise<void> {
    let parsed: InboundMessage;
    try {
      parsed =
        typeof event.data === 'string'
          ? (JSON.parse(event.data) as InboundMessage)
          : (JSON.parse(new TextDecoder().decode(event.data as ArrayBuffer)) as InboundMessage);
    } catch {
      this.sendTo(conn, { type: 'error', message: 'invalid JSON' });
      return;
    }

    switch (parsed.type) {
      case 'ping':
        this.sendTo(conn, { type: 'pong', ts: Date.now() });
        return;

      case 'presence':
        conn.cursor = parsed.cursor ?? null;
        this.broadcast(
          {
            type: 'presence_cursor',
            sessionId: conn.sessionId,
            userId: conn.userId,
            cursor: conn.cursor,
          },
          conn.sessionId,
        );
        return;

      case 'cell_update': {
        // NB: the DO does NOT persist this to D1. Clients calling here
        // directly are doing optimistic fan-out only; the canonical write
        // path is the REST API, which calls /broadcast after committing.
        const edit = await this.recordEdit({
          userId: conn.userId,
          rowId: parsed.rowId,
          columnKey: parsed.columnKey,
          value: parsed.value,
          clientSeq: parsed.clientSeq,
        });
        this.broadcast(edit, conn.sessionId);
        // Echo back to originator so they have the canonical seq.
        this.sendTo(conn, edit);
        return;
      }

      default:
        this.sendTo(conn, { type: 'error', message: 'unknown message type' });
    }
  }

  // ---------------------------------------------------------------------
  // /broadcast — server-side push from REST handlers
  // ---------------------------------------------------------------------

  private async handleBroadcast(request: Request): Promise<Response> {
    let body: {
      userId: string;
      rowId: string;
      columnKey: string;
      value: unknown;
      clientSeq?: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (!body.userId || !body.rowId || !body.columnKey) {
      return new Response('userId, rowId, columnKey required', { status: 400 });
    }
    const edit = await this.recordEdit(body);
    // No exclusion: the originating user's other tabs should also receive.
    this.broadcast(edit, null);
    return Response.json({ ok: true, seq: edit.seq });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async recordEdit(input: {
    userId: string;
    rowId: string;
    columnKey: string;
    value: unknown;
    clientSeq?: number;
  }): Promise<EditEvent> {
    this.lastSeq += 1;
    const seq = this.lastSeq;
    // Persist seq best-effort. We don't await blockConcurrencyWhile here
    // because put() is already serialized by the runtime; a crash before
    // flush at worst replays a seq, which clients tolerate.
    await this.state.storage.put('lastSeq', seq);

    const edit: EditEvent = {
      type: 'cell_update',
      seq,
      userId: input.userId,
      rowId: input.rowId,
      columnKey: input.columnKey,
      value: input.value,
      clientSeq: input.clientSeq,
      ts: Date.now(),
    };

    this.recentEdits.push(edit);
    if (this.recentEdits.length > RING_BUFFER_SIZE) {
      this.recentEdits.splice(0, this.recentEdits.length - RING_BUFFER_SIZE);
    }
    return edit;
  }

  private broadcast(message: OutboundMessage, excludeSessionId: string | null): void {
    const payload = JSON.stringify(message);
    for (const conn of this.sockets.values()) {
      if (excludeSessionId && conn.sessionId === excludeSessionId) continue;
      try {
        conn.ws.send(payload);
      } catch {
        // Socket likely dead; let close/error events clean it up.
      }
    }
  }

  private sendTo(conn: ConnectedSocket, message: OutboundMessage): void {
    try {
      conn.ws.send(JSON.stringify(message));
    } catch {
      // Best-effort; cleanup happens in close handler.
    }
  }
}
