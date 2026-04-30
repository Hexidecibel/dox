/**
 * Tests for `pollAllR2Connectors` — the scheduled per-connector
 * S3-bucket poller (Phase B3 universal-doors model).
 *
 * Each connector with a non-NULL `r2_bucket_name` opts into the poll.
 * The poller signs LIST + GET against R2's S3-compatible endpoint
 * using the connector's vendor-facing access key + decrypted secret.
 *
 * Coverage:
 *  - Lists keys in the connector's per-row bucket and dispatches a run
 *    for each new one.
 *  - Skips keys already recorded in `connector_processed_keys`.
 *  - Skips connectors where `active = 0`.
 *  - Skips connectors with NULL `r2_bucket_name` (not yet provisioned).
 *  - Per-tick budget caps the global dispatch volume.
 *
 * The CF API is stubbed via `globalThis.fetch`. The R2 LIST/GET calls
 * also flow through `fetch` (via aws4fetch), so the same stub serves
 * both. Other fetch traffic falls through to the real network /
 * miniflare.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  pollAllR2Connectors,
  MAX_FILES_PER_TICK,
  parseListKeys,
} from '../../functions/lib/connectors/pollR2';
import { encryptIntakeSecret } from '../../functions/lib/intakeEncryption';

const TEST_INTAKE_KEY =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: { enabled: true, required: true, source_labels: ['Order #', 'order_number'] },
      customer_number: { enabled: true, required: false, source_labels: ['Cust #', 'customer_number'] },
      customer_name: { enabled: true, required: false, source_labels: ['Customer Name', 'customer_name'] },
    },
    extended: [],
  };
}

/**
 * Insert a connector with the provided bucket + (encrypted) creds.
 * Returns the inserted id and bucket so tests can wire fake R2
 * responses.
 */
async function insertProvisionedConnector(opts: {
  tenantId: string;
  bucket: string | null;
  active?: number;
}): Promise<string> {
  const id = generateTestId();
  let encryptedSecret: string | null = null;
  if (opts.bucket) {
    encryptedSecret = await encryptIntakeSecret(`secret-${id}`, {
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });
  }
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, system_type,
                               config, field_mappings, active,
                               r2_bucket_name, r2_access_key_id,
                               r2_secret_access_key_encrypted,
                               r2_cf_token_id,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', '{}', ?, ?,
               ?, ?, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `poll-test-${id}`,
      `poll-test-${id.slice(0, 8)}`,
      JSON.stringify(defaultMappings()),
      opts.active ?? 1,
      opts.bucket,
      opts.bucket ? `key-${id}` : null,
      encryptedSecret,
      opts.bucket ? `tok-${id}` : null,
    )
    .run();
  return id;
}

/**
 * Build an S3-compatible ListObjectsV2 XML response containing the
 * given keys. Matches the shape R2 returns.
 */
function makeListXml(bucket: string, keys: string[]): string {
  const contents = keys
    .map((k) => `<Contents><Key>${k}</Key><Size>10</Size></Contents>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>${bucket}</Name>
<KeyCount>${keys.length}</KeyCount>
<MaxKeys>1000</MaxKeys>
<IsTruncated>false</IsTruncated>
${contents}
</ListBucketResult>`;
}

interface BucketState {
  /** key -> CSV body */
  contents: Record<string, string>;
}

/**
 * Stub globalThis.fetch to handle requests against R2's S3-compat
 * endpoint for the buckets configured here. Returns a restore() to
 * put the original fetch back. Anything not matching the
 * `*.r2.cloudflarestorage.com` host bypasses the stub.
 */
function stubR2Fetch(buckets: Record<string, BucketState>): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const m = url.match(/^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!m) return original(input as any, init);
    const bucket = m[1];
    const path = m[2] ? m[2].slice(1) : '';
    const state = buckets[bucket];
    if (!state) {
      return new Response('No such bucket', { status: 404 });
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && (path === '' || path === undefined)) {
      // LIST
      return new Response(makeListXml(bucket, Object.keys(state.contents)), {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    if (method === 'GET' && path) {
      const decoded = decodeURIComponent(path);
      const body = state.contents[decoded];
      if (body === undefined) return new Response('No such key', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    }
    return new Response('Unsupported', { status: 405 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let _stub: { restore: () => void } | null = null;

beforeEach(async () => {
  // Reset poller-relevant state between tests so no prior connector
  // eats the per-tick budget. We can't DELETE connector rows because
  // of FK constraints from connector_runs, so we deactivate the test
  // rows by name prefix. processed_keys gets nuked outright.
  await db.prepare(`DELETE FROM connector_processed_keys`).run();
  await db
    .prepare(`UPDATE connectors SET active = 0 WHERE name LIKE 'poll-test-%'`)
    .run();
});

afterEach(() => {
  if (_stub) {
    _stub.restore();
    _stub = null;
  }
});

describe('parseListKeys', () => {
  it('extracts keys from an S3 LIST XML envelope', () => {
    const xml = makeListXml('bkt', ['a.csv', 'sub/b.csv', 'c & d.csv']);
    expect(parseListKeys(xml)).toEqual(['a.csv', 'sub/b.csv', 'c & d.csv']);
  });

  it('returns [] for an empty envelope', () => {
    const xml = makeListXml('bkt', []);
    expect(parseListKeys(xml)).toEqual([]);
  });
});

describe('pollAllR2Connectors — per-bucket scanning', () => {
  it('dispatches runs for new keys, skips already-processed keys', async () => {
    const bucket = `dox-drops-test-${generateTestId().slice(0, 8)}`;
    _stub = stubR2Fetch({
      [bucket]: {
        contents: {
          'a.csv': 'Order #,Cust #,Customer Name\nSO-A-1,K-1,Acme',
          'b.csv': 'Order #,Cust #,Customer Name\nSO-B-1,K-2,Beta',
          'c.csv': 'Order #,Cust #,Customer Name\nSO-C-1,K-3,Charlie',
        },
      },
    });

    const connectorId = await insertProvisionedConnector({
      tenantId: seed.tenantId,
      bucket,
    });

    // Pre-mark `a.csv` as already processed — only b + c should fire.
    await db
      .prepare(
        `INSERT INTO connector_processed_keys (id, connector_id, r2_key, processed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateTestId(), connectorId, 'a.csv', Date.now())
      .run();

    const summary = await pollAllR2Connectors({
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'testacct',
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });

    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours).toBeTruthy();
    expect(ours!.listed).toBe(3);
    expect(ours!.dispatched).toBe(2);
    expect(ours!.skipped_already_processed).toBe(1);
    expect(ours!.errors).toEqual([]);

    // Two new dedup rows for this connector (plus the one we pre-seeded).
    const dedupRow = await db
      .prepare(
        `SELECT COUNT(*) as count FROM connector_processed_keys WHERE connector_id = ?`,
      )
      .bind(connectorId)
      .first<{ count: number }>();
    expect(dedupRow?.count).toBe(3);

    // Two connector_runs for this connector tagged source=s3.
    const runs = await db
      .prepare(
        `SELECT COUNT(*) as count FROM connector_runs
          WHERE connector_id = ? AND source = 's3'`,
      )
      .bind(connectorId)
      .first<{ count: number }>();
    expect(runs?.count).toBe(2);

    // Re-running should be a no-op for this connector.
    const summary2 = await pollAllR2Connectors({
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'testacct',
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });
    const ours2 = summary2.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours2?.dispatched ?? 0).toBe(0);
    expect(ours2?.skipped_already_processed ?? 0).toBe(3);
  });

  it('ignores inactive connectors', async () => {
    const bucket = `dox-drops-inactive-${generateTestId().slice(0, 8)}`;
    _stub = stubR2Fetch({
      [bucket]: { contents: { 'only.csv': 'Order #\nSO-IN-1' } },
    });
    const connectorId = await insertProvisionedConnector({
      tenantId: seed.tenantId,
      bucket,
      active: 0,
    });
    const summary = await pollAllR2Connectors({
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'testacct',
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });
    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours).toBeUndefined();
  });

  it('ignores connectors with no provisioned bucket', async () => {
    const connectorId = await insertProvisionedConnector({
      tenantId: seed.tenantId,
      bucket: null,
    });
    const summary = await pollAllR2Connectors({
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'testacct',
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });
    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours).toBeUndefined();
  });

  it('caps total dispatched files at MAX_FILES_PER_TICK', async () => {
    expect(MAX_FILES_PER_TICK).toBeGreaterThan(0);
    const bucket = `dox-drops-cap-${generateTestId().slice(0, 8)}`;
    const overshoot = MAX_FILES_PER_TICK + 5;
    const contents: Record<string, string> = {};
    for (let i = 0; i < overshoot; i++) {
      contents[`cap-${String(i).padStart(3, '0')}.csv`] =
        `Order #,Cust #,Customer Name\nSO-CAP-${i},K-CAP,CapCorp`;
    }
    _stub = stubR2Fetch({ [bucket]: { contents } });

    const connectorId = await insertProvisionedConnector({
      tenantId: seed.tenantId,
      bucket,
    });

    const summary = await pollAllR2Connectors({
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'testacct',
      INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
    });
    expect(summary.total_dispatched).toBe(MAX_FILES_PER_TICK);
    expect(summary.truncated).toBe(true);
    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours?.dispatched).toBe(MAX_FILES_PER_TICK);
  });
});
