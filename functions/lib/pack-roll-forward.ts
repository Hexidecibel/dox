/**
 * Rolling a starter pack forward: the D1 shell around `planPackRollForward`
 * (shared/packRollForward.ts).
 *
 * ONE ENTRY POINT, `runPackRollForward`, behind ONE door,
 * POST /api/starter-packs/roll-forward -- the shape of `runSupplierListImport`:
 * a dry run is the default and writes NOTHING (no row, no ledger entry, no
 * version); an apply recomputes the plan from the tables as they are at that
 * moment and writes exactly what it then says.
 *
 * WHAT AN APPLY WRITES, in this order:
 *   1. the rows of NEW pack items, through the same INSERT the appliers use
 *      (`packRowInsert`), in dependency order, as one transaction;
 *   2. the columns the plan marked `update`, each as an UPDATE GUARDED IN SQL
 *      by the value it was planned against (`... AND description IS ?`). A
 *      person who edits a row between the preview and the apply therefore wins
 *      even against a stale plan: the statement changes nothing, the item is
 *      reported `changed_since_preview`, and its ledger entry is left alone so
 *      the next run sees it afresh;
 *   3. the ledger (`pack_applied_items`) for every item whose entry moved;
 *   4. one `tenant_packs` row when the version moved;
 *   5. the audit rows.
 *
 * TWO COLUMNS GO THROUGH THE RULE A MANUAL EDIT GOES THROUGH:
 *
 *   a limit's threshold. `spec_limits.version` moves when, and only when, the
 *       threshold does -- `limitThresholdChanged` (shared/specCheck.ts), the
 *       one rule the REST PUT and the importer share. A roll-forward that moves
 *       a bound bumps the version and writes the same `spec_limit.updated`
 *       audit row, marked `via: 'pack_roll_forward'`. Verdicts already recorded
 *       keep their frozen `limit_snapshot`; nothing here reads or writes one.
 *
 *   a type's sharing rule. The planner never plans a LOOSER rule (it reports
 *       it as needing a person), so what reaches this file is a tightening; it
 *       is written with the same `document_type.sharing_rule_updated` audit row
 *       as PUT /api/document-types/:id. And like that route, a RENAME of a type
 *       with no stored rule first writes down the rule its old name was read
 *       as, so a pack renaming a type cannot move what may leave.
 *       (`planDocumentRuleChange` is the decision for ONE DOCUMENT's type or
 *       override; a type's own rule is decided by `loosens`, here and on the
 *       type route alike.)
 *
 * NEVER: a slug, a delete, a deactivation, or a snapshot.
 */

import { logAudit } from './db';
import { BadRequestError } from './permissions';
import type { StarterPack } from './starterPacks.generated';
import {
  PACK_ITEM_KINDS,
  PACK_KIND_SPECS,
  isPackItemKind,
  packLedgerAdopt,
  packRowInsert,
  type PackApplyContext,
  type PackDifferenceOrigin,
  type PackItemKind,
  type PackStatement,
  type PackValue,
} from '../../shared/packItems';
import {
  planPackRollForward,
  type PackAccept,
  type PackCurrentRow,
  type PackLedgerEntry,
  type PackPlanItem,
  type PackRollForwardPlan,
} from '../../shared/packRollForward';
import { limitThresholdChanged, validateLimitShape } from '../../shared/specCheck';
import { defaultSharingRuleForTypeName, parseSharingRule } from '../../shared/sharingRule';
import type {
  PackRollForwardItem,
  PackRollForwardResponse,
  TenantPackStatus,
} from '../../shared/types';

function parseObject<T>(raw: unknown): Record<string, T> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {};
  } catch {
    return {};
  }
}

export async function loadPackLedger(db: D1Database, tenantId: string, pack: string): Promise<PackLedgerEntry[]> {
  const res = await db
    .prepare(
      `SELECT kind, item_key, row_id, pack_version, written, differing, state
         FROM pack_applied_items WHERE tenant_id = ? AND pack = ?`,
    )
    .bind(tenantId, pack)
    .all<{
      kind: string;
      item_key: string;
      row_id: string | null;
      pack_version: number;
      written: string;
      differing: string;
      state: string;
    }>();
  const out: PackLedgerEntry[] = [];
  for (const r of res.results ?? []) {
    // A kind this build does not know is left alone: it is neither planned nor
    // reported as removed. (A newer build wrote it.)
    if (!isPackItemKind(r.kind)) continue;
    out.push({
      kind: r.kind,
      item_key: r.item_key,
      row_id: r.row_id,
      pack_version: Number(r.pack_version),
      written: parseObject<PackValue>(r.written),
      differing: parseObject<PackDifferenceOrigin>(r.differing),
      state: r.state,
    });
  }
  return out;
}

/** Every row of the organisation's that a pack could have written, by kind. One round trip. */
export async function loadPackRows(
  db: D1Database,
  tenantId: string,
): Promise<Record<PackItemKind, PackCurrentRow[]>> {
  const results = await db.batch<PackCurrentRow>(
    PACK_ITEM_KINDS.map((kind) => db.prepare(PACK_KIND_SPECS[kind].readSql).bind(tenantId)),
  );
  const out = {} as Record<PackItemKind, PackCurrentRow[]>;
  PACK_ITEM_KINDS.forEach((kind, i) => {
    out[kind] = (results[i]?.results ?? []) as PackCurrentRow[];
  });
  return out;
}

/** The version `tenant_packs` says the organisation is on, or null when it has no entry. */
export async function currentPackVersion(db: D1Database, tenantId: string, pack: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT MAX(version) AS version FROM tenant_packs WHERE tenant_id = ? AND pack = ?')
    .bind(tenantId, pack)
    .first<{ version: number | null }>();
  return row?.version === null || row?.version === undefined ? null : Number(row.version);
}

/** What Settings > Starter pack opens with: each pack the organisation is on, and what is available. */
export async function listTenantPackStatus(
  db: D1Database,
  tenantId: string,
  getPack: (name: string) => StarterPack | null,
): Promise<TenantPackStatus[]> {
  const res = await db
    .prepare(
      `SELECT tp.pack, tp.version, tp.applied_at, tp.source, tp.applied_by, u.name AS applied_by_name
         FROM tenant_packs tp
         LEFT JOIN users u ON u.id = tp.applied_by
        WHERE tp.tenant_id = ?
        ORDER BY tp.pack, tp.version DESC, tp.applied_at DESC`,
    )
    .bind(tenantId)
    .all<{
      pack: string;
      version: number;
      applied_at: string;
      source: string;
      applied_by: string | null;
      applied_by_name: string | null;
    }>();
  const seen = new Set<string>();
  const out: TenantPackStatus[] = [];
  for (const r of res.results ?? []) {
    if (seen.has(r.pack)) continue;
    seen.add(r.pack);
    const pack = getPack(r.pack);
    out.push({
      pack: r.pack,
      label: pack?.label ?? r.pack,
      version: Number(r.version),
      available_version: pack ? pack.version : null,
      update_available: pack ? pack.version > Number(r.version) : false,
      applied_at: r.applied_at,
      applied_by_name: r.applied_by_name,
      source: r.source,
      history: (res.results ?? [])
        .filter((h) => h.pack === r.pack)
        .map((h) => ({
          version: Number(h.version),
          applied_at: h.applied_at,
          source: h.source,
          applied_by_name: h.applied_by_name,
        })),
    });
  }
  return out;
}

function bind(db: D1Database, statement: PackStatement): D1PreparedStatement {
  return db.prepare(statement.sql).bind(...statement.params);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < statements.length; i += 100) {
    out.push(...(await db.batch(statements.slice(i, i + 100))));
  }
  return out;
}

function viewOf(item: PackPlanItem): PackRollForwardItem {
  return {
    kind: item.kind,
    key: item.key,
    label: item.label,
    noun: PACK_KIND_SPECS[item.kind].noun,
    row_id: item.row_id,
    outcome: item.outcome,
    news: item.news,
    fields: item.fields,
    ...(item.conflict ? { conflict: item.conflict } : {}),
    ...(item.missing ? { missing: item.missing } : {}),
  };
}

/** The items worth sending to a screen or an audit row: everything but "nothing to say". */
function reportable(plan: PackRollForwardPlan): PackPlanItem[] {
  return plan.items.filter((i) => i.outcome !== 'unchanged' || i.fields.length > 0);
}

export interface PackRollForwardOptions {
  tenantId: string;
  /** Seeds the id of a row this inserts. Never used to look one up. */
  tenantSlug: string;
  pack: StarterPack;
  dryRun: boolean;
  accept: readonly PackAccept[];
  actorId: string;
  ip: string | null;
}

export async function runPackRollForward(
  db: D1Database,
  opts: PackRollForwardOptions,
): Promise<PackRollForwardResponse> {
  const { pack, tenantId } = opts;

  for (const a of opts.accept) {
    if (!a || typeof a !== 'object' || !isPackItemKind(a.kind) || typeof a.key !== 'string' || !a.key) {
      throw new BadRequestError('accept must be a list of { kind, key, field? } naming items of this pack');
    }
    if (a.field !== undefined && a.field !== null && typeof a.field !== 'string') {
      throw new BadRequestError('accept[].field must be a column name');
    }
  }

  const [ledger, rows, fromVersion] = await Promise.all([
    loadPackLedger(db, tenantId, pack.pack),
    loadPackRows(db, tenantId),
    currentPackVersion(db, tenantId, pack.pack),
  ]);
  const plan = planPackRollForward({ pack, fromVersion, ledger, rows, accept: opts.accept });

  const response: PackRollForwardResponse = {
    dry_run: opts.dryRun,
    tenant_id: tenantId,
    pack: pack.pack,
    label: pack.label,
    from_version: plan.from_version,
    to_version: plan.to_version,
    ledgered: fromVersion !== null,
    up_to_date: plan.summary.writes === 0 && plan.from_version === plan.to_version,
    summary: plan.summary,
    items: reportable(plan).map(viewOf),
    not_applied: [],
  };
  if (opts.dryRun) return response;

  const ctx: PackApplyContext = {
    tenantId,
    tenantSlug: opts.tenantSlug,
    source: 'roll_forward',
    appliedBy: opts.actorId,
  };
  const rowsById = new Map<string, PackCurrentRow>();
  for (const kind of PACK_ITEM_KINDS) {
    for (const row of rows[kind]) rowsById.set(`${kind}\u0000${row.row_id}`, row);
  }
  const notApplied: PackRollForwardResponse['not_applied'] = [];
  const skipLedger = new Set<PackPlanItem>();

  // ---- 1. new items ------------------------------------------------------
  const inserts = plan.items.filter((i) => i.outcome === 'insert' && i.item);
  if (inserts.length > 0) {
    await runBatches(
      db,
      inserts.map((i) => bind(db, packRowInsert(pack.pack, i.item!, ctx, false))),
    );
    await runBatches(
      db,
      inserts.map((i) => bind(db, packLedgerAdopt(pack.pack, pack.version, i.item!, ctx))),
    );
    // An insert that found nothing to hang off writes no row and therefore no
    // ledger entry. Said, never assumed.
    const after = await loadPackLedger(db, tenantId, pack.pack);
    const have = new Set(after.map((e) => `${e.kind}\u0000${e.item_key}`));
    for (const i of inserts) {
      if (!have.has(`${i.kind}\u0000${i.key}`)) {
        notApplied.push({ kind: i.kind, key: i.key, label: i.label, reason: 'not_inserted' });
      }
    }
  }

  // ---- 2. columns the pack wrote and nobody touched ----------------------
  interface PlannedUpdate {
    item: PackPlanItem;
    stmt: D1PreparedStatement;
    audit?: () => Promise<void>;
  }
  const updates: PlannedUpdate[] = [];
  for (const item of plan.items) {
    if (!item.row_update || !item.row_id) continue;
    const spec = PACK_KIND_SPECS[item.kind];
    const row = rowsById.get(`${item.kind}\u0000${item.row_id}`);
    const set: Record<string, PackValue> = { ...item.row_update.set };
    const guard = item.row_update.guard;
    const extra: string[] = [];
    let audit: PlannedUpdate['audit'];

    if (item.kind === 'spec_limit' && row) {
      const before = {
        operator: String(row.operator ?? ''),
        value_min: (row.value_min ?? null) as number | null,
        value_max: (row.value_max ?? null) as number | null,
        unit: (row.unit ?? null) as string | null,
      };
      const after = {
        operator: String(set.operator ?? before.operator),
        value_min: (Object.prototype.hasOwnProperty.call(set, 'value_min') ? set.value_min : before.value_min) as number | null,
        value_max: (Object.prototype.hasOwnProperty.call(set, 'value_max') ? set.value_max : before.value_max) as number | null,
        unit: (Object.prototype.hasOwnProperty.call(set, 'unit') ? set.unit : before.unit) as string | null,
      };
      // The threshold is one setting and moves whole, so this cannot fail for
      // a pack that compiled; checked anyway, because a limit that can never
      // fire is worse than a limit left as it was.
      const shapeError = validateLimitShape(after);
      if (shapeError) {
        notApplied.push({ kind: item.kind, key: item.key, label: item.label, reason: 'invalid_limit', detail: shapeError });
        skipLedger.add(item);
        continue;
      }
      const moved = limitThresholdChanged(before, after);
      if (moved) extra.push('version = version + 1');
      const version = Number(row.version ?? 1);
      audit = () =>
        logAudit(
          db,
          opts.actorId,
          tenantId,
          'spec_limit.updated',
          'spec_limits',
          item.row_id!,
          JSON.stringify({
            via: 'pack_roll_forward',
            pack: pack.pack,
            pack_version: pack.version,
            before: { ...before, criticality: row.criticality ?? null, notes: row.notes ?? null, version },
            after: {
              ...after,
              criticality: set.criticality ?? row.criticality ?? null,
              notes: Object.prototype.hasOwnProperty.call(set, 'notes') ? set.notes : (row.notes ?? null),
              version: moved ? version + 1 : version,
            },
            version_bumped: moved,
          }),
          opts.ip,
        );
    }

    if (item.kind === 'document_type' && row) {
      const stored = parseSharingRule(row.sharing_rule);
      const effective = stored ?? defaultSharingRuleForTypeName(String(row.name ?? ''));
      if (Object.prototype.hasOwnProperty.call(set, 'sharing_rule')) {
        const to = parseSharingRule(set.sharing_rule);
        audit = () =>
          logAudit(
            db,
            opts.actorId,
            tenantId,
            'document_type.sharing_rule_updated',
            'document_type',
            item.row_id!,
            JSON.stringify({
              via: 'pack_roll_forward',
              pack: pack.pack,
              pack_version: pack.version,
              sharing_rule: to,
              previous_sharing_rule: stored,
              previous_effective_rule: effective,
            }),
            opts.ip,
          );
      } else if (Object.prototype.hasOwnProperty.call(set, 'name') && stored === null) {
        // A RENAME MUST NOT MOVE THE RULE: a type with no stored rule is read
        // from its name. The rule it was read as is written down first.
        set.sharing_rule = effective;
        audit = () =>
          logAudit(
            db,
            opts.actorId,
            tenantId,
            'document_type.sharing_rule_updated',
            'document_type',
            item.row_id!,
            JSON.stringify({
              via: 'pack_roll_forward',
              sharing_rule: effective,
              previous_sharing_rule: null,
              previous_effective_rule: effective,
              note: 'Pinned on rename: the rule this type was read as from its old name.',
            }),
            opts.ip,
          );
      }
    }

    const sets = Object.keys(set).map((c) => `${c} = ?`);
    const params: PackValue[] = Object.keys(set).map((c) => set[c]);
    sets.push(...extra);
    if (spec.hasUpdatedAt) sets.push("updated_at = datetime('now')");
    if (spec.hasUpdatedBy) {
      sets.push('updated_by = ?');
      params.push(opts.actorId);
    }
    let where = `tenant_id = ? AND ${spec.idColumn} = ?`;
    params.push(tenantId, item.row_id);
    for (const column of Object.keys(guard)) {
      where += ` AND ${column} IS ?`;
      params.push(guard[column]);
    }
    updates.push({
      item,
      stmt: db.prepare(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${where}`).bind(...params),
      audit,
    });
  }
  if (updates.length > 0) {
    const results = await runBatches(db, updates.map((u) => u.stmt));
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      // `> 0`, not a count: document_types carries reindex triggers whose
      // writes are counted too.
      if ((results[i]?.meta?.changes ?? 0) > 0) {
        if (u.audit) await u.audit();
      } else {
        notApplied.push({ kind: u.item.kind, key: u.item.key, label: u.item.label, reason: 'changed_since_preview' });
        skipLedger.add(u.item);
      }
    }
  }

  // ---- 3. the ledger -----------------------------------------------------
  const ledgerWrites = plan.items.filter((i) => i.ledger && i.outcome !== 'insert' && !skipLedger.has(i));
  if (ledgerWrites.length > 0) {
    await runBatches(
      db,
      ledgerWrites.map((i) =>
        db
          .prepare(
            `INSERT INTO pack_applied_items
               (tenant_id, pack, kind, item_key, row_id, pack_version, written, differing, state, source, applied_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'roll_forward', ?)
             ON CONFLICT (tenant_id, pack, kind, item_key) DO UPDATE SET
               row_id = excluded.row_id,
               pack_version = excluded.pack_version,
               written = excluded.written,
               differing = excluded.differing,
               state = excluded.state,
               updated_at = datetime('now')`,
          )
          .bind(
            tenantId,
            pack.pack,
            i.kind,
            i.key,
            i.ledger!.row_id,
            i.ledger!.pack_version,
            JSON.stringify(i.ledger!.written),
            JSON.stringify(i.ledger!.differing),
            i.ledger!.state,
            opts.actorId,
          ),
      ),
    );
  }

  // ---- 4. the version ----------------------------------------------------
  const versionMoved = plan.from_version !== plan.to_version;
  if (versionMoved) {
    await db
      .prepare(
        `INSERT INTO tenant_packs (id, tenant_id, pack, version, from_version, source, applied_by, summary)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'roll_forward', ?, ?)`,
      )
      .bind(tenantId, pack.pack, plan.to_version, plan.from_version, opts.actorId, JSON.stringify(plan.summary))
      .run();
  }

  // ---- 5. the record -----------------------------------------------------
  const wroteAnything = plan.summary.writes > 0 || versionMoved;
  if (wroteAnything) {
    await logAudit(
      db,
      opts.actorId,
      tenantId,
      'starter_pack.roll_forward',
      'tenant',
      tenantId,
      JSON.stringify({
        pack: pack.pack,
        from_version: plan.from_version,
        to_version: plan.to_version,
        accept: opts.accept,
        summary: plan.summary,
        not_applied: notApplied,
        // The whole plan that was applied, column by column: what the pack
        // wrote, what the row held, what it was moved to or kept at.
        plan: reportable(plan).map(viewOf),
      }),
      opts.ip,
    );
  }

  response.not_applied = notApplied;
  return response;
}
