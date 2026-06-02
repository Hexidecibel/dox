/**
 * Phase P4: the linkage rule registry (entities/linkage.ts).
 *
 *   - A lot-keyed run with orderItemId binds order↔COA (reuses matching.ts).
 *   - Adding a stub rule is additive (extensibility smoke): the new rule fires
 *     through the same dispatcher without touching producers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { LINKAGE_RULES, runLinkageForLot } from '../../functions/lib/entities/linkage';
import type { LinkageRule } from '../../functions/lib/entities/linkage';
import { findOrCreateProduct } from '../../functions/lib/entities/products';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import { attachLotToCoaDocument } from '../../functions/lib/entities/matching';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('linkage registry', () => {
  it('a lot-keyed run with orderItemId binds order ↔ COA', async () => {
    const tenantId = seed.tenantId;
    const product = await findOrCreateProduct(db, tenantId, 'Linkage Product');

    // COA on file for lot LK-1.
    const docId = generateTestId();
    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, created_by) VALUES (?, ?, 'COA', ?)`)
      .bind(docId, tenantId, seed.userId)
      .run();
    await attachLotToCoaDocument(db, tenantId, {
      documentId: docId,
      lotNumber: 'LK-1',
      productId: product.id,
      supplierId: null,
      source: 'coa',
    });

    // Order line for the same product + lot.
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, 'ORD-LK', '{}')`)
      .bind(orderId, tenantId)
      .run();
    const itemId = generateTestId();
    const lot = await findOrCreateLot(db, tenantId, {
      lotNumber: 'LK-1',
      productId: product.id,
      source: 'order',
    });
    await db
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, lot_id)
         VALUES (?, ?, ?, 'Linkage Product', ?)`
      )
      .bind(itemId, orderId, product.id, lot!.id)
      .run();

    // Dispatch the lot-keyed rules.
    await runLinkageForLot(db, tenantId, {
      lotId: lot!.id,
      orderItemId: itemId,
      productId: product.id,
    });

    const item = await db
      .prepare('SELECT coa_document_id, coa_match_status FROM order_items WHERE id = ?')
      .bind(itemId)
      .first<{ coa_document_id: string | null; coa_match_status: string }>();
    expect(item!.coa_document_id).toBe(docId);
    expect(item!.coa_match_status).toBe('matched');
  });

  it('exposes the canonical lot-keyed rules in LINKAGE_RULES', () => {
    const lotRules = LINKAGE_RULES.filter((r) => r.onEntity === 'lot');
    const names = lotRules.map((r) => r.name);
    expect(names).toContain('order_item→coa (by lot)');
    expect(names).toContain('coa→order_item (by lot)');
  });

  it('adding a stub rule is additive (extensibility smoke)', async () => {
    const tenantId = seed.tenantId;
    let fired = false;

    const stub: LinkageRule = {
      name: 'stub:lot-observer',
      onEntity: 'lot',
      when: (ctx) => !!ctx.lotId,
      apply: async () => {
        fired = true;
      },
    };

    LINKAGE_RULES.push(stub);
    try {
      await runLinkageForLot(db, tenantId, { lotId: 'any-lot-id' });
      expect(fired).toBe(true);
    } finally {
      // Restore the registry so we don't leak the stub into other tests.
      const idx = LINKAGE_RULES.indexOf(stub);
      if (idx >= 0) LINKAGE_RULES.splice(idx, 1);
    }
  });

  it('a rule that throws does not block sibling rules', async () => {
    const tenantId = seed.tenantId;
    let secondFired = false;

    const thrower: LinkageRule = {
      name: 'stub:thrower',
      onEntity: 'lot',
      when: () => true,
      apply: async () => {
        throw new Error('boom');
      },
    };
    const observer: LinkageRule = {
      name: 'stub:after-thrower',
      onEntity: 'lot',
      when: () => true,
      apply: async () => {
        secondFired = true;
      },
    };

    LINKAGE_RULES.push(thrower, observer);
    try {
      await expect(
        runLinkageForLot(db, tenantId, { lotId: 'x' })
      ).resolves.toBeUndefined();
      expect(secondFired).toBe(true);
    } finally {
      for (const r of [thrower, observer]) {
        const idx = LINKAGE_RULES.indexOf(r);
        if (idx >= 0) LINKAGE_RULES.splice(idx, 1);
      }
    }
  });
});
