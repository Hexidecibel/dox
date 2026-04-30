import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Connectors - Create', () => {
  it('should create a connector with required fields', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Test Connector', 'erp', seed.orgAdminId)
      .run();

    const c = await db.prepare('SELECT * FROM connectors WHERE id = ?').bind(id).first();
    expect(c).not.toBeNull();
    expect(c!.name).toBe('Test Connector');
    expect(c!.system_type).toBe('erp');
    expect(c!.active).toBe(1);
  });

  // Phase B0: connector_type column was dropped (migration 0048). The
  // historical "create each valid connector type" / "reject invalid
  // connector_type" / CHECK-constraint tests no longer apply — rephrased
  // as "the column does not exist" sanity guard so a future regression
  // (someone adding the column back) surfaces here.
  it('connector_type column has been dropped', async () => {
    let threw = false;
    try {
      await db.prepare('SELECT connector_type FROM connectors LIMIT 1').first();
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg.toLowerCase()).toMatch(/no such column/);
    }
    expect(threw).toBe(true);
  });

  it('should store config and field_mappings as JSON', async () => {
    const id = generateTestId();
    const config = JSON.stringify({ host: 'erp.example.com', port: 443 });
    const fieldMappings = JSON.stringify({ order_number: 'ordNum', customer: 'custName' });

    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'erp', ?, ?, 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Config Connector', config, fieldMappings, seed.orgAdminId)
      .run();

    const c = await db.prepare('SELECT config, field_mappings FROM connectors WHERE id = ?').bind(id).first();
    expect(JSON.parse(c!.config as string).host).toBe('erp.example.com');
    expect(JSON.parse(c!.field_mappings as string).order_number).toBe('ordNum');
  });

  it('should store encrypted credentials', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, credentials_encrypted, credentials_iv, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'erp', '{}', '{}', ?, ?, 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Cred Connector', 'encrypted_data_here', 'iv_here', seed.orgAdminId)
      .run();

    const c = await db.prepare('SELECT credentials_encrypted, credentials_iv FROM connectors WHERE id = ?').bind(id).first();
    expect(c!.credentials_encrypted).toBe('encrypted_data_here');
    expect(c!.credentials_iv).toBe('iv_here');
  });
});

describe('Connectors - List', () => {
  it('should list active connectors for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM connectors WHERE tenant_id = ? AND active = 1 ORDER BY name ASC')
      .bind(seed.tenantId)
      .all();

    for (const c of result.results) {
      expect(c.tenant_id).toBe(seed.tenantId);
      expect(c.active).toBe(1);
    }
  });

  it('should not show inactive connectors by default', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'other', '{}', '{}', 0, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Inactive Connector', seed.orgAdminId)
      .run();

    const result = await db
      .prepare('SELECT * FROM connectors WHERE tenant_id = ? AND active = 1')
      .bind(seed.tenantId)
      .all();

    const found = result.results.find((c) => c.id === id);
    expect(found).toBeUndefined();
  });

  // Phase B0: connector_type column was dropped — the historical
  // "filter by connector_type" test no longer has a column to filter on.
  // The new universal-doors model filters email-routing candidates at
  // run time via the match-email handler (presence of subject_patterns
  // / sender_filter on the row), not via a per-row type tag.
});

describe('Connectors - Get by ID', () => {
  it('should get connector without exposing credentials', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, credentials_encrypted, credentials_iv, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'erp', '{}', '{}', 'secret', 'iv', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Get Test', seed.orgAdminId)
      .run();

    const c = await db.prepare('SELECT * FROM connectors WHERE id = ?').bind(id).first();
    expect(c).not.toBeNull();

    // The handler transforms: strips credentials, adds has_credentials flag
    // We verify the raw data has credentials
    expect(c!.credentials_encrypted).toBe('secret');
    expect(c!.credentials_iv).toBe('iv');

    // Simulating the transformConnector logic from the handler
    const hasCreds = !!(c!.credentials_encrypted && c!.credentials_iv);
    expect(hasCreds).toBe(true);
  });

  it('should return null for non-existent connector', async () => {
    const c = await db.prepare('SELECT * FROM connectors WHERE id = ?').bind('nonexistent').first();
    expect(c).toBeNull();
  });
});

describe('Connectors - Update', () => {
  let connId: string;

  beforeAll(async () => {
    connId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'erp', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(connId, seed.tenantId, 'Update Connector', seed.orgAdminId)
      .run();
  });

  it('should update name', async () => {
    await db.prepare("UPDATE connectors SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('New Name', connId).run();
    const c = await db.prepare('SELECT name FROM connectors WHERE id = ?').bind(connId).first();
    expect(c!.name).toBe('New Name');
  });

  it('should update config', async () => {
    const config = JSON.stringify({ updated: true });
    await db.prepare("UPDATE connectors SET config = ?, updated_at = datetime('now') WHERE id = ?").bind(config, connId).run();
    const c = await db.prepare('SELECT config FROM connectors WHERE id = ?').bind(connId).first();
    expect(JSON.parse(c!.config as string).updated).toBe(true);
  });

  it('should update active status', async () => {
    await db.prepare("UPDATE connectors SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(connId).run();
    const c = await db.prepare('SELECT active FROM connectors WHERE id = ?').bind(connId).first();
    expect(c!.active).toBe(0);
  });
});

describe('Connectors - Soft Delete', () => {
  it('should set active to 0', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'other', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'Delete Connector', seed.orgAdminId)
      .run();

    await db.prepare("UPDATE connectors SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
    const c = await db.prepare('SELECT active FROM connectors WHERE id = ?').bind(id).first();
    expect(c!.active).toBe(0);
  });
});

describe('Connectors - Runs', () => {
  it('should track connector run records', async () => {
    const connId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'erp', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(connId, seed.tenantId, 'Run Connector', seed.orgAdminId)
      .run();

    const runId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connector_runs (id, connector_id, tenant_id, status, records_found, records_created, started_at, created_at)
         VALUES (?, ?, ?, 'success', 10, 5, datetime('now'), datetime('now'))`
      )
      .bind(runId, connId, seed.tenantId)
      .run();

    const run = await db.prepare('SELECT * FROM connector_runs WHERE id = ?').bind(runId).first();
    expect(run).not.toBeNull();
    expect(run!.status).toBe('success');
    expect(run!.records_found).toBe(10);
    expect(run!.records_created).toBe(5);
  });
});
