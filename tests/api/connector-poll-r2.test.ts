/**
 * Tests for `pollAllR2Connectors` — the scheduled R2-prefix poller.
 *
 * Phase B0 universal-doors model: any active connector with a non-empty
 * `config.r2_prefix` opts into the R2 poller — there's no per-row type
 * gate. The poller still dispatches via `executeConnectorRun` with
 * `input.type = 'file_watch'`, which is the correct intake-path
 * discriminator regardless of the connector's other doors.
 *
 * Coverage:
 *  - Lists R2 objects under the connector's `config.r2_prefix` and
 *    dispatches a run for each new key.
 *  - Skips keys already recorded in `connector_processed_keys`.
 *  - Skips connectors where `active = 0`.
 *  - Skips connectors with an empty / missing `r2_prefix`.
 *  - Per-tick budget: caps total dispatched files across all connectors.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  pollAllR2Connectors,
  MAX_FILES_PER_TICK,
} from '../../functions/lib/connectors/pollR2';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
const r2 = env.FILES;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: {
        enabled: true,
        required: true,
        source_labels: ['Order #', 'order_number'],
      },
      customer_number: {
        enabled: true,
        required: false,
        source_labels: ['Cust #', 'customer_number'],
      },
      customer_name: {
        enabled: true,
        required: false,
        source_labels: ['Customer Name', 'customer_name'],
      },
    },
    extended: [],
  };
}

async function insertPollableConnector(opts: {
  tenantId: string;
  prefix: string | null;
  active?: number;
}): Promise<string> {
  const id = generateTestId();
  const config: Record<string, unknown> = {};
  if (opts.prefix !== null) config.r2_prefix = opts.prefix;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type,
                               config, field_mappings, active,
                               created_at, updated_at)
       VALUES (?, ?, ?, 'erp', ?, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `poll-test-${id}`,
      JSON.stringify(config),
      JSON.stringify(defaultMappings()),
      opts.active ?? 1,
    )
    .run();
  return id;
}

async function putCsv(key: string, rows: string[]): Promise<void> {
  const csv = ['Order #,Cust #,Customer Name', ...rows].join('\n');
  await r2.put(key, csv, {
    httpMetadata: { contentType: 'text/csv' },
  });
}

async function clearR2Prefix(prefix: string): Promise<void> {
  // miniflare's R2 supports list+delete; we walk the prefix in case
  // earlier tests left objects behind.
  const list = await r2.list({ prefix, limit: 1000 });
  for (const obj of list.objects) {
    await r2.delete(obj.key);
  }
}

beforeEach(async () => {
  // Each test scopes itself to a unique prefix so leftover state from
  // prior tests in the same file doesn't bleed across. We also flip any
  // previously-created file_watch connectors to active=0 so they don't
  // eat the per-tick dispatch budget when the cap test runs. Deleting
  // them is impossible without first cascading orders/order_items, so
  // deactivation is the cheapest reset that keeps the SQL FKs happy.
  await db.prepare(`DELETE FROM connector_processed_keys`).run();
  await db.prepare(`UPDATE connectors SET active = 0 WHERE name LIKE 'poll-test-%'`).run();
});

describe('pollAllR2Connectors', () => {
  it('dispatches runs for new keys, skips already-processed keys', async () => {
    const prefix = `imports/poll-dedup-${generateTestId()}/`;
    await clearR2Prefix(prefix);
    const connectorId = await insertPollableConnector({
      tenantId: seed.tenantId,
      prefix,
    });

    // Drop 3 objects under the prefix.
    await putCsv(`${prefix}a.csv`, ['SO-A-1,K-1,Acme']);
    await putCsv(`${prefix}b.csv`, ['SO-B-1,K-2,Beta']);
    await putCsv(`${prefix}c.csv`, ['SO-C-1,K-3,Charlie']);

    // Pre-mark `a.csv` as already processed — only b + c should fire.
    await db
      .prepare(
        `INSERT INTO connector_processed_keys (id, connector_id, r2_key, processed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateTestId(), connectorId, `${prefix}a.csv`, Date.now())
      .run();

    const summary = await pollAllR2Connectors(env);

    // Find the per-connector summary for our connector.
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

    // Two connector_runs for this connector.
    const runs = await db
      .prepare(
        `SELECT COUNT(*) as count FROM connector_runs WHERE connector_id = ?`,
      )
      .bind(connectorId)
      .first<{ count: number }>();
    expect(runs?.count).toBe(2);

    // Re-running the poll should be a no-op for this connector now.
    const summary2 = await pollAllR2Connectors(env);
    const ours2 = summary2.per_connector.find((p) => p.connector_id === connectorId);
    // It will appear in per_connector because it still has a non-empty
    // prefix, but with zero dispatch.
    expect(ours2?.dispatched ?? 0).toBe(0);
    expect(ours2?.skipped_already_processed ?? 0).toBe(3);
  });

  it('ignores inactive connectors', async () => {
    const prefix = `imports/poll-inactive-${generateTestId()}/`;
    await clearR2Prefix(prefix);
    const connectorId = await insertPollableConnector({
      tenantId: seed.tenantId,
      prefix,
      active: 0,
    });
    await putCsv(`${prefix}only.csv`, ['SO-IN-1,K-1,Acme']);

    const summary = await pollAllR2Connectors(env);
    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours).toBeUndefined();
  });

  it('ignores connectors with no r2_prefix configured', async () => {
    const connectorId = await insertPollableConnector({
      tenantId: seed.tenantId,
      prefix: null,
    });
    const summary = await pollAllR2Connectors(env);
    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours).toBeUndefined();
  });

  it('caps total dispatched files at MAX_FILES_PER_TICK', async () => {
    expect(MAX_FILES_PER_TICK).toBeGreaterThan(0);

    const prefix = `imports/poll-cap-${generateTestId()}/`;
    await clearR2Prefix(prefix);
    const connectorId = await insertPollableConnector({
      tenantId: seed.tenantId,
      prefix,
    });

    // Drop MAX_FILES_PER_TICK + 5 objects so we exercise the cap.
    const overshoot = MAX_FILES_PER_TICK + 5;
    for (let i = 0; i < overshoot; i++) {
      await putCsv(
        `${prefix}cap-${String(i).padStart(3, '0')}.csv`,
        [`SO-CAP-${i},K-CAP,CapCorp`],
      );
    }

    const summary = await pollAllR2Connectors(env);
    expect(summary.total_dispatched).toBe(MAX_FILES_PER_TICK);
    expect(summary.truncated).toBe(true);

    const ours = summary.per_connector.find((p) => p.connector_id === connectorId);
    expect(ours?.dispatched).toBe(MAX_FILES_PER_TICK);
  });
});
