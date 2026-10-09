/**
 * Holds: placing, releasing, listing and telling QA (decision C-005;
 * C-071..C-082; migration 0139).
 *
 * The rule is pure and lives in shared/holds.ts. "Is this document on hold
 * right now" is functions/lib/hold-state.ts, read by the sharing-rule loader so
 * every exit sees it. This file is everything that WRITES a hold.
 *
 * APPEND-ONLY. A hold is inserted, and later its three release columns are
 * stamped once. There is no update of anything else and no delete, here or in
 * any route; the database refuses both for good measure (0139's trigger).
 *
 * WHO
 *   place     any login but a read-only one, and an API key (C-072): a hold
 *             only ever tightens.
 *   release   a QA releaser (`canReleaseQa`, the sharing rule's own ladder) or
 *             an administrator, signed in, WITH A WRITTEN REASON. Never an API
 *             key, never a read-only account.
 *
 * A HOLD IS RELEASED HERE AND NOWHERE ELSE. Sending a held document does not
 * release it, a QA release of an order line does not release it, replacing the
 * file does not release it.
 */

import { generateId, logAudit } from './db';
import { sendEmail, buildHoldPlacedEmail } from './email';
import { resolveAlertRouting, resolveTenantAdmins } from './alert-routing';
import { canReleaseQa, QA_RELEASE_OWNER_LABEL } from './sharing-rule';
import { heldLotOf, holdBrief, loadEffectiveHolds, lotHoldCovers } from './hold-state';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './permissions';
import {
  HOLD_SOURCE_LABELS,
  automaticHoldsForResults,
  cleanHoldReason,
  holdLotLabel,
  holdSourceKey,
  isHoldSource,
  type AutomaticHoldProposal,
  type HoldJudgedResult,
  type HoldSource,
} from '../../shared/holds';
import { registerIdentity } from '../../shared/specSnapshot';
import type { SpecVerdict } from '../../shared/specCheck';
import type {
  ApiDocumentHold,
  ApiHoldFailure,
  HoldRetryResponse,
  DocumentHoldBrief,
  DocumentHoldLot,
  DocumentHoldState,
  DocumentHoldsResponse,
} from '../../shared/types';
import type { User } from './types';

type Actor = Pick<User, 'id' | 'role' | 'tenant_id'>;

/** May this caller place a hold? Anybody who may edit a document. */
export function canPlaceHold(user: Pick<User, 'role' | 'tenant_id'>, tenantId: string): boolean {
  if (user.role === 'super_admin') return true;
  return user.tenant_id === tenantId && user.role !== 'reader';
}

/** May this caller release one? A QA releaser or an administrator, signed in. */
export async function canReleaseHold(
  db: D1Database,
  data: Record<string, unknown>,
  user: Actor,
  tenantId: string,
): Promise<boolean> {
  if (data.authMethod === 'api_key') return false;
  return canReleaseQa(db, user, tenantId);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface HoldRow {
  id: string;
  tenant_id: string;
  document_id: string;
  lot_id: string | null;
  reason: string;
  source: HoldSource;
  source_key: string | null;
  spec_check_id: string | null;
  document_version: number | null;
  detail: string | null;
  placed_by: string | null;
  placed_at: string;
  qa_notified_at: string | null;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  lot_number: string | null;
  sub_lot_code: string | null;
  document_title: string | null;
  document_type_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  placed_by_name: string | null;
  released_by_name: string | null;
  product_names: string | null;
}

/**
 * THE SUPPLIER COMES THROUGH THE DOCUMENT, never from a column on the hold
 * (0139): after a supplier merge the hold reads the surviving supplier with
 * nothing to move. Every join is tenant scoped.
 */
const HOLD_SELECT = `
  SELECT h.*,
         l.lot_number, l.sub_lot_code,
         d.title AS document_title,
         dt.name AS document_type_name,
         d.supplier_id AS supplier_id,
         s.name AS supplier_name,
         up.name AS placed_by_name,
         ur.name AS released_by_name,
         (SELECT group_concat(p.name, ' | ')
            FROM document_products dp
            JOIN products p ON p.id = dp.product_id
           WHERE dp.document_id = h.document_id) AS product_names
    FROM document_holds h
    JOIN documents d ON d.id = h.document_id AND d.tenant_id = h.tenant_id
    LEFT JOIN document_types dt ON dt.id = d.document_type_id AND dt.tenant_id = d.tenant_id
    LEFT JOIN suppliers s ON s.id = d.supplier_id AND s.tenant_id = d.tenant_id
    LEFT JOIN lots l ON l.id = h.lot_id
    LEFT JOIN users up ON up.id = h.placed_by
    LEFT JOIN users ur ON ur.id = h.released_by`;

function parseDetail(raw: string | null): ApiDocumentHold['detail'] {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      test: str(d.test) ?? '',
      value: str(d.value),
      unit: str(d.unit),
      limit: str(d.limit),
      location: str(d.location),
      why: str(d.why),
    };
  } catch {
    return null;
  }
}

function toApi(r: HoldRow): ApiDocumentHold {
  return {
    ...holdBrief(r),
    document_title: r.document_title,
    document_type_name: r.document_type_name,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    product_names: (r.product_names ?? '')
      .split(' | ')
      .map((n) => n.trim())
      .filter((n, i, all) => n && all.indexOf(n) === i),
    document_version: r.document_version,
    detail: parseDetail(r.detail),
    placed_by: r.placed_by,
    placed_by_name: r.placed_by_name,
    active: r.released_at === null,
    released_by: r.released_by,
    released_by_name: r.released_by_name,
    released_at: r.released_at,
    release_reason: r.release_reason,
  };
}

async function loadHold(db: D1Database, tenantId: string, holdId: string): Promise<HoldRow | null> {
  return db
    .prepare(`${HOLD_SELECT} WHERE h.id = ? AND h.tenant_id = ?`)
    .bind(holdId, tenantId)
    .first<HoldRow>();
}

/**
 * The certificate's lot rows, each with the active hold on it, if any. A lot
 * hold is on the lot ROW (C-086), so the hold shown may have been placed from
 * another certificate of the same lot.
 */
async function loadDocumentLots(
  db: D1Database,
  tenantId: string,
  documentId: string,
  active: DocumentHoldBrief[],
): Promise<DocumentHoldLot[]> {
  const res = await db
    .prepare(
      `SELECT l.id AS lot_id, l.lot_number, l.sub_lot_code
         FROM document_lots dl
         JOIN lots l ON l.id = dl.lot_id AND l.tenant_id = ?
        WHERE dl.document_id = ?
        ORDER BY l.lot_number ASC, l.sub_lot_code ASC`,
    )
    .bind(tenantId, documentId)
    .all<{ lot_id: string; lot_number: string; sub_lot_code: string | null }>();
  return (res.results ?? []).map((l) => {
    const hold = active.find((h) => h.lot_id === l.lot_id || h.own_lot_id === l.lot_id) ?? null;
    return {
      lot_id: l.lot_id,
      lot_number: l.lot_number,
      sub_lot_code: l.sub_lot_code || null,
      lot_label: holdLotLabel(l) ?? l.lot_number,
      hold: hold
        ? { id: hold.id, document_id: hold.document_id, document_title: hold.document_title ?? null, lot_id: hold.lot_id, lot_label: hold.lot_label, reason: hold.reason, source: hold.source, placed_at: hold.placed_at }
        : null,
    };
  });
}

/** Does this document exist in this organization (and is it not deleted)? */
async function loadDocument(
  db: D1Database,
  tenantId: string,
  documentId: string,
): Promise<{ id: string; title: string; status: string; current_version: number; supplier_id: string | null; document_type_id: string | null } | null> {
  return db
    .prepare(
      `SELECT id, title, status, current_version, supplier_id, document_type_id
         FROM documents WHERE id = ? AND tenant_id = ?`,
    )
    .bind(documentId, tenantId)
    .first();
}

/**
 * Everything about one document's holds. Null when the document is not this
 * organization's (the route answers 404).
 */
export async function describeDocumentHolds(
  db: D1Database,
  data: Record<string, unknown>,
  user: Actor,
  tenantId: string,
  documentId: string,
): Promise<DocumentHoldsResponse | null> {
  const doc = await loadDocument(db, tenantId, documentId);
  if (!doc) return null;
  const res = await db
    .prepare(`${HOLD_SELECT} WHERE h.document_id = ? AND h.tenant_id = ? ORDER BY h.placed_at ASC, h.rowid ASC`)
    .bind(documentId, tenantId)
    .all<HoldRow>();
  const all = (res.results ?? []).map(toApi);
  const active = all.filter((h) => h.active);
  const history = all
    .filter((h) => !h.active)
    .sort((a, b) => (b.released_at ?? '').localeCompare(a.released_at ?? ''));
  const effective = (await loadEffectiveHolds(db, tenantId, [documentId])).get(documentId) ?? [];
  return {
    active,
    history,
    also_held_by: effective.filter((h) => h.document_id !== documentId),
    failures: await listOpenHoldFailures(db, tenantId, { documentId }),
    lots: await loadDocumentLots(db, tenantId, documentId, effective),
    can_place: canPlaceHold(user, tenantId),
    can_release: await canReleaseHold(db, data, user, tenantId),
  };
}

/** The summary `GET /api/documents/:id` carries. */
export async function documentHoldState(
  db: D1Database,
  data: Record<string, unknown>,
  user: Actor,
  tenantId: string,
  documentId: string,
): Promise<DocumentHoldState> {
  const effective = (await loadEffectiveHolds(db, tenantId, [documentId])).get(documentId) ?? [];
  return {
    active: effective,
    can_place: canPlaceHold(user, tenantId),
    can_release: await canReleaseHold(db, data, user, tenantId),
  };
}

export const HOLDS_LIST_MAX = 200;

export interface HoldsFilter {
  state: 'active' | 'released' | 'all';
  source?: HoldSource | null;
  supplierId?: string | null;
  productId?: string | null;
}

export function parseHoldsFilter(params: URLSearchParams): HoldsFilter {
  const state = params.get('state');
  const source = params.get('source');
  if (state && !['active', 'released', 'all'].includes(state)) {
    throw new BadRequestError('state must be active, released or all');
  }
  if (source && !isHoldSource(source)) {
    throw new BadRequestError('source must be person, spec_critical or zero_tolerance');
  }
  return {
    state: (state as HoldsFilter['state']) || 'active',
    source: source ? (source as HoldSource) : null,
    supplierId: params.get('supplier_id') || null,
    productId: params.get('product_id') || null,
  };
}

function filterSql(filter: HoldsFilter): { where: string; binds: string[] } {
  const where: string[] = [];
  const binds: string[] = [];
  if (filter.state === 'active') where.push('h.released_at IS NULL');
  if (filter.state === 'released') where.push('h.released_at IS NOT NULL');
  if (filter.source) {
    where.push('h.source = ?');
    binds.push(filter.source);
  }
  if (filter.supplierId) {
    where.push('d.supplier_id = ?');
    binds.push(filter.supplierId);
  }
  if (filter.productId) {
    // The certificate is linked to the product, or the held lot row is that
    // product's.
    where.push(
      `(EXISTS (SELECT 1 FROM document_products dp WHERE dp.document_id = h.document_id AND dp.product_id = ?)
        OR l.product_id = ?)`,
    );
    binds.push(filter.productId, filter.productId);
  }
  return { where: where.length ? ` AND ${where.join(' AND ')}` : '', binds };
}

/** The organization's holds: active oldest first, released newest first. */
export async function listHolds(
  db: D1Database,
  tenantId: string,
  filter: HoldsFilter,
): Promise<{ holds: ApiDocumentHold[]; total: number; truncated: boolean }> {
  const { where, binds } = filterSql(filter);
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM document_holds h
         JOIN documents d ON d.id = h.document_id AND d.tenant_id = h.tenant_id
         LEFT JOIN lots l ON l.id = h.lot_id
        WHERE h.tenant_id = ?${where}`,
    )
    .bind(tenantId, ...binds)
    .first<{ n: number }>();
  const res = await db
    .prepare(
      `${HOLD_SELECT}
        WHERE h.tenant_id = ?${where}
        ORDER BY (h.released_at IS NOT NULL) ASC,
                 CASE WHEN h.released_at IS NULL THEN h.placed_at END ASC,
                 h.released_at DESC, h.rowid ASC
        LIMIT ${HOLDS_LIST_MAX}`,
    )
    .bind(tenantId, ...binds)
    .all<HoldRow>();
  const holds = (res.results ?? []).map(toApi);
  const n = Number(total?.n) || 0;
  return { holds, total: n, truncated: n > holds.length };
}

/** ONE COUNT, no joins: what the navigation asks on a timer. */
export async function countActiveHolds(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM document_holds WHERE tenant_id = ? AND released_at IS NULL')
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

// ---------------------------------------------------------------------------
// Telling QA
// ---------------------------------------------------------------------------

interface NoticeContext {
  tenantId: string;
  documentId: string;
  documentTitle: string;
  supplierId: string | null;
  documentTypeId: string | null;
  /** Who placed it, for the email; null when the portal did. */
  placedByName: string | null;
  actorUserId: string | null;
  appUrl?: string;
  /** What is being said. Default `placed`. See `buildHoldPlacedEmail`. */
  kind?: 'placed' | 'arrived' | 'failed';
  /** The `document_hold_failures` row to stamp, for `failed`. */
  failureId?: string | null;
}

/**
 * ONE notice per act (a person's hold, or everything an approval placed on one
 * document), to the `QA` owner route with NO admin fallback -- the pattern
 * expired-on-arrival uses. Nobody on the route is a ROUTING GAP: an audit row,
 * and a notice to the administrators that says nobody was told.
 *
 * Never throws. The hold stands whether or not anybody could be mailed.
 */
async function notifyQaOfHolds(
  db: D1Database,
  apiKey: string | undefined,
  ctx: NoticeContext,
  holds: Array<{ id: string; lot_label: string | null; reason: string; source: HoldSource; from_title?: string | null }>,
): Promise<{ via: string; notified: string[] }> {
  const kind = ctx.kind ?? 'placed';
  const gapAction =
    kind === 'failed'
      ? 'document.hold_place_failed.routing_gap'
      : kind === 'arrived'
        ? 'document.held_lot_certificate_arrived.routing_gap'
        : 'document.hold_placed.routing_gap';
  const result = { via: 'not_sent', notified: [] as string[] };
  if (holds.length === 0) return result;
  try {
    const [tenant, supplier] = await Promise.all([
      db.prepare('SELECT name FROM tenants WHERE id = ?').bind(ctx.tenantId).first<{ name: string }>(),
      ctx.supplierId
        ? db
            .prepare('SELECT name FROM suppliers WHERE id = ? AND tenant_id = ?')
            .bind(ctx.supplierId, ctx.tenantId)
            .first<{ name: string }>()
        : Promise.resolve(null),
    ]);
    const routing = await resolveAlertRouting(db, {
      tenantId: ctx.tenantId,
      ownerLabel: QA_RELEASE_OWNER_LABEL,
      supplierId: ctx.supplierId,
      documentTypeId: ctx.documentTypeId,
      adminFallback: false,
    });
    const emailArgs = {
      tenantName: tenant?.name ?? '',
      documentId: ctx.documentId,
      documentTitle: ctx.documentTitle,
      supplierName: supplier?.name ?? null,
      placedByName: ctx.placedByName,
      holds: holds.map((h) => ({ lot_label: h.lot_label, reason: h.reason, source_label: HOLD_SOURCE_LABELS[h.source], from_title: h.from_title ?? null })),
      appUrl: ctx.appUrl,
      kind,
    };
    const stampFailure = async () => {
      if (kind === 'failed' && ctx.failureId) {
        await db
          .prepare(`UPDATE document_hold_failures SET qa_notified_at = datetime('now') WHERE id = ? AND qa_notified_at IS NULL`)
          .bind(ctx.failureId)
          .run();
      }
    };

    let to: string[];
    if (routing.recipients.length === 0) {
      result.via = 'unrouted';
      await logAudit(
        db,
        ctx.actorUserId,
        ctx.tenantId,
        gapAction,
        'document',
        ctx.documentId,
        JSON.stringify({ owner_label: QA_RELEASE_OWNER_LABEL, hold_ids: holds.map((h) => h.id) }),
        null,
      );
      if (!apiKey) return result;
      const admins = await resolveTenantAdmins(db, ctx.tenantId);
      if (admins.length === 0) return result;
      to = admins.map((a) => a.email);
      const { subject, html } = buildHoldPlacedEmail({ ...emailArgs, routingGap: true });
      if (!(await sendEmail(apiKey, { to, subject, html }))) return result;
      // A failed hold is not a routine notice: whoever heard, somebody did.
      await stampFailure();
    } else {
      result.via = routing.via;
      if (!apiKey) return result;
      to = routing.recipients.map((r) => r.email);
      const { subject, html } = buildHoldPlacedEmail(emailArgs);
      if (!(await sendEmail(apiKey, { to, subject, html }))) return result;
      // Stamped only when the QA route itself was mailed: a routing-gap notice
      // to administrators is not "QA was told". Only for a hold that was just
      // PLACED: an arrival notice is about somebody else's hold, and a failed
      // one has no hold row.
      if (kind === 'placed') {
        await db.batch(
          holds.map((h) =>
            db
              .prepare(`UPDATE document_holds SET qa_notified_at = datetime('now') WHERE id = ? AND qa_notified_at IS NULL`)
              .bind(h.id),
          ),
        );
      }
      await stampFailure();
    }
    result.notified = to;
    return result;
  } catch (err) {
    console.error('[holds] notifying QA failed:', err instanceof Error ? err.message : String(err));
    return result;
  }
}

// ---------------------------------------------------------------------------
// A person places a hold
// ---------------------------------------------------------------------------

export interface PlaceHoldArgs {
  tenantId: string;
  documentId: string;
  lotId?: unknown;
  reason: unknown;
  user: Actor & { name?: string | null; email?: string | null };
  /** `context.data` -- how the request authenticated. */
  data: Record<string, unknown>;
  clientIp: string | null;
  apiKey?: string;
  appUrl?: string;
}

export async function placeHold(db: D1Database, args: PlaceHoldArgs): Promise<ApiDocumentHold> {
  const { tenantId, documentId, user } = args;
  if (!canPlaceHold(user, tenantId)) {
    throw new ForbiddenError('A read-only account cannot place a hold.');
  }
  // 404 before anything else: another organization's document must not be
  // told apart from one that does not exist.
  const doc = await loadDocument(db, tenantId, documentId);
  if (!doc || doc.status === 'deleted') throw new NotFoundError('Document not found');

  const reason = cleanHoldReason(args.reason);
  if (!reason) throw new BadRequestError('Say why this certificate is being put on hold.');

  let lotId: string | null = null;
  if (args.lotId !== undefined && args.lotId !== null && args.lotId !== '') {
    if (typeof args.lotId !== 'string') throw new BadRequestError('lot_id must be a lot row of this certificate');
    const lot = await db
      .prepare(
        `SELECT l.id FROM document_lots dl
           JOIN lots l ON l.id = dl.lot_id AND l.tenant_id = ?
          WHERE dl.document_id = ? AND dl.lot_id = ?`,
      )
      .bind(tenantId, documentId, args.lotId)
      .first<{ id: string }>();
    if (!lot) throw new BadRequestError('That lot is not a lot row of this certificate.');
    lotId = lot.id;
    // A LOT HOLD IS ON THE LOT (C-086, C-091): it covers every certificate of
    // that lot -- same supplier, same lot key, same sublot, whatever product a
    // row resolved to -- so the lot is held once, whichever certificate and
    // row it was placed from. A second person's hold on it is refused, not
    // stacked: releasing is one act on one hold.
    const mine = await db
      .prepare('SELECT lot_key, sub_lot_code, supplier_id FROM lots WHERE id = ? AND tenant_id = ?')
      .bind(lotId, tenantId)
      .first<{ lot_key: string | null; sub_lot_code: string | null; supplier_id: string | null }>();
    const link = {
      lot_id: lotId,
      lot_key: mine?.lot_key ?? null,
      sub_lot_code: mine?.sub_lot_code ?? null,
      lot_supplier_id: mine?.supplier_id ?? null,
      document_id: documentId,
      document_supplier_id: doc.supplier_id,
    };
    const others = await db
      .prepare(
        `SELECT h.id, h.lot_id, d.title, d.supplier_id AS document_supplier_id,
                l.lot_key, l.sub_lot_code, l.supplier_id AS lot_supplier_id
           FROM document_holds h
           JOIN documents d ON d.id = h.document_id AND d.tenant_id = h.tenant_id
           JOIN lots l ON l.id = h.lot_id AND l.tenant_id = h.tenant_id
          WHERE h.tenant_id = ? AND h.source = 'person' AND h.released_at IS NULL
            AND (h.lot_id = ? OR l.lot_key = ?)`,
      )
      .bind(tenantId, lotId, mine?.lot_key ?? '')
      .all<{ id: string; lot_id: string; title: string | null; document_supplier_id: string | null; lot_key: string | null; sub_lot_code: string | null; lot_supplier_id: string | null }>();
    const already = (others.results ?? []).find((h) => lotHoldCovers(heldLotOf(h), link));
    if (already) {
      throw new ConflictError(
        `That lot is already on hold, from ${already.title || 'another certificate'}. The hold covers every certificate of the lot. Release the hold that is there before placing another.`,
      );
    }
  }

  const id = generateId();
  try {
    await db
      .prepare(
        `INSERT INTO document_holds
           (id, tenant_id, document_id, lot_id, reason, source, document_version, placed_by)
         VALUES (?, ?, ?, ?, ?, 'person', ?, ?)`,
      )
      .bind(id, tenantId, documentId, lotId, reason, Number(doc.current_version) || 1, user.id)
      .run();
  } catch (err) {
    // The one-active-hold index (0139): somebody already holds this lot row.
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      throw new ConflictError(
        lotId
          ? 'That lot is already on hold. Release the hold that is there before placing another.'
          : 'This certificate is already on hold. Release the hold that is there before placing another.',
      );
    }
    throw err;
  }

  const row = (await loadHold(db, tenantId, id)) as HoldRow;
  const api = toApi(row);
  const viaKey = args.data.authMethod === 'api_key';
  await logAudit(
    db,
    user.id,
    tenantId,
    'document.hold_placed',
    'document',
    documentId,
    JSON.stringify({
      hold_id: id,
      source: 'person',
      lot_id: lotId,
      lot_label: api.lot_label,
      reason,
      document_version: row.document_version,
      via: viaKey ? 'api_key' : 'portal',
      api_key_id: viaKey && typeof args.data.apiKeyId === 'string' ? args.data.apiKeyId : null,
    }),
    args.clientIp,
  );

  // QA hears about it unless QA did it. A key is never QA.
  const placerIsQa = !viaKey && (await canReleaseQa(db, user, tenantId));
  if (!placerIsQa) {
    await notifyQaOfHolds(
      db,
      args.apiKey,
      {
        tenantId,
        documentId,
        documentTitle: doc.title,
        supplierId: doc.supplier_id,
        documentTypeId: doc.document_type_id,
        placedByName: user.name || user.email || 'Somebody',
        actorUserId: user.id,
        appUrl: args.appUrl,
      },
      [{ id, lot_label: api.lot_label, reason, source: 'person' }],
    );
  }
  return api;
}

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

export interface ReleaseHoldArgs {
  tenantId: string;
  holdId: string;
  reason: unknown;
  user: Actor;
  data: Record<string, unknown>;
  clientIp: string | null;
}

export async function releaseHold(db: D1Database, args: ReleaseHoldArgs): Promise<ApiDocumentHold> {
  const { tenantId, holdId, user } = args;
  // 404 first, for the same reason as placing.
  const row = await loadHold(db, tenantId, holdId);
  if (!row) throw new NotFoundError('Hold not found');

  if (args.data.authMethod === 'api_key') {
    throw new ForbiddenError('An API key cannot release a hold. QA or an administrator does that, signed in.');
  }
  if (!(await canReleaseQa(db, user, tenantId))) {
    throw new ForbiddenError('Only QA or an administrator can release a hold.');
  }
  const reason = cleanHoldReason(args.reason);
  if (!reason) throw new BadRequestError('Say why this hold is being released.');
  if (row.released_at) throw new ConflictError('This hold has already been released.');

  // Stamped once. `released_at IS NULL` in the WHERE is what makes two people
  // pressing Release at the same moment one release and one "already released".
  const res = await db
    .prepare(
      `UPDATE document_holds
          SET released_by = ?, released_at = datetime('now'), release_reason = ?
        WHERE id = ? AND tenant_id = ? AND released_at IS NULL`,
    )
    .bind(user.id, reason, holdId, tenantId)
    .run();
  if (!res.meta?.changes) throw new ConflictError('This hold has already been released.');

  const after = toApi((await loadHold(db, tenantId, holdId)) as HoldRow);
  await logAudit(
    db,
    user.id,
    tenantId,
    'document.hold_released',
    'document',
    row.document_id,
    JSON.stringify({
      hold_id: holdId,
      source: row.source,
      lot_id: row.lot_id,
      lot_label: after.lot_label,
      hold_reason: row.reason,
      release_reason: reason,
      placed_by: row.placed_by,
      placed_at: row.placed_at,
    }),
    args.clientIp,
  );
  return after;
}

// ---------------------------------------------------------------------------
// Automatic holds, at approval-time judgement only
// ---------------------------------------------------------------------------

/** One live verdict, reduced to what the hold rule reads. */
export function holdResultFromVerdict(v: SpecVerdict): HoldJudgedResult {
  const identity = registerIdentity(v);
  return {
    verdict: v.verdict,
    source: v.source,
    criticality: v.criticality ?? null,
    not_checked_category: v.not_checked_category ?? null,
    // The analyte's category rides on the band `attachSpecBands` computed from
    // `spec_tests.category`. A zero-tolerance analyte always gets one on a
    // could-not-check, so its absence means the analyte is not zero-tolerance
    // (or has no category), and nothing holds.
    analyte_category: v.band?.category ?? null,
    result_key: identity.result_key,
    result_location: identity.result_location,
    test_name_raw: v.test_name_raw,
    value_raw: v.value_raw,
    unit_raw: v.unit_raw,
    limit_text: v.limit_text,
    reason: v.reason,
  };
}

export interface AutomaticHoldContext {
  tenantId: string;
  documentId: string;
  documentTitle: string;
  versionNumber: number;
  supplierId: string | null;
  documentTypeId: string | null;
  queueItemId: string | null;
  /** The reviewer whose approval produced these verdicts. Not the placer. */
  approvedBy: string | null;
  appUrl?: string;
}

/**
 * The lot row an automatic hold goes on: the document's ONE lot row. A
 * records-mode certificate is cut into one document per lot, so this is the
 * lot the judged results belong to. A document with no lot row, or with
 * several (an unsplit multi-lot file), is held WHOLE -- nothing here guesses
 * which row of the file a result belongs to.
 */
async function singleLotOf(db: D1Database, tenantId: string, documentId: string): Promise<string | null> {
  const res = await db
    .prepare(
      `SELECT l.id FROM document_lots dl
         JOIN lots l ON l.id = dl.lot_id AND l.tenant_id = ?
        WHERE dl.document_id = ? LIMIT 2`,
    )
    .bind(tenantId, documentId)
    .all<{ id: string }>();
  const rows = res.results ?? [];
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Write the holds a set of proposals asks for. ONCE PER JUDGED RESULT, EVER:
 * `INSERT OR IGNORE` against 0139's `idx_document_holds_auto_once`, so a
 * re-approval of the same version places nothing new -- including when QA has
 * already released the first one.
 */
export async function writeAutomaticHolds(
  db: D1Database,
  ctx: Pick<AutomaticHoldContext, 'tenantId' | 'documentId' | 'versionNumber' | 'queueItemId' | 'approvedBy'>,
  proposals: AutomaticHoldProposal[],
  specCheckIds: Map<string, string> = new Map(),
  opts: { keepFailuresOpen?: boolean } = {},
): Promise<Array<{ id: string; lot_id: string | null; lot_label: string | null; reason: string; source: HoldSource }>> {
  if (proposals.length === 0) return [];
  const lotId = await singleLotOf(db, ctx.tenantId, ctx.documentId);
  const lot = lotId
    ? await db.prepare('SELECT lot_number, sub_lot_code FROM lots WHERE id = ?').bind(lotId).first<{ lot_number: string; sub_lot_code: string | null }>()
    : null;
  const placed: Array<{ id: string; lot_id: string | null; lot_label: string | null; reason: string; source: HoldSource }> = [];
  for (const p of proposals) {
    const id = generateId();
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO document_holds
           (id, tenant_id, document_id, lot_id, reason, source, source_key, spec_check_id,
            document_version, detail, placed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        ctx.tenantId,
        ctx.documentId,
        lotId,
        p.reason,
        p.source,
        p.source_key,
        specCheckIds.get(p.source_key) ?? null,
        ctx.versionNumber,
        JSON.stringify(p.detail),
      )
      .run();
    if (!res.meta?.changes) continue;
    const lotLabel = lot ? holdLotLabel(lot) : null;
    placed.push({ id, lot_id: lotId, lot_label: lotLabel, reason: p.reason, source: p.source });
    await logAudit(
      db,
      // No person placed it. Who approved the certificate is in the details.
      null,
      ctx.tenantId,
      'document.hold_placed',
      'document',
      ctx.documentId,
      JSON.stringify({
        hold_id: id,
        source: p.source,
        source_key: p.source_key,
        lot_id: lotId,
        lot_label: lotLabel,
        reason: p.reason,
        document_version: ctx.versionNumber,
        via: 'approval',
        approved_by: ctx.approvedBy,
        queue_item_id: ctx.queueItemId,
        result: p.detail,
      }),
      null,
    );
  }
  // A failure recorded for these holds is over once they exist (C-092). The
  // retry closes its own row, with who retried.
  if (!opts.keepFailuresOpen) await closeSatisfiedHoldFailures(db, ctx.tenantId, { documentId: ctx.documentId });
  return placed;
}

/**
 * AT APPROVAL: place the holds this document's freshly written verdicts call
 * for, and tell QA once. Called by `registerAndNotifyForApproval`, the
 * approval-time register writer, and by nothing else -- the bulk recheck is a
 * Node script that never reaches this module.
 *
 * Best-effort like everything around it: the approval has happened. A failure
 * is logged and audited, and bin/propose-spec-holds finds what was missed.
 */
export async function placeAutomaticHolds(
  db: D1Database,
  apiKey: string | undefined,
  ctx: AutomaticHoldContext,
  verdicts: SpecVerdict[],
  opts: { unattributedNote?: string | null; unattributedVerdicts?: readonly SpecVerdict[] } = {},
): Promise<{ placed: number; failed: boolean }> {
  // PURE, and outside the try: whatever goes wrong below, what SHOULD have
  // been placed is known, and can be written down and mailed.
  let proposals: AutomaticHoldProposal[] = [];
  try {
    proposals = automaticHoldsForResults(verdicts.map(holdResultFromVerdict), {
      origin: 'approval',
      version: ctx.versionNumber,
    });
  } catch (err) {
    console.error('[holds] deciding automatic holds failed:', err instanceof Error ? err.message : String(err));
    return { placed: 0, failed: true };
  }
  if (proposals.length === 0) return { placed: 0, failed: false };
  if (opts.unattributedNote) {
    // The result could not be attributed to one of the documents approved from
    // the file, so each of them is held (C-089). The hold says so.
    const keys = opts.unattributedVerdicts
      ? new Set(opts.unattributedVerdicts.map((v) => holdSourceKey(ctx.versionNumber, v.source, registerIdentity(v).result_key)))
      : null;
    proposals = proposals.map((p) =>
      keys && !keys.has(p.source_key)
        ? p
        : { ...p, detail: { ...p.detail, location: [p.detail.location, opts.unattributedNote].filter(Boolean).join(' ') } },
    );
  }
  try {
    // The register rows these verdicts were just written as, by identity.
    const specCheckIds = new Map<string, string>();
    try {
      const rows = await db
        .prepare(
          `SELECT id, source, result_key FROM document_spec_checks
            WHERE document_id = ? AND version_number = ? AND result_key IS NOT NULL`,
        )
        .bind(ctx.documentId, ctx.versionNumber)
        .all<{ id: string; source: 'printed' | 'limit'; result_key: string }>();
      for (const r of rows.results ?? []) {
        specCheckIds.set(`v${ctx.versionNumber}:${r.source}:${r.result_key}`, r.id);
      }
    } catch {
      // A bare pointer for a reader's convenience; the hold does not need it.
    }

    const placed = await writeAutomaticHolds(db, ctx, proposals, specCheckIds);
    if (placed.length === 0) return { placed: 0, failed: false };
    await notifyQaOfHolds(
      db,
      apiKey,
      {
        tenantId: ctx.tenantId,
        documentId: ctx.documentId,
        documentTitle: ctx.documentTitle,
        supplierId: ctx.supplierId,
        documentTypeId: ctx.documentTypeId,
        placedByName: null,
        actorUserId: ctx.approvedBy,
        appUrl: ctx.appUrl,
      },
      placed,
    );
    return { placed: placed.length, failed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[holds] placing automatic holds failed:', message);
    // NOT QUIET (C-087): written down, shown, and mailed.
    await recordHoldFailure(db, apiKey, ctx, proposals, message);
    return { placed: 0, failed: true };
  }
}

// ---------------------------------------------------------------------------
// A certificate that arrives for a lot already on hold (C-086)
// ---------------------------------------------------------------------------

/**
 * A hold on a lot row covers every certificate of that lot, including one
 * approved AFTER the hold was placed: it is held from the moment it is linked
 * to the lot row (`loadEffectiveHolds`), with nothing to write. What this does
 * is TELL QA, once per certificate and hold, that a new certificate arrived
 * for a lot they are holding -- because that is usually the corrected
 * certificate they are waiting for.
 *
 * "Once" is the audit row `document.held_lot_certificate_arrived`, checked
 * before anything is sent. Never throws: the approval stands, and the
 * certificate is held whether or not anybody could be told.
 */
export async function noticeCertificatesForHeldLots(
  db: D1Database,
  apiKey: string | undefined,
  ctx: { tenantId: string; actorUserId: string | null; appUrl?: string },
  documentIds: string[],
): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const ids = [...new Set(documentIds.filter(Boolean))];
    if (ids.length === 0) return { notified };
    const effective = await loadEffectiveHolds(db, ctx.tenantId, ids);
    for (const id of ids) {
      // Only a hold that reaches this certificate THROUGH ITS LOT ROW, placed
      // from another certificate. One on a neighbour's page is not an arrival.
      // Only a hold that reaches this certificate AS A CERTIFICATE OF THE HELD
      // LOT, placed from another certificate. One on a neighbour's page is not
      // an arrival.
      const candidates = (effective.get(id) ?? []).filter((h) => h.document_id !== id && h.reach === 'lot');
      if (candidates.length === 0) continue;
      const told = await db
        .prepare(
          `SELECT details FROM audit_log
            WHERE tenant_id = ? AND action = 'document.held_lot_certificate_arrived' AND resource_id = ?`,
        )
        .bind(ctx.tenantId, id)
        .all<{ details: string | null }>();
      const toldIds = new Set<string>();
      for (const r of told.results ?? []) {
        try {
          for (const h of (JSON.parse(r.details ?? '{}').hold_ids ?? []) as string[]) toldIds.add(h);
        } catch {
          // An unreadable row told nobody anything.
        }
      }
      const fresh = candidates.filter((h) => !toldIds.has(h.id));
      if (fresh.length === 0) continue;
      const doc = await loadDocument(db, ctx.tenantId, id);
      if (!doc) continue;
      await logAudit(
        db,
        ctx.actorUserId,
        ctx.tenantId,
        'document.held_lot_certificate_arrived',
        'document',
        id,
        JSON.stringify({
          hold_ids: fresh.map((h) => h.id),
          lots: fresh.map((h) => ({ lot_id: h.lot_id, lot_label: h.lot_label, held_from_document_id: h.document_id })),
          note: 'Approved for a lot that is already on hold. Held from the moment it was linked to the lot.',
        }),
        null,
      );
      await notifyQaOfHolds(
        db,
        apiKey,
        {
          tenantId: ctx.tenantId,
          documentId: id,
          documentTitle: doc.title,
          supplierId: doc.supplier_id,
          documentTypeId: doc.document_type_id,
          placedByName: null,
          actorUserId: ctx.actorUserId,
          appUrl: ctx.appUrl,
          kind: 'arrived',
        },
        fresh.map((h) => ({ id: h.id, lot_label: h.lot_label, reason: h.reason, source: h.source, from_title: h.document_title ?? null })),
      );
      notified++;
    }
  } catch (err) {
    console.error('[holds] held-lot arrival notice failed:', err instanceof Error ? err.message : String(err));
  }
  return { notified };
}

// ---------------------------------------------------------------------------
// A hold that should have been placed and was not (C-087)
// ---------------------------------------------------------------------------

function parseProposals(raw: string | null): AutomaticHoldProposal[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? (v as AutomaticHoldProposal[]).filter((p) => p && isHoldSource(p.source) && typeof p.source_key === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Write down that an automatic hold could not be placed, and TELL SOMEBODY.
 * The approval has happened and cannot be undone from here; what must not
 * happen is that a certificate with a Critical failure sits unheld and nobody
 * knows.
 *
 *   1. a `document_hold_failures` row carrying the proposals, so the document
 *      page and the Holds page show it and Retry places exactly those holds;
 *   2. a `document.hold_place_failed` audit row;
 *   3. a mail to the QA route -- or, with nobody on it, to the administrators
 *      (audited as a routing gap), like every other QA notice.
 *
 * Each step is tried on its own: if the database is what failed, the mail may
 * be the only thing that gets through, and bin/propose-spec-holds still finds
 * the certificate from its register rows.
 */
export async function recordHoldFailure(
  db: D1Database,
  apiKey: string | undefined,
  ctx: AutomaticHoldContext,
  proposals: AutomaticHoldProposal[],
  error: string,
): Promise<void> {
  if (proposals.length === 0) return;
  // ONE OPEN FAILURE PER (document, version) (C-092, `idx_document_hold_failures_one_open`).
  // An approval that fails again for the same version adds what it would have
  // placed to the row that is already open; it does not open a second, and QA,
  // who were mailed when the first opened, are not mailed again.
  let failureId: string | null = generateId();
  let alreadyOpen = false;
  try {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO document_hold_failures
           (id, tenant_id, document_id, document_version, proposals, error, queue_item_id, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(failureId, ctx.tenantId, ctx.documentId, ctx.versionNumber, JSON.stringify(proposals), error.slice(0, 500), ctx.queueItemId, ctx.approvedBy)
      .run();
    if (!res.meta?.changes) {
      const open = await db
        .prepare(
          `SELECT id, proposals, qa_notified_at FROM document_hold_failures
            WHERE document_id = ? AND document_version = ? AND resolved_at IS NULL`,
        )
        .bind(ctx.documentId, ctx.versionNumber)
        .first<{ id: string; proposals: string; qa_notified_at: string | null }>();
      if (open) {
        failureId = open.id;
        alreadyOpen = Boolean(open.qa_notified_at);
        const merged = parseProposals(open.proposals);
        for (const p of proposals) if (!merged.some((m) => m.source === p.source && m.source_key === p.source_key)) merged.push(p);
        await db
          .prepare('UPDATE document_hold_failures SET proposals = ?, error = ? WHERE id = ? AND resolved_at IS NULL')
          .bind(JSON.stringify(merged), error.slice(0, 500), open.id)
          .run();
      }
    }
  } catch (err) {
    failureId = null;
    console.error('[holds] recording a failed hold failed:', err instanceof Error ? err.message : String(err));
  }
  try {
    await logAudit(
      db,
      ctx.approvedBy,
      ctx.tenantId,
      'document.hold_place_failed',
      'document',
      ctx.documentId,
      JSON.stringify({
        via: 'approval',
        failure_id: failureId,
        queue_item_id: ctx.queueItemId,
        document_version: ctx.versionNumber,
        error,
        holds_not_placed: proposals.map((p) => ({ source: p.source, source_key: p.source_key, reason: p.reason })),
      }),
      null,
    );
  } catch {
    // The mail below is still attempted.
  }
  if (alreadyOpen) return;
  await notifyQaOfHolds(
    db,
    apiKey,
    {
      tenantId: ctx.tenantId,
      documentId: ctx.documentId,
      documentTitle: ctx.documentTitle,
      supplierId: ctx.supplierId,
      documentTypeId: ctx.documentTypeId,
      placedByName: null,
      actorUserId: ctx.approvedBy,
      appUrl: ctx.appUrl,
      kind: 'failed',
      failureId,
    },
    proposals.map((p) => ({ id: p.source_key, lot_label: null, reason: p.reason, source: p.source })),
  );
}

/**
 * A failure is over once EVERY hold it describes exists, placed by any path:
 * a later approval of the same version, bin/propose-spec-holds, a retry. It is
 * closed here (`resolution = 'placed_elsewhere'`, nobody named), so it stops
 * being shown and counted. A hold that exists and was since RELEASED counts:
 * it was placed, and QA released it.
 */
export async function closeSatisfiedHoldFailures(
  db: D1Database,
  tenantId: string,
  filter: { documentId?: string } = {},
): Promise<number> {
  let closed = 0;
  try {
    const open = await db
      .prepare(
        `SELECT id, document_id, proposals FROM document_hold_failures
          WHERE tenant_id = ? AND resolved_at IS NULL${filter.documentId ? ' AND document_id = ?' : ''}
          LIMIT 200`,
      )
      .bind(...(filter.documentId ? [tenantId, filter.documentId] : [tenantId]))
      .all<{ id: string; document_id: string; proposals: string }>();
    for (const f of open.results ?? []) {
      const proposals = parseProposals(f.proposals);
      if (proposals.length === 0) continue;
      const existing = await db
        .prepare(`SELECT source, source_key FROM document_holds WHERE document_id = ? AND source_key IS NOT NULL`)
        .bind(f.document_id)
        .all<{ source: string; source_key: string }>();
      const have = new Set((existing.results ?? []).map((h) => `${h.source}|${h.source_key}`));
      if (!proposals.every((p) => have.has(`${p.source}|${p.source_key}`))) continue;
      const res = await db
        .prepare(
          `UPDATE document_hold_failures
              SET resolved_at = datetime('now'), resolution = 'placed_elsewhere'
            WHERE id = ? AND resolved_at IS NULL`,
        )
        .bind(f.id)
        .run();
      if (res.meta?.changes) closed++;
    }
  } catch (err) {
    console.error('[holds] closing satisfied hold failures failed:', err instanceof Error ? err.message : String(err));
  }
  return closed;
}

/** Holds that should exist and do not, newest first. */
export async function listOpenHoldFailures(
  db: D1Database,
  tenantId: string,
  filter: { documentId?: string } = {},
): Promise<ApiHoldFailure[]> {
  await closeSatisfiedHoldFailures(db, tenantId, filter);
  const res = await db
    .prepare(
      `SELECT f.id, f.document_id, f.document_version, f.proposals, f.error, f.created_at, d.title AS document_title
         FROM document_hold_failures f
         JOIN documents d ON d.id = f.document_id AND d.tenant_id = f.tenant_id
        WHERE f.tenant_id = ? AND f.resolved_at IS NULL${filter.documentId ? ' AND f.document_id = ?' : ''}
        ORDER BY f.created_at DESC, f.rowid DESC
        LIMIT 100`,
    )
    .bind(...(filter.documentId ? [tenantId, filter.documentId] : [tenantId]))
    .all<{ id: string; document_id: string; document_version: number; proposals: string; error: string | null; created_at: string; document_title: string | null }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    document_id: r.document_id,
    document_title: r.document_title,
    document_version: r.document_version,
    created_at: r.created_at,
    error: r.error,
    holds: parseProposals(r.proposals).map((p) => ({ source: p.source, reason: p.reason })),
  }));
}

export async function countOpenHoldFailures(db: D1Database, tenantId: string): Promise<number> {
  await closeSatisfiedHoldFailures(db, tenantId);
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM document_hold_failures WHERE tenant_id = ? AND resolved_at IS NULL')
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * RETRY: place the holds a failed approval should have placed. IDEMPOTENT --
 * the same `INSERT OR IGNORE` against `idx_document_holds_auto_once` the
 * approval uses, so a hold that was placed after all (by an earlier retry, or
 * by bin/propose-spec-holds) is not placed twice.
 *
 * Anybody who may PLACE a hold may retry: it only tightens. If the write fails
 * again the failure stays open and the error is the caller's to read.
 */
export async function retryHoldFailure(
  db: D1Database,
  apiKey: string | undefined,
  args: { tenantId: string; failureId: string; user: Actor; clientIp: string | null; appUrl?: string },
): Promise<HoldRetryResponse> {
  const row = await db
    .prepare(
      `SELECT f.*, d.title AS document_title, d.supplier_id, d.document_type_id, d.status
         FROM document_hold_failures f
         JOIN documents d ON d.id = f.document_id AND d.tenant_id = f.tenant_id
        WHERE f.id = ? AND f.tenant_id = ?`,
    )
    .bind(args.failureId, args.tenantId)
    .first<{
      id: string; document_id: string; document_version: number; proposals: string; queue_item_id: string | null;
      approved_by: string | null; resolved_at: string | null; document_title: string; supplier_id: string | null; document_type_id: string | null;
    }>();
  if (!row) throw new NotFoundError('Not found');
  if (!canPlaceHold(args.user, args.tenantId)) throw new ForbiddenError('A read-only account cannot place a hold.');
  if (row.resolved_at) throw new ConflictError('This has already been retried.');

  const proposals = parseProposals(row.proposals);
  const ctx = {
    tenantId: args.tenantId,
    documentId: row.document_id,
    versionNumber: Number(row.document_version) || 1,
    queueItemId: row.queue_item_id,
    approvedBy: row.approved_by,
  };
  const placed = await writeAutomaticHolds(db, ctx, proposals, new Map(), { keepFailuresOpen: true });

  // WHAT BECAME OF THE REST, SAID TRUTHFULLY (C-092). A hold that was not
  // placed now already exists: it is either still on, or it was placed and QA
  // RELEASED it since -- and then the certificate is NOT on hold, and saying
  // "already on hold" would be false.
  const existing = await db
    .prepare(
      `SELECT h.source, h.source_key, h.reason, h.released_at, u.name AS released_by_name
         FROM document_holds h LEFT JOIN users u ON u.id = h.released_by
        WHERE h.document_id = ? AND h.tenant_id = ? AND h.source_key IS NOT NULL`,
    )
    .bind(row.document_id, args.tenantId)
    .all<{ source: string; source_key: string; reason: string; released_at: string | null; released_by_name: string | null }>();
  const byKey = new Map((existing.results ?? []).map((h) => [`${h.source}|${h.source_key}`, h]));
  const placedKeys = new Set<string>();
  // `placed` rows carry no key; anything not released and present is "on hold".
  const released: HoldRetryResponse['released'] = [];
  let alreadyHeld = 0;
  for (const p of proposals) {
    const h = byKey.get(`${p.source}|${p.source_key}`);
    if (!h) continue;
    if (h.released_at) released.push({ reason: h.reason, released_by_name: h.released_by_name, released_at: h.released_at });
    else placedKeys.add(`${p.source}|${p.source_key}`);
  }
  alreadyHeld = Math.max(0, placedKeys.size - placed.length);
  const resolution = placed.length > 0 ? 'placed' : alreadyHeld > 0 ? 'already_held' : 'released_earlier';
  const res = await db
    .prepare(
      `UPDATE document_hold_failures
          SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
        WHERE id = ? AND tenant_id = ? AND resolved_at IS NULL`,
    )
    .bind(args.user.id, resolution, row.id, args.tenantId)
    .run();
  if (!res.meta?.changes) throw new ConflictError('This has already been retried.');
  await logAudit(
    db,
    args.user.id,
    args.tenantId,
    'document.hold_place_retried',
    'document',
    row.document_id,
    JSON.stringify({ failure_id: row.id, placed: placed.map((p) => p.id), already_held: alreadyHeld, released_earlier: released, resolution }),
    args.clientIp,
  );
  await notifyQaOfHolds(
    db,
    apiKey,
    {
      tenantId: args.tenantId,
      documentId: row.document_id,
      documentTitle: row.document_title,
      supplierId: row.supplier_id,
      documentTypeId: row.document_type_id,
      placedByName: null,
      actorUserId: args.user.id,
      appUrl: args.appUrl,
    },
    placed,
  );
  const title = row.document_title || 'The certificate';
  const parts: string[] = [];
  if (placed.length > 0) parts.push(`${title} is now on hold.`);
  if (alreadyHeld > 0 && placed.length === 0) parts.push(`${title} was already on hold for that result. Nothing more was needed.`);
  for (const r of released) {
    parts.push(
      `This hold was placed and later released${r.released_by_name ? ` by ${r.released_by_name}` : ''} on ${String(r.released_at).slice(0, 10)}; nothing was placed. ${title} is not on hold for that result.`,
    );
  }
  return { placed: placed.length, already_held: alreadyHeld, released, message: parts.join(' ') || 'Nothing was placed.' };
}
