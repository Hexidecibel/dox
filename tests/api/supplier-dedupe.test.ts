/**
 * Supplier de-duplication backend tests.
 *
 * Covers:
 *   - isPlausibleSupplierName: accept real names, reject spreadsheet cell refs
 *     and other junk.
 *   - findOrCreateSupplier: throws ImplausibleSupplierNameError on junk; creates
 *     on a plausible name.
 *   - mergeSuppliers: reassigns plain + unique-constrained FKs from loser to
 *     winner, folds aliases, deletes the loser row.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  isPlausibleSupplierName,
  findOrCreateSupplier,
  mergeSuppliers,
  ImplausibleSupplierNameError,
} from '../../functions/lib/suppliers';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('isPlausibleSupplierName', () => {
  const accepted = [
    'Medosweet Farms',
    'West Point',
    'EggSolutions-Vanderpols Inc.',
    'National Food NW',
    'AB Foods',
    'Co', // 2 letters, no digits
  ];
  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(isPlausibleSupplierName(name)).toBe(true);
    });
  }

  const rejected = ['C2#', 'A1', 'D99', 'AB12%', '#', '12', '  ', '', '3M'];
  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(isPlausibleSupplierName(name)).toBe(false);
    });
  }
});

describe('findOrCreateSupplier — plausibility guard', () => {
  it('throws ImplausibleSupplierNameError on a spreadsheet cell ref', async () => {
    await expect(
      findOrCreateSupplier(db, seed.tenantId, 'C2#', { userId: seed.orgAdminId, ip: null })
    ).rejects.toBeInstanceOf(ImplausibleSupplierNameError);
  });

  it('throws on a digits-only value', async () => {
    await expect(
      findOrCreateSupplier(db, seed.tenantId, '12', { userId: seed.orgAdminId, ip: null })
    ).rejects.toBeInstanceOf(ImplausibleSupplierNameError);
  });

  it('creates a supplier for a plausible name', async () => {
    const name = `Plausible Supplier ${generateTestId().slice(0, 6)}`;
    const r = await findOrCreateSupplier(db, seed.tenantId, name, {
      userId: seed.orgAdminId,
      ip: null,
    });
    expect(r.created).toBe(true);
    const row = await db
      .prepare('SELECT name FROM suppliers WHERE id = ?')
      .bind(r.id)
      .first<{ name: string }>();
    expect(row?.name).toBe(name);
  });
});

describe('mergeSuppliers', () => {
  it('reassigns plain + unique FKs, folds aliases, and deletes the loser', async () => {
    const tenantId = seed.tenantId;
    const sfx = generateTestId().slice(0, 6);

    // Winner + loser suppliers.
    const winnerId = generateTestId();
    const loserId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
      .bind(winnerId, tenantId, `Winner Co ${sfx}`, `winner-${sfx}`, JSON.stringify(['Winner Alias']))
      .run();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
      .bind(loserId, tenantId, `Loser Co ${sfx}`, `loser-${sfx}`, JSON.stringify(['Loser Alias', 'Winner Alias']))
      .run();

    // --- Plain FK: a document pointing at the loser. ---
    const docId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
         VALUES (?, ?, ?, 1, 'active', ?, ?)`
      )
      .bind(docId, tenantId, `Doc ${sfx}`, seed.orgAdminId, loserId)
      .run();

    // --- Plain FK: a product pointing at the loser. ---
    const productId = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(productId, tenantId, `Prod ${sfx}`, `prod-${sfx}`, loserId)
      .run();

    // --- Unique-constrained, NON-colliding: a product_suppliers row that can
    //     move freely (winner has no equivalent). ---
    const moveProductId = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(moveProductId, tenantId, `MoveProd ${sfx}`, `moveprod-${sfx}`)
      .run();
    await db
      .prepare('INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), tenantId, moveProductId, loserId)
      .run();

    // --- Unique-constrained, COLLIDING: both winner and loser linked to the
    //     SAME product via product_suppliers (UNIQUE product_id,supplier_id).
    //     The loser row can't move (winner already there) → must be deleted. ---
    const sharedProductId = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(sharedProductId, tenantId, `SharedProd ${sfx}`, `sharedprod-${sfx}`)
      .run();
    await db
      .prepare('INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), tenantId, sharedProductId, winnerId)
      .run();
    await db
      .prepare('INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), tenantId, sharedProductId, loserId)
      .run();

    // --- Merge. ---
    const result = await mergeSuppliers(db, tenantId, {
      winnerId,
      loserIds: [loserId],
      actor: { userId: seed.orgAdminId, ip: null },
    });

    expect(result.winnerId).toBe(winnerId);
    expect(result.reassigned.documents).toBe(1);
    expect(result.reassigned.products).toBe(1);
    // One product_supplier moved (move) + one ignored-collision; UPDATE OR
    // IGNORE counts only the moved row.
    expect(result.reassigned.product_suppliers).toBe(1);

    // Document + product now point at the winner.
    const doc = await db.prepare('SELECT supplier_id FROM documents WHERE id = ?').bind(docId).first<{ supplier_id: string }>();
    expect(doc?.supplier_id).toBe(winnerId);
    const prod = await db.prepare('SELECT supplier_id FROM products WHERE id = ?').bind(productId).first<{ supplier_id: string }>();
    expect(prod?.supplier_id).toBe(winnerId);

    // The freely-movable product_suppliers row is now on the winner.
    const moved = await db
      .prepare('SELECT supplier_id FROM product_suppliers WHERE product_id = ?')
      .bind(moveProductId)
      .first<{ supplier_id: string }>();
    expect(moved?.supplier_id).toBe(winnerId);

    // The shared product has exactly one product_suppliers row left (winner) —
    // the colliding loser row was deleted, not duplicated.
    const sharedRows = await db
      .prepare('SELECT supplier_id FROM product_suppliers WHERE product_id = ?')
      .bind(sharedProductId)
      .all<{ supplier_id: string }>();
    expect(sharedRows.results).toHaveLength(1);
    expect(sharedRows.results![0].supplier_id).toBe(winnerId);

    // No product_suppliers rows reference the loser anymore.
    const loserPs = await db
      .prepare('SELECT COUNT(*) as c FROM product_suppliers WHERE supplier_id = ?')
      .bind(loserId)
      .first<{ c: number }>();
    expect(loserPs?.c).toBe(0);

    // Loser supplier row is gone.
    const loserRow = await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(loserId).first();
    expect(loserRow).toBeNull();

    // Winner's aliases folded in the loser name + its unique aliases
    // (case-insensitive dedup keeps "Winner Alias" appearing once).
    const winnerRow = await db
      .prepare('SELECT aliases FROM suppliers WHERE id = ?')
      .bind(winnerId)
      .first<{ aliases: string }>();
    const aliases = JSON.parse(winnerRow!.aliases) as string[];
    expect(aliases).toContain(`Loser Co ${sfx}`);
    expect(aliases).toContain('Loser Alias');
    // "Winner Alias" was already present — not duplicated.
    expect(aliases.filter((a) => a === 'Winner Alias')).toHaveLength(1);
    expect(result.foldedAliases).toContain(`Loser Co ${sfx}`);
    expect(result.foldedAliases).toContain('Loser Alias');
    expect(result.foldedAliases).not.toContain('Winner Alias');
  });

  it('skips losers that belong to a different tenant', async () => {
    const sfx = generateTestId().slice(0, 6);
    const winnerId = generateTestId();
    const foreignLoserId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(winnerId, seed.tenantId, `Tenant1 Winner ${sfx}`, `t1-winner-${sfx}`)
      .run();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(foreignLoserId, seed.tenantId2, `Tenant2 Loser ${sfx}`, `t2-loser-${sfx}`)
      .run();

    const result = await mergeSuppliers(db, seed.tenantId, {
      winnerId,
      loserIds: [foreignLoserId],
      actor: { userId: seed.orgAdminId, ip: null },
    });

    // Nothing folded; foreign loser still exists.
    expect(result.foldedAliases).toHaveLength(0);
    const stillThere = await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(foreignLoserId).first();
    expect(stillThere).not.toBeNull();
  });
});
