/**
 * A supplier merge must not delete the loser's limits, its watch, or what was
 * taught about it.
 *
 * `spec_limits`, `supplier_required_analytes` and `teach_sessions` all reference
 * suppliers ON DELETE CASCADE, and `mergeSuppliers` moved none of them before
 * deleting the loser. So merging "Acme Dairy" into "Acme Dairy Inc." silently
 * deleted every tighter limit written for Acme Dairy, the analytes its
 * certificates were required to report, and the teach interviews held about
 * its documents (with their messages, which cascade from the session).
 *
 * A limit is the thing a merge must never lose quietly: it is a decision
 * somebody defended to purchasing. So where the winner already holds a limit
 * for the same analyte and scope, the winner's row is kept and the loser's
 * WHOLE row goes into the `supplier.merged` audit details -- kept once, said
 * out loud, never dropped.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { mergeSuppliers } from '../../functions/lib/suppliers';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

async function makeSupplier(name: string): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, seed.tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeAnalyte(name: string): Promise<string> {
  const id = `st-${generateTestId()}`;
  await db.prepare('INSERT INTO spec_tests (id, tenant_id, name) VALUES (?, ?, ?)').bind(id, seed.tenantId, name).run();
  return id;
}

async function makeDocType(name: string): Promise<string> {
  const id = `dt-${generateTestId()}`;
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, seed.tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function addLimit(
  analyteId: string,
  supplierId: string | null,
  max: number,
  opts: { notes?: string; reviewBy?: string; documentTypeId?: string | null } = {},
): Promise<string> {
  const id = `sl-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO spec_limits
         (id, tenant_id, spec_test_id, supplier_id, document_type_id, operator, value_max, unit, notes, review_by, criticality)
       VALUES (?, ?, ?, ?, ?, '<=', ?, 'CFU/g', ?, ?, 'high')`,
    )
    .bind(id, seed.tenantId, analyteId, supplierId, opts.documentTypeId ?? null, max, opts.notes ?? null, opts.reviewBy ?? null)
    .run();
  return id;
}

async function addRequired(supplierId: string, docTypeId: string, analyteId: string, reason: string): Promise<string> {
  const id = `sra-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO supplier_required_analytes (id, tenant_id, supplier_id, document_type_id, spec_test_id, reason, review_by)
       VALUES (?, ?, ?, ?, ?, ?, '2027-01-31')`,
    )
    .bind(id, seed.tenantId, supplierId, docTypeId, analyteId, reason)
    .run();
  return id;
}

async function merge(winner: string, loser: string) {
  return mergeSuppliers(db, seed.tenantId, {
    winnerId: winner,
    loserIds: [loser],
    actor: { userId: seed.orgAdminId, ip: '127.0.0.1' },
  });
}

async function mergeAudit(): Promise<any> {
  const row = await db
    .prepare(`SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'supplier.merged' ORDER BY rowid DESC LIMIT 1`)
    .bind(seed.tenantId)
    .first<{ details: string }>();
  return JSON.parse(row!.details);
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('mergeSuppliers keeps the loser\'s spec limits', () => {
  it('moves a limit only the loser has, with its id, its reason and its review-by', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const coliform = await makeAnalyte('Coliform');
    const limitId = await addLimit(coliform, loser, 10, { notes: 'Two failures in Q2; agreed with purchasing.', reviewBy: '2027-03-01' });

    const result = await merge(winner, loser);

    const row = await db.prepare('SELECT * FROM spec_limits WHERE id = ?').bind(limitId).first<any>();
    expect(row, 'the limit was deleted with the loser').not.toBeNull();
    expect(row.supplier_id).toBe(winner);
    expect(row.value_max).toBe(10);
    expect(row.notes).toBe('Two failures in Q2; agreed with purchasing.');
    expect(row.review_by).toBe('2027-03-01');
    expect(row.criticality).toBe('high');
    expect(result.reassigned.spec_limits).toBe(1);
    expect((await mergeAudit()).dropped_spec_limits).toBeUndefined();
  });

  it('on a collision keeps the winner\'s limit and records the loser\'s whole row in the audit', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const coliform = await makeAnalyte('Coliform');
    const yeast = await makeAnalyte('Yeast');
    const winnerLimit = await addLimit(coliform, winner, 50, { notes: 'winner standard' });
    const loserLimit = await addLimit(coliform, loser, 10, { notes: 'tighter, after the March complaint', reviewBy: '2027-03-01' });
    const moved = await addLimit(yeast, loser, 100);

    const result = await merge(winner, loser);

    // The winner's row is untouched; the non-colliding one moved.
    const kept = await db.prepare('SELECT supplier_id, value_max, notes FROM spec_limits WHERE id = ?').bind(winnerLimit).first<any>();
    expect(kept).toEqual({ supplier_id: winner, value_max: 50, notes: 'winner standard' });
    expect((await db.prepare('SELECT supplier_id FROM spec_limits WHERE id = ?').bind(moved).first<any>()).supplier_id).toBe(winner);
    expect(await db.prepare('SELECT id FROM spec_limits WHERE id = ?').bind(loserLimit).first()).toBeNull();
    expect(result.reassigned.spec_limits).toBe(1);

    // ...and the loser's limit is not lost: every column is in the audit row.
    const audit = await mergeAudit();
    expect(audit.dropped_spec_limits).toHaveLength(1);
    expect(audit.dropped_spec_limits[0]).toMatchObject({
      id: loserLimit,
      spec_test_id: coliform,
      supplier_id: loser,
      operator: '<=',
      value_max: 10,
      unit: 'CFU/g',
      notes: 'tighter, after the March complaint',
      review_by: '2027-03-01',
      criticality: 'high',
      kept_winner_limit_id: winnerLimit,
    });
  });

  it('a limit for the same analyte under a DIFFERENT document type is not a collision', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const coliform = await makeAnalyte('Coliform');
    const coa = await makeDocType('COA');
    await addLimit(coliform, winner, 50);
    const scoped = await addLimit(coliform, loser, 10, { documentTypeId: coa });

    await merge(winner, loser);

    const row = await db.prepare('SELECT supplier_id FROM spec_limits WHERE id = ?').bind(scoped).first<any>();
    expect(row.supplier_id).toBe(winner);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM spec_limits WHERE supplier_id = ?').bind(winner).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it('leaves the tenant-wide limit and other suppliers\' limits alone', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const other = await makeSupplier('Somebody Else');
    const coliform = await makeAnalyte('Coliform');
    const tenantWide = await addLimit(coliform, null, 100);
    const others = await addLimit(coliform, other, 5);

    await merge(winner, loser);

    expect((await db.prepare('SELECT supplier_id FROM spec_limits WHERE id = ?').bind(tenantWide).first<any>()).supplier_id).toBeNull();
    expect((await db.prepare('SELECT supplier_id FROM spec_limits WHERE id = ?').bind(others).first<any>()).supplier_id).toBe(other);
  });
});

describe('mergeSuppliers keeps the loser\'s watch (required analytes)', () => {
  it('moves the rows the winner lacks, keeps the winner\'s on a collision and records the loser\'s', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const coa = await makeDocType('COA');
    const listeria = await makeAnalyte('Listeria');
    const salmonella = await makeAnalyte('Salmonella');
    const movedId = await addRequired(loser, coa, listeria, 'Environmental positive in May');
    const winnerRow = await addRequired(winner, coa, salmonella, 'winner reason');
    const loserDup = await addRequired(loser, coa, salmonella, 'loser reason: customer complaint 4417');

    const result = await merge(winner, loser);

    const moved = await db.prepare('SELECT supplier_id, reason, review_by FROM supplier_required_analytes WHERE id = ?').bind(movedId).first<any>();
    expect(moved, 'the watch row was deleted with the loser').not.toBeNull();
    expect(moved).toEqual({ supplier_id: winner, reason: 'Environmental positive in May', review_by: '2027-01-31' });
    expect((await db.prepare('SELECT reason FROM supplier_required_analytes WHERE id = ?').bind(winnerRow).first<any>()).reason).toBe('winner reason');
    expect(await db.prepare('SELECT id FROM supplier_required_analytes WHERE id = ?').bind(loserDup).first()).toBeNull();
    expect(result.reassigned.supplier_required_analytes).toBe(1);

    const audit = await mergeAudit();
    expect(audit.dropped_required_analytes).toHaveLength(1);
    expect(audit.dropped_required_analytes[0]).toMatchObject({
      id: loserDup, supplier_id: loser, document_type_id: coa, spec_test_id: salmonella,
      reason: 'loser reason: customer complaint 4417', kept_winner_row_id: winnerRow,
    });
  });
});

describe('mergeSuppliers keeps what was taught about the loser', () => {
  it('moves teach sessions, and their messages come with them', async () => {
    const winner = await makeSupplier('Acme Dairy Inc.');
    const loser = await makeSupplier('Acme Dairy');
    const coa = await makeDocType('COA');
    const sessionId = `ts-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO teach_sessions (id, tenant_id, supplier_id, document_type_id, status, proposed_instructions, created_by)
         VALUES (?, ?, ?, ?, 'confirmed', 'The lot is in the footer.', ?)`,
      )
      .bind(sessionId, seed.tenantId, loser, coa, seed.orgAdminId)
      .run();
    await db
      .prepare(`INSERT INTO teach_messages (id, session_id, role, content) VALUES (?, ?, 'sme', 'The lot is in the footer.')`)
      .bind(`tm-${generateTestId()}`, sessionId)
      .run();

    const result = await merge(winner, loser);

    const session = await db.prepare('SELECT supplier_id, proposed_instructions FROM teach_sessions WHERE id = ?').bind(sessionId).first<any>();
    expect(session, 'the teach session was deleted with the loser').not.toBeNull();
    expect(session).toEqual({ supplier_id: winner, proposed_instructions: 'The lot is in the footer.' });
    const messages = await db.prepare('SELECT COUNT(*) AS n FROM teach_messages WHERE session_id = ?').bind(sessionId).first<{ n: number }>();
    expect(messages!.n).toBe(1);
    expect(result.reassigned.teach_sessions).toBe(1);
  });
});
