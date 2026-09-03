/**
 * /api/tenant-setup and /api/starter-packs — the first-run wizard's position
 * marker and its seeding door.
 *
 * The things worth pinning here are the ones that would quietly ruin the flow
 * rather than break it loudly:
 *
 *   * RESUMABILITY. A run left at screen 4 must come back at screen 4. This is
 *     the entire reason the wizard does not follow `SourceWizard.tsx`, where a
 *     reload loses everything.
 *   * ONE DRAFT. Pressing Start twice, or opening /setup in a second tab, must
 *     resume rather than fork a second half-finished walk-through. The partial
 *     unique index is the guard; this proves the endpoint honours it.
 *   * THE `needed` CONJUNCTION. True only when there is no completed run AND no
 *     documents. Either half alone gives a wrong answer somebody would notice.
 *   * IDEMPOTENT SEEDING. Applying a pack twice must insert nothing the second
 *     time, on the SAME deterministic ids `bin/create-tenant` writes — otherwise
 *     a tenant seeded by the CLI and then walked through the wizard doubles up.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables } from '../helpers/db';
import {
  onRequestGet as getSetup,
  onRequestPost as postSetup,
} from '../../functions/api/tenant-setup/index';
import { onRequestPatch as patchSetup } from '../../functions/api/tenant-setup/[id]';
import { onRequestGet as getPacks } from '../../functions/api/starter-packs/index';
import { onRequestPost as applyPack } from '../../functions/api/starter-packs/apply';
import { packRowId } from '../../functions/lib/starter-packs';
import { STARTER_PACKS } from '../../functions/lib/starterPacks.generated';
import type {
  ApplyStarterPackResponse,
  StarterPackCatalogResponse,
  TenantSetupResponse,
  TenantSetupRunResponse,
} from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

/**
 * The handler's own context type, borrowed rather than restated — a hand-typed
 * stand-in drifts the moment Pages Functions change shape, and one cast at the
 * boundary is cheaper than `any` at every call site.
 */
type HandlerContext = Parameters<typeof getSetup>[0];

function ctx(
  method: string,
  url: string,
  user: unknown,
  body?: unknown,
  params: Record<string, string> = {},
): HandlerContext {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(`https://portal.example.com${url}`, init),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: url,
  } as unknown as HandlerContext;
}

function admin() {
  return { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId, email: 'orgadmin@test.com' };
}

function otherAdmin() {
  return { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2, email: 'orgadmin2@test.com' };
}

async function makeDocument(title: string): Promise<string> {
  const id = `doc-${Math.random().toString(36).slice(2, 10)}`;
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
       VALUES (?, ?, ?, 1, 'active', ?)`,
    )
    .bind(id, seed.tenantId, title, seed.orgAdminId)
    .run();
  return id;
}

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('GET /api/tenant-setup — should the wizard be offered', () => {
  it('offers it on an untouched tenant, with no run to show', async () => {
    const res = await getSetup(ctx('GET', '/api/tenant-setup', admin()));
    const body = (await res.json()) as TenantSetupResponse;
    expect(res.status).toBe(200);
    expect(body.needed).toBe(true);
    expect(body.reason).toBe('never_run');
    expect(body.run).toBeNull();
    expect(body.document_count).toBe(0);
  });

  it('does NOT nag a tenant that has documents but never saw a wizard', async () => {
    await makeDocument('An existing certificate');
    const res = await getSetup(ctx('GET', '/api/tenant-setup', admin()));
    const body = (await res.json()) as TenantSetupResponse;
    expect(body.needed).toBe(false);
    expect(body.reason).toBe('has_documents');
    expect(body.document_count).toBe(1);
  });

  it('does NOT re-prompt an empty tenant that finished the wizard', async () => {
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    await patchSetup(
      ctx('PATCH', `/api/tenant-setup/${created.run.id}`, admin(), { status: 'completed' }, { id: created.run.id }),
    );

    const body = (await (
      await getSetup(ctx('GET', '/api/tenant-setup', admin()))
    ).json()) as TenantSetupResponse;
    expect(body.needed).toBe(false);
    expect(body.reason).toBe('already_completed');
    expect(body.has_completed_run).toBe(true);
    // The completed run is still returned — "who set this up, and when" is
    // answerable without a second request.
    expect(body.run?.status).toBe('completed');
  });

  it('reports a draft as in_progress, which still counts as needed', async () => {
    await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}));
    const body = (await (
      await getSetup(ctx('GET', '/api/tenant-setup', admin()))
    ).json()) as TenantSetupResponse;
    expect(body.needed).toBe(true);
    expect(body.reason).toBe('in_progress');
  });

  it('refuses a reader', async () => {
    const res = await getSetup(
      ctx('GET', '/api/tenant-setup', { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/tenant-setup — one draft, resumed not forked', () => {
  it('returns the existing draft on a second call rather than creating another', async () => {
    const first = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    const second = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;

    expect(second.run.id).toBe(first.run.id);
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM tenant_setup_runs WHERE tenant_id = ?`)
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('restart abandons the draft and opens a fresh one, keeping the old row as history', async () => {
    const first = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    const restarted = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), { restart: true }))
    ).json()) as TenantSetupRunResponse;

    expect(restarted.run.id).not.toBe(first.run.id);

    const all = await db
      .prepare(`SELECT id, status FROM tenant_setup_runs WHERE tenant_id = ? ORDER BY started_at`)
      .bind(seed.tenantId)
      .all<{ id: string; status: string }>();
    const byId = new Map((all.results ?? []).map((r) => [r.id, r.status]));
    expect(byId.get(first.run.id)).toBe('abandoned');
    expect(byId.get(restarted.run.id)).toBe('draft');
    // The partial unique index means exactly one draft survives, whatever else
    // accumulates.
    expect([...byId.values()].filter((s) => s === 'draft')).toHaveLength(1);
  });
});

describe('PATCH /api/tenant-setup/:id — resumability', () => {
  it('remembers the screen somebody left on', async () => {
    // 1. A person starts the wizard.
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    expect(created.run.current_step).toBe(1);

    // 2. They walk to screen 3; the debounced autosave lands.
    const patched = (await (
      await patchSetup(
        ctx(
          'PATCH',
          `/api/tenant-setup/${created.run.id}`,
          admin(),
          { current_step: 3, state: { selected_pack: 'fsqa' } },
          { id: created.run.id },
        ),
      )
    ).json()) as TenantSetupRunResponse;
    expect(patched.run.current_step).toBe(3);

    // 3. They close the tab and come back. This is the whole point.
    const resumed = (await (
      await getSetup(ctx('GET', '/api/tenant-setup', admin()))
    ).json()) as TenantSetupResponse;
    expect(resumed.run?.id).toBe(created.run.id);
    expect(resumed.run?.current_step).toBe(3);
    expect(resumed.run?.state).toEqual({ selected_pack: 'fsqa' });
    expect(resumed.reason).toBe('in_progress');
  });

  it('clamps a step outside the range this build has instead of failing to load', async () => {
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    const patched = (await (
      await patchSetup(
        ctx('PATCH', `/api/tenant-setup/${created.run.id}`, admin(), { current_step: 99 }, { id: created.run.id }),
      )
    ).json()) as TenantSetupRunResponse;
    expect(patched.run.current_step).toBe(6);
  });

  it('refuses to re-open a completed run', async () => {
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    await patchSetup(
      ctx('PATCH', `/api/tenant-setup/${created.run.id}`, admin(), { status: 'completed' }, { id: created.run.id }),
    );
    const res = await patchSetup(
      ctx('PATCH', `/api/tenant-setup/${created.run.id}`, admin(), { status: 'draft' }, { id: created.run.id }),
    );
    expect(res.status).toBe(400);
  });

  it('will not let an admin of another tenant touch the run', async () => {
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;
    const res = await patchSetup(
      ctx('PATCH', `/api/tenant-setup/${created.run.id}`, otherAdmin(), { current_step: 5 }, { id: created.run.id }),
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/starter-packs — the catalog', () => {
  it('reports each pack with its own counts and three real example rows', async () => {
    const res = await getPacks(ctx('GET', '/api/starter-packs', admin()));
    const body = (await res.json()) as StarterPackCatalogResponse;
    const fsqa = body.packs.find((p) => p.pack === 'fsqa');
    expect(fsqa).toBeTruthy();

    const types = fsqa!.sections.find((s) => s.key === 'document_types');
    expect(types?.count).toBe(STARTER_PACKS.fsqa.document_types.length);
    expect(types?.examples).toEqual(
      STARTER_PACKS.fsqa.document_types.slice(0, 3).map((d) => d.name),
    );
    // Nothing on a card is copy: every example is a row from the pack.
    for (const example of types!.examples) {
      expect(STARTER_PACKS.fsqa.document_types.some((d) => d.name === example)).toBe(true);
    }
  });

  it('lists requirement packets as defined-but-not-applied, with the reason', async () => {
    const body = (await (
      await getPacks(ctx('GET', '/api/starter-packs', admin()))
    ).json()) as StarterPackCatalogResponse;
    const packets = body.packs
      .find((p) => p.pack === 'fsqa')!
      .sections.find((s) => s.key === 'requirement_packets');
    expect(packets?.seeded).toBe(false);
    expect(packets?.not_seeded_reason).toMatch(/one supplier/i);
  });

  it('names the document types behind each department, for screen 3s sentence', async () => {
    const body = (await (
      await getPacks(ctx('GET', '/api/starter-packs', admin()))
    ).json()) as StarterPackCatalogResponse;
    const fsqa = body.packs.find((p) => p.pack === 'fsqa')!;
    const insurance = fsqa.owner_labels.find((o) => o.label === 'Insurance');
    expect(insurance).toBeTruthy();
    expect(insurance!.owner_key).toBe('insurance');
    // Every named type really does default to that department in the pack.
    for (const name of insurance!.document_types) {
      const dt = STARTER_PACKS.fsqa.document_types.find((d) => d.name === name);
      expect(dt?.owner).toBe('Insurance');
    }
  });

  it('carries the pack’s module opinion, its teaching example and its packets in full', async () => {
    const body = (await (
      await getPacks(ctx('GET', '/api/starter-packs', admin()))
    ).json()) as StarterPackCatalogResponse;
    const fsqa = body.packs.find((p) => p.pack === 'fsqa')!;

    // Screen 2 shows the pack's OPINION beside the tenant's state, so the two
    // can visibly differ. Passed through verbatim — an unrecognised key must
    // not fail the response, it is filtered at the point of use.
    expect(fsqa.modules).toEqual(STARTER_PACKS.fsqa.modules);

    // Screen 6 offers the bundled sample and has to handle it being null: a
    // path that does not resolve is a broken screen, so the pack leaves it null
    // until a real file ships and the catalog reports that honestly.
    expect(fsqa.teach).not.toBeNull();
    expect(fsqa.teach!.sample_file).toBe(STARTER_PACKS.fsqa.teach!.sample_file);

    // The packets in FULL, not just counted: the closing action applies one to
    // one named supplier and has to say which line items that means.
    expect(fsqa.packets).toHaveLength(STARTER_PACKS.fsqa.requirement_packets.length);
    const baseline = fsqa.packets.find((p) => p.slug === 'baseline')!;
    expect(baseline.requirements).toEqual(
      STARTER_PACKS.fsqa.requirement_packets.find((p) => p.slug === 'baseline')!.requirements,
    );
  });

  it('carries the renewal window the alert engine actually uses', async () => {
    const body = (await (
      await getPacks(ctx('GET', '/api/starter-packs', admin()))
    ).json()) as StarterPackCatalogResponse;
    expect(body.renewal_window_days).toBe(60);
  });
});

describe('POST /api/starter-packs/apply — write-through, idempotent', () => {
  it('seeds the tenant on the deterministic ids bin/create-tenant uses', async () => {
    const res = await applyPack(
      ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }),
    );
    const body = (await res.json()) as ApplyStarterPackResponse;
    expect(res.status).toBe(200);
    expect(body.inserted).toBeGreaterThan(0);
    expect(body.counts.document_types).toBe(STARTER_PACKS.fsqa.document_types.length);

    // 'test-corp' is the seeded tenant's slug; the id must match exactly what
    // the CLI compiler would emit, or a later CLI re-run duplicates every row.
    const first = STARTER_PACKS.fsqa.document_types[0];
    const row = await db
      .prepare('SELECT id, name, default_owner FROM document_types WHERE id = ?')
      .bind(packRowId('dt', 'test-corp', first.slug))
      .first<{ id: string; name: string; default_owner: string | null }>();
    expect(row?.name).toBe(first.name);
    expect(row?.default_owner).toBe(first.owner);
  });

  it('adds nothing on a second run, and says so', async () => {
    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));
    const second = (await (
      await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }))
    ).json()) as ApplyStarterPackResponse;
    expect(second.inserted).toBe(0);

    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM document_types WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(count?.n).toBe(STARTER_PACKS.fsqa.document_types.length);
  });

  it('never overwrites an edit somebody made to a seeded row', async () => {
    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));
    const id = packRowId('dt', 'test-corp', STARTER_PACKS.fsqa.document_types[0].slug);
    await db.prepare('UPDATE document_types SET name = ? WHERE id = ?').bind('Renamed By A Human', id).run();

    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));

    const row = await db
      .prepare('SELECT name FROM document_types WHERE id = ?')
      .bind(id)
      .first<{ name: string }>();
    expect(row?.name).toBe('Renamed By A Human');
  });

  it('writes owner labels, type→checklist defaults and the module decision', async () => {
    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));

    const labels = await db
      .prepare('SELECT COUNT(*) AS n FROM owner_labels WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(labels?.n).toBe(STARTER_PACKS.fsqa.owner_labels.length);

    const defaults = await db
      .prepare('SELECT COUNT(*) AS n FROM document_type_requirements WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(defaults?.n).toBe(
      STARTER_PACKS.fsqa.document_types.reduce((n, d) => n + d.closes.length, 0),
    );

    // Both sides of the module decision are recorded, not only the off ones.
    const modules = await db
      .prepare('SELECT module_key, enabled FROM tenant_modules WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .all<{ module_key: string; enabled: number }>();
    const byKey = new Map((modules.results ?? []).map((m) => [m.module_key, m.enabled]));
    for (const key of STARTER_PACKS.fsqa.modules.default_on) expect(byKey.get(key)).toBe(1);
    for (const key of STARTER_PACKS.fsqa.modules.default_off) expect(byKey.get(key)).toBe(0);
  });

  it('seeds NO supplier requirements — a packet is applied one supplier at a time', async () => {
    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM supplier_requirements WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('seeds NO owner routes — a route needs a real recipient, which the pack cannot know', async () => {
    await applyPack(ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa' }));
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM owner_routes WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('stamps the run ledger so screen 1 can render as a summary next time', async () => {
    const created = (await (
      await postSetup(ctx('POST', '/api/tenant-setup', admin(), {}))
    ).json()) as TenantSetupRunResponse;

    const body = (await (
      await applyPack(
        ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'fsqa', run_id: created.run.id }),
      )
    ).json()) as ApplyStarterPackResponse;

    expect(body.run?.pack).toBe('fsqa');
    expect(body.run?.applied.pack?.name).toBe('fsqa');
    expect(body.run?.applied.pack?.already_seeded).toBe(false);
  });

  it('rejects an unknown pack rather than silently doing nothing', async () => {
    const res = await applyPack(
      ctx('POST', '/api/starter-packs/apply', admin(), { pack: 'no-such-pack' }),
    );
    expect(res.status).toBe(404);
  });
});
