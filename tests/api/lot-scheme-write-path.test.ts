/**
 * A declared lot format on the WRITE path (migration 0110).
 *
 *   - declarations are append-only versions; a bad one is refused; resolution is
 *     per tenant
 *   - a lot row with no stated production date takes the decode, labelled
 *     'lot_decode' with the declaration that produced it
 *   - a stated date is never overwritten; decode ≠ stated is 'conflict' with both
 *   - a composite lot is split by the declared widths, on the certificate side
 *     and on the order side (through the line's product's single supplier)
 *   - an undeclared supplier is byte-identical to before
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import {
  declareLotScheme,
  loadResolvedLotScheme,
  LotSchemeValidationError,
  listLotSchemeVersions,
} from '../../functions/lib/lot-schemes';
import { ingestOrders } from '../../functions/lib/kinds/order';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';
import { resolveProductionDate } from '../../shared/lotProductionDate';
import type { ConnectorOutput } from '../../functions/lib/connectors/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const DARIGOLD = LOT_SCHEME_TEMPLATES.plant_yy_julian.spec;
const CMF = LOT_SCHEME_TEMPLATES.best_by_mmddyy_suffix.spec;

async function supplier(tenantId: string, name: string, lotScheme = 'auto'): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, lot_scheme) VALUES (?, ?, ?, ?, ?)')
    .bind(id, tenantId, name, `s-${id.slice(0, 8)}`, lotScheme)
    .run();
  return id;
}

async function lotRow(id: string) {
  return db.prepare('SELECT * FROM lots WHERE id = ?').bind(id).first<Record<string, string | null>>();
}

const stated = (raw: string) => ({ ...resolveProductionDate({ production_date: raw })!, documentId: 'doc-x' });

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('declarations', () => {
  it('appends versions, refuses a bad spec, and writes nothing for an identical save', async () => {
    const sup = await supplier(seed.tenantId, 'Darigold, Inc.');
    const first = await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: DARIGOLD, source: 'admin', userId: seed.orgAdminId });
    expect(first.row.version).toBe(1);
    expect(first.unchanged).toBe(false);
    const again = await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: DARIGOLD, source: 'admin', userId: seed.orgAdminId });
    expect(again.unchanged).toBe(true);
    const second = await declareLotScheme(db, {
      tenantId: seed.tenantId, supplierId: sup, source: 'admin', userId: seed.orgAdminId,
      spec: { ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 3, values: ['103', '104', '121', '220'] }, ...DARIGOLD.segments!.slice(1)] },
    });
    expect(second.row.version).toBe(2);
    expect(second.previous?.version).toBe(1);
    await expect(
      declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: { ...DARIGOLD, date_role: null }, source: 'admin' }),
    ).rejects.toBeInstanceOf(LotSchemeValidationError);
    const versions = await listLotSchemeVersions(db, seed.tenantId, sup);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('resolves the latest declaration, falls back to the legacy enum, and never crosses tenants', async () => {
    const declared = await supplier(seed.tenantId, 'Darigold, Inc.');
    const legacy = await supplier(seed.tenantId, 'Country Morning Farms', 'date_code');
    await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: declared, spec: DARIGOLD, source: 'seed' });

    const r = await loadResolvedLotScheme(db, seed.tenantId, declared);
    expect(r.source).toBe('declared');
    expect(r.version).toBe(1);
    expect(r.supplier_name).toBe('Darigold, Inc.');

    const l = await loadResolvedLotScheme(db, seed.tenantId, legacy);
    expect(l.source).toBe('legacy');
    expect(l.legacy).toBe('date_code');

    // The same supplier id asked for from another tenant resolves to nothing declared.
    const other = await loadResolvedLotScheme(db, seed.tenantId2, declared);
    expect(other.source).toBe('legacy');
    expect(other.scheme_id).toBeNull();
  });
});

describe('findOrCreateLot with a declared production-role format', () => {
  async function darigold() {
    const sup = await supplier(seed.tenantId, 'Darigold, Inc.');
    await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: DARIGOLD, source: 'seed' });
    return { sup, scheme: await loadResolvedLotScheme(db, seed.tenantId, sup) };
  }

  it('fills a missing production date from the lot code, labelled lot_decode with its declaration', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426212', supplierId: sup, lotScheme: scheme, documentId: 'doc-1', source: 'coa' });
    const row = await lotRow(lot!.id);
    expect(row).toMatchObject({
      production_date: '2026-07-31',
      production_date_source: 'lot_decode',
      production_date_status: 'resolved',
      production_date_document_id: 'doc-1',
      production_date_scheme_id: scheme.scheme_id,
    });
    expect(row!.production_date_raw).toBe('lot 10426212 decodes to 2026-07-31');
  });

  it('keeps a stated date that agrees, as extracted', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203', subLotCode: '03', supplierId: sup, lotScheme: scheme, productionDate: stated('22-Jul-2026') });
    const row = await lotRow(lot!.id);
    expect(row).toMatchObject({ production_date: '2026-07-22', production_date_source: 'extracted', production_date_raw: '22-Jul-2026', production_date_scheme_id: null });
  });

  it('flags a stated date that disagrees: conflict, no day, both values kept', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426204', subLotCode: '13', supplierId: sup, lotScheme: scheme, productionDate: stated('22-Jul-2026') });
    const row = await lotRow(lot!.id);
    expect(row!.production_date).toBeNull();
    expect(row!.production_date_status).toBe('conflict');
    expect(row!.production_date_source).toBe('extracted');
    expect(row!.production_date_raw).toBe('22-Jul-2026 | lot 10426204 decodes to 2026-07-23');
  });

  it('never overwrites an extracted value with a later decode; a disagreeing decode is a conflict', async () => {
    const { sup, scheme } = await darigold();
    const first = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203', subLotCode: '03', supplierId: sup, productionDate: stated('2026-07-22') });
    // Same lot, a certificate that states nothing — the decode agrees: untouched.
    await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203', subLotCode: '03', supplierId: sup, lotScheme: scheme });
    expect(await lotRow(first!.id)).toMatchObject({ production_date: '2026-07-22', production_date_source: 'extracted', production_date_raw: '2026-07-22' });

    const other = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426205', supplierId: sup, productionDate: stated('2026-07-22') });
    await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426205', supplierId: sup, lotScheme: scheme });
    const row = await lotRow(other!.id);
    expect(row!.production_date_status).toBe('conflict');
    expect(row!.production_date_raw).toBe('2026-07-22 | lot 10426205 decodes to 2026-07-24');
  });

  it('a stated value arriving on a decoded row: same day upgrades to extracted, a different day is a conflict', async () => {
    const { sup, scheme } = await darigold();
    const a = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426212', supplierId: sup, lotScheme: scheme });
    await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426212', supplierId: sup, lotScheme: scheme, productionDate: stated('07/31/2026') });
    expect(await lotRow(a!.id)).toMatchObject({ production_date: '2026-07-31', production_date_source: 'extracted', production_date_raw: '07/31/2026', production_date_scheme_id: null });

    const b = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426213', supplierId: sup, lotScheme: scheme });
    // Without the scheme in hand (e.g. an ingest path): the stated value alone.
    await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426213', supplierId: sup, productionDate: stated('2026-07-30') });
    const row = await lotRow(b!.id);
    expect(row!.production_date_status).toBe('conflict');
    expect(row!.production_date_raw).toBe('lot 10426213 decodes to 2026-08-01 | 2026-07-30');
  });

  it('leaves an ambiguous stated value ambiguous: a decode does not settle what the page printed', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426124', supplierId: sup, lotScheme: scheme, productionDate: stated('04-05-2026') });
    expect(await lotRow(lot!.id)).toMatchObject({ production_date: null, production_date_status: 'ambiguous', production_date_source: 'extracted' });
  });

  it('decodes nothing for a lot that does not fit (K134889)', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'K134889', supplierId: sup, lotScheme: scheme });
    expect(await lotRow(lot!.id)).toMatchObject({ lot_key: 'K134889', production_date: null, production_date_status: null });
  });

  it('splits a composite by the declared widths', async () => {
    const { sup, scheme } = await darigold();
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203-03', supplierId: sup, lotScheme: scheme });
    expect(await lotRow(lot!.id)).toMatchObject({ lot_key: '1042620303', sub_lot_code: '03', production_date: '2026-07-22' });
    // The same lot named with a separate sublot is the same row.
    const again = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203', subLotCode: '03', supplierId: sup, lotScheme: scheme });
    expect(again!.id).toBe(lot!.id);
  });

  it('writes no production date for a best-by format (CMF)', async () => {
    const sup = await supplier(seed.tenantId, 'Country Morning Farms', 'date_code');
    await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: CMF, source: 'seed' });
    const scheme = await loadResolvedLotScheme(db, seed.tenantId, sup);
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '092326WHO', supplierId: sup, lotScheme: scheme });
    expect(await lotRow(lot!.id)).toMatchObject({ lot_key: '092326', sub_lot_code: '', production_date: null });
  });

  it('an undeclared supplier keys exactly as before', async () => {
    const sup = await supplier(seed.tenantId, 'Andersen Dairy Inc.');
    const scheme = await loadResolvedLotScheme(db, seed.tenantId, sup);
    const lot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '10426203-03', supplierId: sup, lotScheme: scheme });
    expect(await lotRow(lot!.id)).toMatchObject({ lot_key: '1042620303', sub_lot_code: '', production_date: null });
  });
});

describe('order side', () => {
  const report = (lot: string, product: string): ConnectorOutput => ({
    orders: [{ order_number: `SO-${lot}`, customer_number: null, customer_name: null, items: [{ product_name: product, lot_number: lot, quantity: 1 }], source_data: {}, _confidence: 1 }],
    customers: [],
    errors: [],
    info: [],
  }) as unknown as ConnectorOutput;

  it("splits a WMS composite with the declared format of the product's supplier", async () => {
    const sup = await supplier(seed.tenantId, 'Darigold, Inc.');
    await declareLotScheme(db, { tenantId: seed.tenantId, supplierId: sup, spec: DARIGOLD, source: 'seed' });
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active, supplier_id) VALUES ('p-2235', ?, 'DG BTR BULK U/S', 'p-2235', 1, ?)`).bind(seed.tenantId, sup).run();
    await ingestOrders(db, report('1042620303', 'DG BTR BULK U/S'), { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });
    const lot = await db.prepare(`SELECT lot_key, sub_lot_code, production_date_source FROM lots WHERE tenant_id = ? AND lot_number = '1042620303'`).bind(seed.tenantId).first();
    expect(lot).toMatchObject({ lot_key: '1042620303', sub_lot_code: '03', production_date_source: 'lot_decode' });
  });

  it('is unchanged when the product has no supplier with a declared format', async () => {
    await ingestOrders(db, report('1042620304', 'SOME PRODUCT'), { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });
    const lot = await db.prepare(`SELECT lot_key, sub_lot_code, production_date FROM lots WHERE tenant_id = ? AND lot_number = '1042620304'`).bind(seed.tenantId).first();
    expect(lot).toMatchObject({ lot_key: '1042620304', sub_lot_code: '', production_date: null });
  });
});
