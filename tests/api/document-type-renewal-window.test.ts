/**
 * Rules table G3 (AJ, ruled 2026-09-20): a document type can renew inside a
 * fixed calendar window (migration 0125). What is defended:
 *
 *   1. The API takes a window only as a refinement of the 'period' policy,
 *      writes the cycle into renewal_interval_months, and clears it when the
 *      policy moves away from 'period'.
 *   2. A type NAMED like an FDA food facility registration starts life with the
 *      21 CFR 1.230(b) window; nothing else does.
 *   3. The renewal dashboard dates a document of a window type at the close of
 *      the next window, ignoring the date the document prints.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as putDocType } from '../../functions/api/document-types/[id]';
import { onRequestPost as createDocType } from '../../functions/api/document-types/index';
import { computeExpirations } from '../../functions/lib/expirations';
import { FDA_FOOD_FACILITY_REGISTRATION_WINDOW as FDA } from '../../shared/renewalPeriod';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
let admin: { id: string; role: string; tenant_id: string };

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
}, 30_000);

function ctx(request: Request, params: Record<string, string> = {}): any {
  return {
    request,
    env,
    data: { user: admin },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/document-types',
  };
}

async function create(body: unknown) {
  const res = await createDocType(
    ctx(
      new Request('https://portal.example.com/api/document-types', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function put(id: string, body: unknown) {
  const res = await putDocType(
    ctx(
      new Request(`https://portal.example.com/api/document-types/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
      { id },
    ),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function row(id: string) {
  return db
    .prepare('SELECT renewal_policy, renewal_interval_months, renewal_window FROM document_types WHERE id = ?')
    .bind(id)
    .first<{ renewal_policy: string; renewal_interval_months: number | null; renewal_window: string | null }>();
}

describe('creating a type', () => {
  it('an FDA food facility registration starts with the regulation window', async () => {
    const res = await create({ name: 'FDA Food Facility Registration' });
    expect(res.status).toBe(201);
    const r = await row(res.body.documentType.id);
    expect(r).toMatchObject({ renewal_policy: 'period', renewal_interval_months: 24 });
    expect(JSON.parse(r!.renewal_window!)).toEqual(FDA);
  });

  it('any other name starts with no window', async () => {
    const res = await create({ name: 'Business License' });
    expect((await row(res.body.documentType.id))!.renewal_window).toBeNull();
  });

  it('takes an explicit window and derives the cycle', async () => {
    const res = await create({
      name: 'State Dairy Permit',
      renewal_window: { opens: '06-01', closes: '06-30', every_years: 1, reference_year: 2026, source: 'State rule' },
    });
    expect(res.status).toBe(201);
    expect(await row(res.body.documentType.id)).toMatchObject({ renewal_policy: 'period', renewal_interval_months: 12 });
  });

  it('refuses a window under another policy, or with a cycle that disagrees', async () => {
    expect((await create({ name: 'X1', renewal_policy: 'none', renewal_window: FDA })).status).toBe(400);
    expect((await create({ name: 'X2', renewal_interval_months: 12, renewal_window: FDA })).status).toBe(400);
    expect((await create({ name: 'X3', renewal_window: { ...FDA, opens: '02-29' } })).status).toBe(400);
  });
});

describe('editing a type', () => {
  it('sets, keeps, and clears the window, auditing the previous one', async () => {
    const { body } = await create({ name: 'Import Permit' });
    const id = body.documentType.id as string;

    expect((await put(id, { renewal_window: FDA })).status).toBe(200);
    expect(await row(id)).toMatchObject({ renewal_policy: 'period', renewal_interval_months: 24 });

    // A PUT that does not mention the window leaves it alone.
    await put(id, { description: 'edited' });
    expect((await row(id))!.renewal_window).not.toBeNull();

    // Moving the policy away from 'period' clears it: it would be unread.
    await put(id, { renewal_policy: 'inherit' });
    expect(await row(id)).toMatchObject({ renewal_policy: 'inherit', renewal_interval_months: null, renewal_window: null });

    const audits = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'document_type_updated' AND resource_id = ? ORDER BY id`)
      .bind(id)
      .all<{ details: string }>();
    const last = JSON.parse(audits.results[audits.results.length - 1].details);
    expect(JSON.parse(last.previous_renewal_window)).toEqual(FDA);
  });

  it('null clears the window and keeps the period', async () => {
    const { body } = await create({ name: 'FDA Registration' });
    const id = body.documentType.id as string;
    await put(id, { renewal_window: null, renewal_policy: 'period', renewal_interval_months: 24 });
    expect(await row(id)).toMatchObject({ renewal_policy: 'period', renewal_interval_months: 24, renewal_window: null });
  });
});

describe('the renewal dashboard', () => {
  it('dates a window-type document at the close of the next window, whatever it prints', async () => {
    const { body } = await create({ name: 'FDA Food Facility Registration (plant 2)' });
    const typeId = body.documentType.id as string;
    const docId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, created_by, status, document_type_id, primary_metadata)
         VALUES (?, ?, 'Plant 2 registration', ?, 'active', ?, ?)`,
      )
      .bind(
        docId,
        seed.tenantId,
        seed.orgAdminId,
        typeId,
        JSON.stringify({ effective_date: '2025-03-01', document_expires_on: '2026-03-01' }),
      )
      .run();

    const res = await computeExpirations(db, seed.tenantId, '2026-11-15', 365);
    const r = res.rows.find((x) => x.id === docId);
    expect(r).toBeDefined();
    expect(r!.renewal_due_date).toBe('2026-12-31');
    expect(r!.renewal_rule).toBe('document_type_window');
  });
});
