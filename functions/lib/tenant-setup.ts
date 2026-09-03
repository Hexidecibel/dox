/**
 * The setup wizard's run row — reading it, creating it, and deciding whether
 * the wizard should be offered at all.
 *
 * `tenant_setup_runs` (migration 0101) holds a POSITION, not a configuration.
 * Every screen writes its real rows through the endpoints that already own
 * them, so this file never touches `document_types`, `owner_routes` or anything
 * else a screen configures — it only records which screen somebody was on.
 */

import { generateId } from './db';
import { TENANT_SETUP_STEPS } from '../../shared/types';
import type {
  TenantSetupApplied,
  TenantSetupNeedReason,
  TenantSetupRun,
  TenantSetupStatus,
} from '../../shared/types';

/** The row as D1 hands it back: JSON columns still strings. */
export interface TenantSetupRunRow {
  id: string;
  tenant_id: string;
  status: string;
  current_step: number;
  pack: string | null;
  state: string | null;
  applied: string | null;
  started_by: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

/**
 * Parse a JSON column into an object, and treat anything else as empty.
 *
 * Never throws. A run row whose `state` got corrupted must still LOAD — losing
 * a scratch blob costs somebody a couple of re-clicks, while a 500 on GET
 * /api/tenant-setup locks them out of the flow entirely and out of the tenant
 * they were configuring.
 */
function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Clamp a stored step into the range this build actually has.
 *
 * The column carries no CHECK on purpose (see the migration): the number of
 * screens is a property of the front end, and a run stamped at step 7 by a
 * later build must open at the last screen this build has rather than fail to
 * render.
 */
export function clampStep(step: number | null | undefined): number {
  const n = Number(step);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), TENANT_SETUP_STEPS);
}

export function toTenantSetupRun(row: TenantSetupRunRow): TenantSetupRun {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    status: row.status as TenantSetupStatus,
    current_step: clampStep(row.current_step),
    pack: row.pack,
    state: parseJsonObject(row.state),
    applied: parseJsonObject(row.applied) as TenantSetupApplied,
    started_by: row.started_by,
    started_at: row.started_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by,
  };
}

const SELECT_RUN = `
  SELECT id, tenant_id, status, current_step, pack, state, applied,
         started_by, started_at, updated_at, completed_at, completed_by
    FROM tenant_setup_runs
`;

/** The one draft, if there is one. The partial unique index guarantees at most one. */
export async function getDraftRun(
  db: D1Database,
  tenantId: string,
): Promise<TenantSetupRun | null> {
  const row = await db
    .prepare(`${SELECT_RUN} WHERE tenant_id = ? AND status = 'draft'`)
    .bind(tenantId)
    .first<TenantSetupRunRow>();
  return row ? toTenantSetupRun(row) : null;
}

export async function getRunById(
  db: D1Database,
  runId: string,
): Promise<TenantSetupRun | null> {
  const row = await db.prepare(`${SELECT_RUN} WHERE id = ?`).bind(runId).first<TenantSetupRunRow>();
  return row ? toTenantSetupRun(row) : null;
}

/** The most recently STARTED completed run, for "who set this up, and when". */
export async function getLatestCompletedRun(
  db: D1Database,
  tenantId: string,
): Promise<TenantSetupRun | null> {
  const row = await db
    .prepare(
      `${SELECT_RUN} WHERE tenant_id = ? AND status = 'completed'
        ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantSetupRunRow>();
  return row ? toTenantSetupRun(row) : null;
}

/** Active documents in the tenant. The second half of the `needed` test. */
export async function countActiveDocuments(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'active'`)
    .bind(tenantId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface TenantSetupNeed {
  needed: boolean;
  reason: TenantSetupNeedReason;
}

/**
 * Should the wizard be offered?
 *
 * TRUE ONLY WHEN BOTH ARE TRUE: no completed run exists AND the tenant has zero
 * active documents. Either condition on its own gives a wrong answer in a way
 * somebody will notice:
 *
 *   completed run alone   would re-prompt a tenant that finished the wizard and
 *                         then deliberately kept an empty tenant for a demo.
 *   emptiness alone       would nag a tenant that has been working for a year,
 *                         never saw a wizard because it did not exist, and does
 *                         not need one.
 *
 * A draft in flight is `needed: true` with reason `in_progress` — the banner
 * should say "resume", not "start", and the two are the same decision.
 */
export function decideSetupNeed(
  hasCompletedRun: boolean,
  documentCount: number,
  hasDraft: boolean,
): TenantSetupNeed {
  if (hasCompletedRun) return { needed: false, reason: 'already_completed' };
  if (documentCount > 0) return { needed: false, reason: 'has_documents' };
  return { needed: true, reason: hasDraft ? 'in_progress' : 'never_run' };
}

/**
 * Open a draft run, abandoning any existing one first when `restart` is set.
 *
 * Not a transaction, and it does not need to be: the partial unique index is
 * the actual guard. Two admins pressing Start at the same instant produce one
 * insert and one UNIQUE failure, and the caller re-reads the draft rather than
 * creating a second — which is why `createDraftRun` returns the existing draft
 * instead of erroring when one is already there.
 */
export async function createDraftRun(
  db: D1Database,
  tenantId: string,
  userId: string,
  opts: { restart?: boolean; pack?: string | null } = {},
): Promise<TenantSetupRun> {
  const existing = await getDraftRun(db, tenantId);
  if (existing && !opts.restart) return existing;

  if (existing && opts.restart) {
    await db
      .prepare(
        `UPDATE tenant_setup_runs
            SET status = 'abandoned', updated_at = datetime('now')
          WHERE id = ? AND status = 'draft'`,
      )
      .bind(existing.id)
      .run();
  }

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO tenant_setup_runs (id, tenant_id, status, current_step, pack, started_by)
       VALUES (?, ?, 'draft', 1, ?, ?)`,
    )
    .bind(id, tenantId, opts.pack ?? null, userId)
    .run();

  const created = await getRunById(db, id);
  // The only way this is null is a lost race with a concurrent insert, in which
  // case the draft that won is the right answer to return.
  return created ?? ((await getDraftRun(db, tenantId)) as TenantSetupRun);
}

/**
 * Merge a stamp into a run's `applied` ledger.
 *
 * Read-modify-write on a JSON column rather than a per-screen table: the ledger
 * is provenance for the wizard's own rendering decisions, never a source of
 * truth about the tenant. If it and the tables disagree, the tables win — which
 * is why a lost write here is a cosmetic bug and not a data one.
 */
export async function stampApplied(
  db: D1Database,
  runId: string,
  key: string,
  value: unknown,
): Promise<TenantSetupRun | null> {
  const run = await getRunById(db, runId);
  if (!run) return null;
  const applied: Record<string, unknown> = { ...run.applied, [key]: value };
  await db
    .prepare(`UPDATE tenant_setup_runs SET applied = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(JSON.stringify(applied), runId)
    .run();
  return getRunById(db, runId);
}
