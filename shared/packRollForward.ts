/**
 * Rolling a starter pack forward: the PLAN, as a pure function.
 *
 * A pack update has to reach an organisation that was set up from an older
 * version WITHOUT undoing anything that organisation decided. That is a
 * three-way question, asked per item and, inside an item, per column:
 *
 *      BASE     what the pack wrote            (the ledger: `written`)
 *      CURRENT  what the row holds now         (the organisation's table)
 *      TARGET   what this pack version says    (`packItems(pack)`)
 *
 *   current == target                      nothing to do
 *   current == base  (and target differs)  the pack wrote it and nobody touched
 *                                          it: UPDATED to the target
 *   current != base                        the organisation changed it: KEPT,
 *                                          reported with both values, and
 *                                          changed only when a person names it
 *   base unknown (an adopted or baselined row that already differed)
 *                                          treated as the organisation's: KEPT.
 *                                          Nothing is overwritten on a guess.
 *
 * and for the item as a whole:
 *
 *   in the pack, not in the ledger, no row     NEW: inserted -- unless the
 *                                              organisation already has the
 *                                              same concept under another slug
 *                                              (a CONFLICT a person settles)
 *   in the pack, not in the ledger, row exists ADOPTED: the row is the item
 *                                              from now on; nothing duplicated
 *   in the ledger, row gone                    the organisation deleted it:
 *                                              STAYS GONE, and that is recorded
 *                                              so no later version resurrects it
 *   in the ledger, row switched off            STAYS OFF, untouched
 *   in the ledger, not in the pack any more    FLAGGED. Never deleted, never
 *                                              switched off.
 *
 * PER-COLUMN, NOT PER-ROW (decision C-166). An organisation that rewrote a
 * document type's description still gets the pack's new default owner. Two
 * exceptions are settings made of several columns -- a limit's threshold
 * (operator, both bounds, unit) and a type's renewal (policy, months, window):
 * those move together or not at all, because half a threshold is a limit that
 * never fires (`PACK_KIND_SPECS[kind].groups`).
 *
 * WHAT A ROLL-FORWARD NEVER DOES:
 *   - change a slug (it is not a column the pack "writes"; it is the key);
 *   - loosen a document type's sharing rule. A move toward "send freely" is
 *     reported as NEEDING A PERSON and is not applied even when accepted --
 *     releasing documents is a person's act on the Document Types screen;
 *   - touch history. It updates the configuration rows only; a recorded
 *     `limit_snapshot` or `renewal_snapshot` is a separate frozen copy.
 *
 * This file decides; `functions/lib/pack-roll-forward.ts` reads the tables and
 * writes what is decided here, and `bin/baseline-pack-ledger` uses the same
 * comparison (`packFieldDiff`) to ledger an organisation seeded before the
 * ledger existed.
 */

import {
  PACK_KIND_SPECS,
  packItems,
  type PackDifferenceOrigin,
  type PackItem,
  type PackItemKind,
  type PackLike,
  type PackValue,
} from './packItems';
import { conceptKey } from './duplicateConcept';
import { defaultSharingRuleForTypeName, loosens, parseSharingRule } from './sharingRule';

/** One row of `pack_applied_items`, parsed. */
export interface PackLedgerEntry {
  kind: PackItemKind;
  item_key: string;
  row_id: string | null;
  pack_version: number;
  written: Record<string, PackValue>;
  differing: Record<string, PackDifferenceOrigin>;
  state: string;
}

/** One row of the organisation's own tables, as `PACK_KIND_SPECS[kind].readSql` returns it. */
export interface PackCurrentRow {
  natural_key: string;
  row_id: string;
  active: number | null;
  [column: string]: PackValue | undefined;
}

/** A person's "take the pack's value here". No `field` = every kept column of the item. */
export interface PackAccept {
  kind: string;
  key: string;
  field?: string | null;
}

export type PackFieldAction =
  /** The row is moved to the pack's value. */
  | 'update'
  /** The pack changed this and the organisation's value is kept. */
  | 'keep'
  /** The organisation's value differs and the pack has nothing new to offer. */
  | 'customised'
  /** A change only a person may make (a looser sharing rule). Never applied here. */
  | 'needs_person';

export type PackFieldReason =
  /** The pack wrote the old value and nobody touched it. */
  | 'pack_wrote'
  /** A person accepted the pack's value for it. */
  | 'accepted'
  /** The organisation changed what the pack wrote. */
  | 'edited'
  /** It already differed when the row was ledgered; nobody knows who wrote it. */
  | 'unknown'
  /** Another column of the same setting is kept, so this one is too. */
  | 'setting'
  /** The change would make documents easier to send out. */
  | 'loosens';

export interface PackPlanField {
  field: string;
  action: PackFieldAction;
  reason: PackFieldReason;
  /** What the pack wrote, when that is known. */
  base?: PackValue;
  /** What the row holds. */
  current: PackValue;
  /** What this pack version says. */
  target: PackValue;
}

export type PackItemOutcome =
  /** A new pack item: the row is inserted. */
  | 'insert'
  /** A row already holds this item's slug: it becomes the item. Nothing is inserted. */
  | 'adopt'
  /** At least one column is moved to the pack's value. */
  | 'update'
  /** The pack changed something here and the organisation's value is kept. */
  | 'keep'
  /** A new item the organisation already has under another slug. A person decides. */
  | 'conflict'
  /** A new link whose other end is not (yet) in the organisation. Waits. */
  | 'parent_missing'
  /** Ledgered with a row; the row has gone. Stays gone. */
  | 'deleted'
  /** The row is switched off. Stays off, untouched. */
  | 'inactive'
  /** Never had a row (baseline), or its parent was removed. Not resurrected. */
  | 'absent'
  /** The pack no longer has this item. Flagged; the row is left exactly as it is. */
  | 'removed_from_pack'
  /** Nothing the pack changed touches this item. */
  | 'unchanged';

export interface PackPlanLedgerWrite {
  row_id: string | null;
  pack_version: number;
  written: Record<string, PackValue>;
  differing: Record<string, PackDifferenceOrigin>;
  state: string;
}

export interface PackPlanItem {
  kind: PackItemKind;
  key: string;
  label: string;
  row_id: string | null;
  outcome: PackItemOutcome;
  /**
   * False when the outcome was already recorded by an earlier run (an item
   * flagged as removed last time, a row deleted two versions ago): still listed,
   * no longer news, and nothing is written for it.
   */
  news: boolean;
  /** Every column that is not simply in step, with all three values. */
  fields: PackPlanField[];
  /** For `conflict`: the row the organisation already has. */
  conflict?: { id: string; name: string; slug: string; active: boolean };
  /** For `parent_missing` / `absent`: what is not there. */
  missing?: string;
  /** For `insert`: the item itself, so the executor does not look it up again. */
  item?: PackItem;
  /** Columns the row is updated to, guarded by the values they were planned against. */
  row_update?: { set: Record<string, PackValue>; guard: Record<string, PackValue> };
  /** The ledger entry this run writes, or null when the entry already says it. */
  ledger: PackPlanLedgerWrite | null;
}

export interface PackPlanSummary {
  inserted: number;
  adopted: number;
  updated: number;
  fields_updated: number;
  kept: number;
  needs_person: number;
  conflicts: number;
  parent_missing: number;
  gone: number;
  removed_from_pack: number;
  customised: number;
  unchanged: number;
  /** Items this run writes anything for (a row, a ledger entry, or both). */
  writes: number;
}

export interface PackRollForwardPlan {
  pack: string;
  from_version: number | null;
  to_version: number;
  items: PackPlanItem[];
  summary: PackPlanSummary;
}

/** Null-safe equality on the three types a pack value can be. */
export function samePackValue(a: PackValue | undefined, b: PackValue | undefined): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  return x === y;
}

/**
 * The columns of a row that do not hold the pack's value, each marked
 * 'unknown'. This is what an ADOPTED row's ledger entry records, and it is the
 * JavaScript twin of the SQL in `packLedgerAdopt` (shared/packItems.ts) --
 * tests/api/pack-roll-forward.test.ts ledgers the same rows both ways and
 * compares them.
 */
export function packFieldDiff(
  fields: Record<string, PackValue>,
  row: Record<string, PackValue | undefined>,
): Record<string, PackDifferenceOrigin> {
  const out: Record<string, PackDifferenceOrigin> = {};
  for (const name of Object.keys(fields)) {
    if (!samePackValue(row[name], fields[name])) out[name] = 'unknown';
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

function ledgerDiffers(entry: PackLedgerEntry | undefined, next: PackPlanLedgerWrite): boolean {
  if (!entry) return true;
  return (
    entry.row_id !== next.row_id ||
    entry.pack_version !== next.pack_version ||
    entry.state !== next.state ||
    !sameJson(entry.written, next.written) ||
    !sameJson(entry.differing, next.differing)
  );
}

const VOCABULARY_KINDS: readonly PackItemKind[] = ['document_type', 'requirement', 'claim_type'];
/** A row is gone by the organisation's own decision in these states. */
const GONE_STATES = new Set(['absent', 'deleted']);

export interface PackRollForwardInput {
  pack: PackLike;
  /** The version `tenant_packs` says the organisation is on, or null. */
  fromVersion: number | null;
  ledger: readonly PackLedgerEntry[];
  rows: Partial<Record<PackItemKind, readonly PackCurrentRow[]>>;
  accept?: readonly PackAccept[];
}

export function planPackRollForward(input: PackRollForwardInput): PackRollForwardPlan {
  const { pack } = input;
  const items = packItems(pack);
  const itemIndex = new Map(items.map((i) => [`${i.kind}\u0000${i.key}`, i]));

  const ledger = new Map<string, PackLedgerEntry>();
  for (const e of input.ledger) ledger.set(`${e.kind}\u0000${e.item_key}`, e);

  const byNatural = new Map<PackItemKind, Map<string, PackCurrentRow>>();
  const byId = new Map<PackItemKind, Map<string, PackCurrentRow>>();
  for (const kind of Object.keys(PACK_KIND_SPECS) as PackItemKind[]) {
    const n = new Map<string, PackCurrentRow>();
    const i = new Map<string, PackCurrentRow>();
    for (const row of input.rows[kind] ?? []) {
      n.set(String(row.natural_key), row);
      i.set(String(row.row_id), row);
    }
    byNatural.set(kind, n);
    byId.set(kind, i);
  }

  const aliasesOf = new Map<string, readonly string[]>();
  const packSlugs = new Map<PackItemKind, Set<string>>();
  const vocab: Array<[PackItemKind, ReadonlyArray<{ slug: string; aliases?: readonly string[] }>]> = [
    ['document_type', pack.document_types],
    ['requirement', pack.requirements],
    ['claim_type', pack.claim_types],
  ];
  for (const [kind, list] of vocab) {
    packSlugs.set(kind, new Set(list.map((x) => x.slug)));
    for (const x of list) aliasesOf.set(`${kind}\u0000${x.slug}`, x.aliases ?? []);
  }

  const acceptAll = new Set<string>();
  const acceptField = new Set<string>();
  for (const a of input.accept ?? []) {
    if (!a || typeof a.kind !== 'string' || typeof a.key !== 'string') continue;
    if (a.field) acceptField.add(`${a.kind}\u0000${a.key}\u0000${a.field}`);
    else acceptAll.add(`${a.kind}\u0000${a.key}`);
  }

  const out: PackPlanItem[] = [];
  /** What each item resolved to, for the links that hang off it. */
  const resolved = new Map<string, 'present' | 'gone' | 'waiting'>();
  /**
   * Items whose row sits at its NATURAL key (or is about to be inserted there).
   * A new link is inserted by joining on that key, so a parent the organisation
   * renamed (a lab test, whose key is its name) cannot take a new link yet.
   */
  const atNaturalKey = new Set<string>();

  for (const item of items) {
    const id = `${item.kind}\u0000${item.key}`;
    const spec = PACK_KIND_SPECS[item.kind];
    const entry = ledger.get(id);
    const row =
      (entry?.row_id ? byId.get(item.kind)!.get(entry.row_id) : undefined) ??
      byNatural.get(item.kind)!.get(item.natural);
    const base: PackPlanItem = {
      kind: item.kind,
      key: item.key,
      label: item.label,
      row_id: row ? String(row.row_id) : null,
      outcome: 'unchanged',
      news: false,
      fields: [],
      ledger: null,
    };

    // ---- no row --------------------------------------------------------
    if (!row) {
      if (entry) {
        // Ledgered, and there is nothing there: the organisation removed it
        // (or never had it). It stays gone; the first run that notices writes
        // that down so the next one has nothing to report as new.
        const state = GONE_STATES.has(entry.state) ? entry.state : 'deleted';
        const next: PackPlanLedgerWrite = {
          row_id: null,
          pack_version: entry.pack_version,
          written: entry.written,
          differing: entry.differing,
          state,
        };
        const changed = ledgerDiffers(entry, next);
        out.push({
          ...base,
          outcome: state === 'absent' ? 'absent' : 'deleted',
          news: changed,
          ledger: changed ? next : null,
        });
        resolved.set(id, 'gone');
        continue;
      }

      // A new item. First: does everything it hangs off exist?
      let waitingOn: string | null = null;
      let goneParent: string | null = null;
      for (const parent of item.parents) {
        const state = resolved.get(`${parent.kind}\u0000${parent.key}`);
        const parentItem = itemIndex.get(`${parent.kind}\u0000${parent.key}`);
        const name = `the ${PACK_KIND_SPECS[parent.kind].noun} "${parentItem?.label ?? parent.key}"`;
        if (state === 'gone') goneParent = goneParent ?? name;
        else if (state !== 'present') waitingOn = waitingOn ?? name;
        else if (!atNaturalKey.has(`${parent.kind}\u0000${parent.key}`)) {
          waitingOn = waitingOn ?? `${name}, which this organisation has renamed`;
        }
      }
      if (goneParent) {
        // The organisation removed what this would hang off, so it is gone by
        // the same decision. Recorded, so it is settled.
        out.push({
          ...base,
          outcome: 'absent',
          news: true,
          missing: goneParent,
          ledger: { row_id: null, pack_version: pack.version, written: item.fields, differing: {}, state: 'absent' },
        });
        resolved.set(id, 'gone');
        continue;
      }
      if (waitingOn) {
        out.push({ ...base, outcome: 'parent_missing', news: true, missing: waitingOn });
        resolved.set(id, 'waiting');
        continue;
      }

      // Second: is it a concept the organisation already has under another slug?
      if (VOCABULARY_KINDS.includes(item.kind)) {
        const keys = new Set(
          [String(item.fields.name ?? ''), item.key, ...(aliasesOf.get(id) ?? [])].map(conceptKey).filter(Boolean),
        );
        const mine = packSlugs.get(item.kind)!;
        const twin = (input.rows[item.kind] ?? []).find(
          (r) =>
            // A row that IS another pack item is that item, whatever it is called.
            !mine.has(String(r.natural_key)) &&
            (keys.has(conceptKey(String(r.name ?? ''))) || keys.has(conceptKey(String(r.natural_key)))),
        );
        if (twin && !acceptAll.has(id)) {
          out.push({
            ...base,
            outcome: 'conflict',
            news: true,
            conflict: {
              id: String(twin.row_id),
              name: String(twin.name ?? ''),
              slug: String(twin.natural_key),
              active: twin.active !== 0,
            },
          });
          resolved.set(id, 'waiting');
          continue;
        }
      }

      out.push({ ...base, outcome: 'insert', news: true, item });
      resolved.set(id, 'present');
      atNaturalKey.add(id);
      continue;
    }

    // ---- a row exists ----------------------------------------------------
    resolved.set(id, 'present');
    if (byNatural.get(item.kind)!.get(item.natural) === row) atNaturalKey.add(id);
    const rowId = String(row.row_id);
    const active = spec.activeColumn === null || row.active !== 0;

    // Not in the ledger (or ledgered as gone and since put back by hand): the
    // row is ADOPTED. Whatever it holds that is not the pack's is of unknown
    // origin and is the organisation's.
    const adopting = !entry || GONE_STATES.has(entry.state);

    if (!active) {
      // Switched off. It stays off and is not updated while it is off; its
      // `written` is left where it was so the comparison is still right on the
      // day somebody switches it back on.
      const next: PackPlanLedgerWrite = adopting
        ? {
            row_id: rowId,
            pack_version: pack.version,
            written: item.fields,
            differing: packFieldDiff(item.fields, row),
            state: 'inactive',
          }
        : {
            row_id: rowId,
            pack_version: entry!.pack_version,
            written: entry!.written,
            differing: entry!.differing,
            state: 'inactive',
          };
      const changed = ledgerDiffers(entry, next);
      out.push({ ...base, outcome: 'inactive', news: changed, ledger: changed ? next : null });
      continue;
    }

    const fields: PackPlanField[] = [];
    for (const name of Object.keys(item.fields)) {
      const current = (row[name] === undefined ? null : row[name]) as PackValue;
      const target = item.fields[name];
      if (samePackValue(current, target)) continue;

      const origin = adopting ? 'unknown' : entry!.differing[name];
      const known = !adopting && origin === undefined && Object.prototype.hasOwnProperty.call(entry!.written, name);
      const baseValue = known ? entry!.written[name] : undefined;
      // Did the pack itself change this column since the entry was written?
      // Unknown for an adopted row, so it is reported.
      const packChanged = adopting || !Object.prototype.hasOwnProperty.call(entry!.written, name)
        ? true
        : !samePackValue(entry!.written[name], target);

      if (known && samePackValue(current, baseValue)) {
        fields.push({ field: name, action: 'update', reason: 'pack_wrote', base: baseValue, current, target });
      } else {
        const reason: PackFieldReason = origin ?? (known ? 'edited' : 'unknown');
        fields.push({
          field: name,
          action: packChanged ? 'keep' : 'customised',
          reason,
          ...(known ? { base: baseValue } : {}),
          current,
          target,
        });
      }
    }

    // A person's accept: every kept column of the item, or one named column.
    const groupOf = (name: string) => spec.groups.find((g) => g.includes(name)) ?? [name];
    const accepted = new Set<string>();
    for (const f of fields) {
      const named = acceptField.has(`${id}\u0000${f.field}`);
      if ((f.action === 'keep' && acceptAll.has(id)) || ((f.action === 'keep' || f.action === 'customised') && named)) {
        for (const mate of groupOf(f.field)) accepted.add(mate);
      }
    }
    for (const f of fields) {
      if (accepted.has(f.field) && (f.action === 'keep' || f.action === 'customised')) {
        f.action = 'update';
        f.reason = 'accepted';
      }
    }

    // One setting, several columns: it moves whole or not at all.
    for (const group of spec.groups) {
      const members = fields.filter((f) => group.includes(f.field));
      if (members.some((f) => f.action !== 'update')) {
        for (const f of members) {
          if (f.action === 'update') {
            f.action = 'keep';
            f.reason = 'setting';
          }
        }
      }
    }

    // A looser sharing rule is a person's act, never a roll-forward's.
    if (item.kind === 'document_type') {
      for (const f of fields) {
        if (f.field !== 'sharing_rule' || f.action !== 'update') continue;
        const targetRule = parseSharingRule(f.target);
        const effective = parseSharingRule(f.current) ?? defaultSharingRuleForTypeName(String(row.name ?? ''));
        if (!targetRule || loosens(effective, targetRule)) {
          f.action = 'needs_person';
          f.reason = 'loosens';
        }
      }
    }

    const updates = fields.filter((f) => f.action === 'update');
    const set: Record<string, PackValue> = {};
    const guard: Record<string, PackValue> = {};
    for (const f of updates) {
      set[f.field] = f.target;
      guard[f.field] = f.current;
    }

    // The ledger after this run: `written` is the pack's values at this
    // version -- except a column waiting on a person, which keeps the value the
    // pack last wrote so it is offered again rather than filed as "customised".
    const written: Record<string, PackValue> = { ...item.fields };
    const differing: Record<string, PackDifferenceOrigin> = {};
    for (const f of fields) {
      if (f.action === 'update') continue;
      if (f.action === 'needs_person') {
        if (f.base !== undefined) written[f.field] = f.base;
        else differing[f.field] = 'unknown';
        continue;
      }
      differing[f.field] = f.reason === 'unknown' ? 'unknown' : f.reason === 'edited' ? 'edited' : (entry?.differing[f.field] ?? 'edited');
    }
    const next: PackPlanLedgerWrite = {
      row_id: rowId,
      pack_version: pack.version,
      written,
      differing,
      state: Object.keys(differing).length === 0 ? 'pack' : 'differs',
    };
    const changed = ledgerDiffers(adopting ? undefined : entry, next);

    let outcome: PackItemOutcome = 'unchanged';
    if (adopting) outcome = 'adopt';
    else if (updates.length > 0) outcome = 'update';
    else if (fields.some((f) => f.action === 'keep' || f.action === 'needs_person')) outcome = 'keep';

    out.push({
      ...base,
      row_id: rowId,
      outcome,
      news: outcome !== 'unchanged',
      fields,
      ...(updates.length > 0 ? { row_update: { set, guard } } : {}),
      ledger: changed ? next : null,
    });
  }

  // ---- in the ledger, not in the pack any more ---------------------------
  for (const entry of input.ledger) {
    const id = `${entry.kind}\u0000${entry.item_key}`;
    if (itemIndex.has(id)) continue;
    const spec = PACK_KIND_SPECS[entry.kind];
    if (!spec) continue;
    const row = entry.row_id ? byId.get(entry.kind)?.get(entry.row_id) : undefined;
    const already = entry.state === 'removed_from_pack';
    out.push({
      kind: entry.kind,
      key: entry.item_key,
      label: row && typeof row.name === 'string' ? row.name : entry.item_key,
      row_id: entry.row_id,
      outcome: 'removed_from_pack',
      news: !already,
      fields: [],
      ledger: already
        ? null
        : {
            row_id: entry.row_id,
            pack_version: entry.pack_version,
            written: entry.written,
            differing: entry.differing,
            state: 'removed_from_pack',
          },
    });
  }

  const summary: PackPlanSummary = {
    inserted: 0,
    adopted: 0,
    updated: 0,
    fields_updated: 0,
    kept: 0,
    needs_person: 0,
    conflicts: 0,
    parent_missing: 0,
    gone: 0,
    removed_from_pack: 0,
    customised: 0,
    unchanged: 0,
    writes: 0,
  };
  for (const p of out) {
    if (p.outcome === 'insert') summary.inserted += 1;
    else if (p.outcome === 'adopt') summary.adopted += 1;
    else if (p.outcome === 'conflict') summary.conflicts += 1;
    else if (p.outcome === 'parent_missing') summary.parent_missing += 1;
    else if (p.outcome === 'removed_from_pack') summary.removed_from_pack += p.news ? 1 : 0;
    else if (p.outcome === 'deleted' || p.outcome === 'inactive' || p.outcome === 'absent') summary.gone += p.news ? 1 : 0;
    else if (p.outcome === 'unchanged') summary.unchanged += 1;
    const updates = p.fields.filter((f) => f.action === 'update').length;
    if (updates > 0) {
      summary.updated += 1;
      summary.fields_updated += updates;
    }
    if (p.fields.some((f) => f.action === 'keep')) summary.kept += 1;
    if (p.fields.some((f) => f.action === 'needs_person')) summary.needs_person += 1;
    if (p.fields.some((f) => f.action === 'customised')) summary.customised += 1;
    if (p.outcome === 'insert' || p.row_update || p.ledger) summary.writes += 1;
  }

  return { pack: pack.pack, from_version: input.fromVersion, to_version: pack.version, items: out, summary };
}

/** True when the plan would change nothing: no row, no ledger entry, no version. */
export function packPlanIsNoOp(plan: PackRollForwardPlan): boolean {
  return plan.summary.writes === 0 && plan.from_version === plan.to_version;
}
