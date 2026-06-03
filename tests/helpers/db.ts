// Database helpers for tests — migration runner, seed data, cleanup.
// Runs inside the Workers pool (cloudflare:test). No Node.js fs access.
// Migration SQL is loaded via Vite ?raw imports.

import m0001 from '../../migrations/0001_initial_schema.sql?raw';
import m0002 from '../../migrations/0002_seed_admin.sql?raw';
import m0003 from '../../migrations/0003_indexes.sql?raw';
import m0004 from '../../migrations/0004_rate_limits.sql?raw';
import m0005 from '../../migrations/0005_password_resets.sql?raw';
import m0006 from '../../migrations/0006_force_password_change.sql?raw';
import m0007 from '../../migrations/0007_external_ref.sql?raw';
import m0008 from '../../migrations/0008_api_keys.sql?raw';
import m0009 from '../../migrations/0009_document_content.sql?raw';
import m0010 from '../../migrations/0010_products.sql?raw';
import m0011 from '../../migrations/0011_document_types.sql?raw';
import m0012 from '../../migrations/0012_structured_metadata.sql?raw';
import m0013 from '../../migrations/0013_document_products.sql?raw';
import m0014 from '../../migrations/0014_naming_templates.sql?raw';
import m0015 from '../../migrations/0015_email_domain_mappings.sql?raw';
import m0016 from '../../migrations/0016_document_bundles.sql?raw';
import m0017 from '../../migrations/0017_tenant_specific_products.sql?raw';
import m0018 from '../../migrations/0018_document_type_naming_and_extraction.sql?raw';
import m0019 from '../../migrations/0019_smart_upload_and_queue.sql?raw';
import m0020 from '../../migrations/0020_email_domain_default_doctype.sql?raw';
import m0021 from '../../migrations/0021_extraction_example_supplier.sql?raw';
import m0022 from '../../migrations/0022_suppliers_and_dynamic_metadata.sql?raw';
import m0023a from '../../migrations/0023_multi_product_fields.sql?raw';
import m0023b from '../../migrations/0023_processing_status.sql?raw';
import m0024 from '../../migrations/0024_queue_doctype_guess.sql?raw';
import m0025 from '../../migrations/0025_doctype_feature_toggles.sql?raw';
import m0026 from '../../migrations/0026_extraction_templates.sql?raw';
import m0027 from '../../migrations/0027_email_ingest_log.sql?raw';
import m0028 from '../../migrations/0028_product_supplier.sql?raw';
import m0029 from '../../migrations/0029_queue_source.sql?raw';
import m0030 from '../../migrations/0030_connectors_and_orders.sql?raw';
import m0031 from '../../migrations/0031_customer_contacts.sql?raw';
import m0032 from '../../migrations/0032_order_metadata_and_field_mappings.sql?raw';
import m0033 from '../../migrations/0033_connector_sample_ref.sql?raw';
import m0034 from '../../migrations/0034_vlm_extraction_fields.sql?raw';
import m0035 from '../../migrations/0035_supplier_extraction_instructions.sql?raw';
import m0036 from '../../migrations/0036_extraction_evaluations.sql?raw';
import m0037 from '../../migrations/0037_connector_soft_delete.sql?raw';
import m0038 from '../../migrations/0038_reviewer_decisions.sql?raw';
import m0039 from '../../migrations/0039_learned_field_hints.sql?raw';
import m0046 from '../../migrations/0046_connector_processed_keys.sql?raw';
import m0047 from '../../migrations/0047_connector_intake_credentials.sql?raw';
import m0048 from '../../migrations/0048_drop_connector_type.sql?raw';
import m0049 from '../../migrations/0049_connector_runs_source.sql?raw';
import m0050 from '../../migrations/0050_connector_slug.sql?raw';
import m0051 from '../../migrations/0051_connector_r2_cf_token_id.sql?raw';
import m0052 from '../../migrations/0052_connector_run_retry_link.sql?raw';
import m0053 from '../../migrations/0053_drop_connector_system_type.sql?raw';
import m0054 from '../../migrations/0054_fts_search.sql?raw';
import m0055 from '../../migrations/0055_search_reindex_queue.sql?raw';
import m0056 from '../../migrations/0056_fix_fts_view_nulls.sql?raw';
import m0057 from '../../migrations/0057_saved_searches.sql?raw';
import m0058 from '../../migrations/0058_drop_extraction_evaluations.sql?raw';
import m0059 from '../../migrations/0059_staged_extraction_routing.sql?raw';
import m0060 from '../../migrations/0060_connector_extraction_corrections.sql?raw';
import m0061 from '../../migrations/0061_connector_extraction_instructions.sql?raw';
import m0062 from '../../migrations/0062_processing_queue_confidence.sql?raw';
import m0063 from '../../migrations/0063_processing_queue_attempts.sql?raw';
import m0064 from '../../migrations/0064_product_suppliers.sql?raw';
import m0065 from '../../migrations/0065_lots.sql?raw';
import m0066 from '../../migrations/0066_order_item_lot_linking.sql?raw';
import m0067 from '../../migrations/0067_queue_source_routing.sql?raw';
import m0068 from '../../migrations/0068_extraction_profiles_and_internal_suppliers.sql?raw';
import m0069 from '../../migrations/0069_document_types_supplier_scope.sql?raw';
import m0070 from '../../migrations/0070_teach_sessions.sql?raw';

const migrations: string[] = [
  m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010,
  m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020,
  m0021, m0022, m0023a, m0023b, m0024, m0025, m0026, m0027, m0028, m0029,
  m0030, m0031, m0032, m0033, m0034, m0035, m0036, m0037, m0038, m0039,
  m0046, m0047, m0048, m0049, m0050, m0051, m0052, m0053, m0054, m0055,
  m0056, m0057, m0058, m0059, m0060, m0061, m0062, m0063,
  m0064, m0065, m0066, m0067, m0068, m0069, m0070,
];

/**
 * Split a SQL file into individual statements.
 * Strips comment lines and inline comments, then splits on semicolons.
 */
function splitStatements(sql: string): string[] {
  const lines = sql.split('\n');
  const cleanedLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    const commentIdx = line.indexOf('--');
    if (commentIdx >= 0) {
      const before = line.substring(0, commentIdx);
      const quoteCount = (before.match(/'/g) || []).length;
      if (quoteCount % 2 === 0) {
        cleanedLines.push(before);
        continue;
      }
    }
    cleanedLines.push(line);
  }

  const cleaned = cleanedLines.join('\n');
  const statements: string[] = [];
  let current = '';
  let inString = false;
  // Track BEGIN/END nesting depth so trigger bodies (which contain
  // statement-terminating semicolons of their own) are not split apart.
  let blockDepth = 0;
  const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  const matchKeywordAt = (pos: number, kw: string): boolean => {
    if (pos > 0 && isWordChar(cleaned[pos - 1])) return false;
    const end = pos + kw.length;
    if (end > cleaned.length) return false;
    if (cleaned.substring(pos, end).toUpperCase() !== kw) return false;
    if (end < cleaned.length && isWordChar(cleaned[end])) return false;
    return true;
  };

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      if (cleaned[i + 1] === "'") {
        current += "''";
        i++;
      } else {
        inString = false;
        current += ch;
      }
    } else if (!inString && (ch === 'B' || ch === 'b') && matchKeywordAt(i, 'BEGIN')) {
      blockDepth++;
      current += cleaned.substring(i, i + 5);
      i += 4;
    } else if (!inString && (ch === 'E' || ch === 'e') && matchKeywordAt(i, 'END')) {
      if (blockDepth > 0) blockDepth--;
      current += cleaned.substring(i, i + 3);
      i += 2;
    } else if (ch === ';' && !inString && blockDepth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

/**
 * Run all migrations in order against the provided D1 database.
 *
 * Tracks applied migrations in a `_test_migrations` table so a second
 * call to this function (e.g. from a per-test-file `beforeAll`) is a
 * no-op — re-running CREATE-then-RENAME-style migrations on a populated
 * DB can desynchronize the schema, especially once views (added in
 * migration 0054) reference tables that those migrations recreate.
 */
export async function runMigrations(db: D1Database): Promise<void> {
  // Ensure the tracking table exists. Use an integer index (matches the
  // migrations[] array position) since these are anonymous SQL strings.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _test_migrations (
        idx INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    )
    .run();

  const appliedRows = await db
    .prepare('SELECT idx FROM _test_migrations')
    .all<{ idx: number }>();
  const applied = new Set((appliedRows.results ?? []).map((r) => r.idx));

  for (let i = 0; i < migrations.length; i++) {
    if (applied.has(i)) continue;

    const statements = splitStatements(migrations[i]);
    for (const stmt of statements) {
      try {
        await db.prepare(stmt).run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('already exists') ||
          msg.includes('UNIQUE constraint') ||
          msg.includes('duplicate column name') ||
          msg.includes('no such table') ||
          msg.includes('no such column')
        ) {
          continue;
        }
        console.error(`Migration ${i} error: ${msg}`);
        console.error(`Statement: ${stmt.substring(0, 200)}`);
        throw err;
      }
    }

    await db
      .prepare('INSERT OR IGNORE INTO _test_migrations (idx) VALUES (?)')
      .bind(i)
      .run();
  }
}

/**
 * Seed standard test data: two tenants, users at each role level.
 */
export async function seedTestData(db: D1Database) {
  const tenantId = 'test-tenant-001';
  const tenantId2 = 'test-tenant-002';

  await db
    .prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`)
    .bind(tenantId, 'Test Corp', 'test-corp')
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`)
    .bind(tenantId2, 'Other Corp', 'other-corp')
    .run();

  const adminHash = await hashTestPassword('Admin1234');

  const superAdminId = 'user-super-admin';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, NULL, ?, 1, 0)`)
    .bind(superAdminId, 'admin@test.com', 'Super Admin', 'super_admin', adminHash)
    .run();

  const orgAdminId = 'user-org-admin';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .bind(orgAdminId, 'orgadmin@test.com', 'Org Admin', 'org_admin', tenantId, adminHash)
    .run();

  const userId = 'user-regular';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .bind(userId, 'user@test.com', 'Regular User', 'user', tenantId, adminHash)
    .run();

  const readerId = 'user-reader';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .bind(readerId, 'reader@test.com', 'Reader User', 'reader', tenantId, adminHash)
    .run();

  const orgAdmin2Id = 'user-org-admin-2';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .bind(orgAdmin2Id, 'orgadmin2@test.com', 'Org Admin 2', 'org_admin', tenantId2, adminHash)
    .run();

  const inactiveId = 'user-inactive';
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`)
    .bind(inactiveId, 'inactive@test.com', 'Inactive User', 'user', tenantId, adminHash)
    .run();

  return {
    tenantId, tenantId2, superAdminId, orgAdminId, userId, readerId, orgAdmin2Id, inactiveId,
  };
}

/**
 * Hash a password using PBKDF2 (mirrors functions/lib/auth.ts).
 */
export async function hashTestPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const toHex = (buffer: ArrayBuffer): string =>
    Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

export function generateTestId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function cleanTables(db: D1Database): Promise<void> {
  const tables = [
    'audit_log', 'lot_match_suggestions', 'document_lots',
    'order_items', 'orders', 'document_versions', 'document_products', 'documents',
    'document_types', 'naming_templates', 'email_domain_mappings',
    'bundle_documents', 'bundles', 'api_keys', 'sessions',
    'password_resets', 'rate_limits', 'users', 'lots', 'products',
    'product_suppliers', 'tenant_products', 'suppliers', 'tenants', 'site_settings',
  ];
  for (const table of tables) {
    try {
      await db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // Table might not exist yet
    }
  }
}
