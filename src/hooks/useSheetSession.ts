/**
 * useSheetSession — manages the WebSocket lifetime for a single Records
 * sheet detail view.
 *
 * The hook owns the connection, presence list, and last-seen seq, and
 * exposes a `subscribe(handler)` API so consumers can react to remote
 * cell updates without re-rendering on every event. Reconnect is
 * exponential-backoff with a cap; if the socket can't reach the server
 * we degrade to REST-only mode (no error toast — real-time is
 * enhancement, not required, per the design philosophy).
 *
 * Why a manual subscriber pattern instead of stuffing events into React
 * state? Cell updates flow through a separate keyed map managed by the
 * page (so a single cell mutation doesn't re-render the whole grid) —
 * the hook just delivers them.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { AUTH_TOKEN_KEY } from '../lib/types';

export interface SheetPresenceEntry {
  sessionId: string;
  userId: string;
  joinedAt: number;
}

export interface SheetCellUpdate {
  type: 'cell_update';
  seq: number;
  userId: string;
  rowId: string;
  columnKey: string;
  value: unknown;
  clientSeq?: number;
  ts: number;
}

type SnapshotMessage = {
  type: 'snapshot';
  lastSeq: number;
  recentEdits: SheetCellUpdate[];
  presence: SheetPresenceEntry[];
};

type IncomingMessage =
  | SnapshotMessage
  | SheetCellUpdate
  | { type: 'presence_join'; sessionId: string; userId: string; joinedAt: number }
  | { type: 'presence_leave'; sessionId: string; userId: string }
  | { type: 'presence_cursor'; sessionId: string; userId: string; cursor: { rowId: string; columnKey: string } | null }
  | { type: 'pong'; ts: number }
  | { type: 'error'; message: string };

export interface SheetSessionState {
  /** Connection status; presence reflects the DO's view, including self. */
  status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';
  presence: SheetPresenceEntry[];
  lastSeq: number;
}

export interface SheetSessionApi extends SheetSessionState {
  /** Subscribe to remote cell updates. Returns an unsubscribe fn. */
  subscribe: (handler: (event: SheetCellUpdate) => void) => () => void;
}

/**
 * Build the wss:// URL for the sheet WebSocket. Token goes in the query
 * string because browsers can't set Authorization headers on the
 * WebSocket constructor — the auth middleware honours `?token=`.
 */
function buildSocketUrl(sheetId: string, token: string, sessionId: string | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  params.set('token', token);
  if (sessionId) params.set('sessionId', sessionId);
  return `${proto}//${window.location.host}/api/records/sheets/${sheetId}/connect?${params.toString()}`;
}

const RECONNECT_DELAYS_MS = [500, 1500, 4000, 10_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 6;

export function useSheetSession(sheetId: string | undefined): SheetSessionApi {
  const [status, setStatus] = useState<SheetSessionState['status']>('idle');
  const [presence, setPresence] = useState<SheetPresenceEntry[]>([]);
  const [lastSeq, setLastSeq] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef(new Set<(event: SheetCellUpdate) => void>());
  const sessionIdRef = useRef<string | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const explicitlyClosedRef = useRef(false);

  const subscribe = useCallback((handler: (event: SheetCellUpdate) => void) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (!sheetId) return;
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) return; // No auth, skip realtime entirely.

    explicitlyClosedRef.current = false;
    if (sessionIdRef.current === null && typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      sessionIdRef.current = crypto.randomUUID();
    }

    const connect = () => {
      // Avoid double-connecting if a previous attempt is still pending.
      if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

      setStatus(reconnectAttemptRef.current === 0 ? 'connecting' : 'reconnecting');

      let socket: WebSocket;
      try {
        socket = new WebSocket(buildSocketUrl(sheetId, token, sessionIdRef.current));
      } catch (err) {
        // Construction failures (very rare) — we treat as a dropped connect.
        console.warn('[SheetSession] socket construction threw', err);
        scheduleReconnect();
        return;
      }
      wsRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
        setStatus('open');
      });

      socket.addEventListener('message', (event) => {
        let parsed: IncomingMessage;
        try {
          parsed = JSON.parse(event.data) as IncomingMessage;
        } catch {
          return;
        }
        switch (parsed.type) {
          case 'snapshot':
            setPresence(
              parsed.presence.map((p) => ({
                sessionId: p.sessionId,
                userId: p.userId,
                joinedAt: p.joinedAt,
              })),
            );
            setLastSeq(parsed.lastSeq);
            // Replay recent edits so a late join still applies them.
            for (const edit of parsed.recentEdits) {
              for (const sub of subscribersRef.current) sub(edit);
            }
            break;

          case 'presence_join':
            setPresence((prev) =>
              prev.some((p) => p.sessionId === parsed.sessionId)
                ? prev
                : [...prev, { sessionId: parsed.sessionId, userId: parsed.userId, joinedAt: parsed.joinedAt }],
            );
            break;

          case 'presence_leave':
            setPresence((prev) => prev.filter((p) => p.sessionId !== parsed.sessionId));
            break;

          case 'cell_update':
            setLastSeq((s) => Math.max(s, parsed.seq));
            for (const sub of subscribersRef.current) sub(parsed);
            break;

          // presence_cursor / pong / error: no-op for Phase 1.
          default:
            break;
        }
      });

      const onCloseOrError = () => {
        wsRef.current = null;
        if (explicitlyClosedRef.current) return;
        scheduleReconnect();
      };
      socket.addEventListener('close', onCloseOrError);
      socket.addEventListener('error', onCloseOrError);
    };

    const scheduleReconnect = () => {
      if (explicitlyClosedRef.current) return;
      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('failed');
        return;
      }
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current += 1;
      setStatus('reconnecting');
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      explicitlyClosedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
        try {
          wsRef.current.close(1000, 'unmount');
        } catch {
          // best-effort
        }
      }
      wsRef.current = null;
      reconnectAttemptRef.current = 0;
      setStatus('idle');
      setPresence([]);
    };
  }, [sheetId]);

  return { status, presence, lastSeq, subscribe };
}
