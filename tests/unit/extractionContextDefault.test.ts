/**
 * The default industry layer stopped being one tenant's dairy playbook, and
 * nobody's extraction moved when it did (migration 0136).
 *
 * WHAT IS PINNED, AND AGAINST WHAT
 * The dangerous half of this change is the half nobody would see: a tenant with
 * no stored `extraction_context` used to get the dairy text from a constant,
 * and now gets a generic block. 0136 writes the dairy text into every such
 * tenant first. "The same text" is not taken on trust here:
 *
 *   - the SHA-256 values below were computed from the code as it stood BEFORE
 *     the change (`git show 6290dc9:functions/lib/llm.ts` / `bin/process-worker`),
 *     so the comparison is against what was live, not against a constant that
 *     moved together with the thing it is supposed to check;
 *   - the migration is RUN, and what lands in the column is compared;
 *   - the fully assembled prompt of a migrated tenant is hashed and compared
 *     with the fully assembled prompt the old default produced.
 *
 * The two prompt surfaces carried different copies of the default (one line of
 * the worked example), which is why there are two "before" hashes and a small
 * read-back shim; see DAIRY_CONTEXT_AS_MIGRATED in functions/lib/llm.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import m0136 from '../../migrations/0136_pin_default_extraction_context.sql?raw';
import processWorkerSource from '../../bin/process-worker?raw';
import { splitStatements, seedTestData, cleanTables } from '../helpers/db';
import {
  buildPrompt,
  DAIRY_CONTEXT_AS_MIGRATED,
  DAIRY_CONTEXT_TEMPLATE,
  DEFAULT_DAIRY_CONTEXT,
  EXTRACTION_CONTEXT_TEMPLATES,
  GENERIC_INDUSTRY_CONTEXT,
  industryLayerForThisSurface,
  isMigratedDefaultContext,
  stripUnfilledPlaceholders,
} from '../../functions/lib/llm';
import { onRequestGet as getContext } from '../../functions/api/tenant-extraction-context/index';
import { loadTeachBackground } from '../../functions/lib/teach/background';
import { scanSource } from './noFirstTenantValues.scan';

/** bin/process-worker's built-in default before the change. */
const WORKER_DEFAULT_BEFORE = 'c08d718421a1d94e7e89f032433debbb515ae7d8c68d705a2ce36cffb9000608';
/** functions/lib/llm.ts INDUSTRY_PROMPTS.DAIRY_FOOD before the change. */
const PAGES_DEFAULT_BEFORE = '6b41021d9834057c006674322658499a4c8c9a2408fbba6dd648362629e4c342';
/** llm.ts buildPrompt() with no arguments, before the change: base rules + the default layer. */
const PAGES_PROMPT_BEFORE = 'b73143ecc47c735a38367828201368ecf751b335f83273c0f645519e5f7bbcd5';
/** ... and with a classified type and authored guidance, so the other layers are in the comparison too. */
const PAGES_PROMPT_BEFORE_TYPED = '37ecfb1a388aed75a76e486dcbfdc7b4f8bac66c4967e4041aa65ff860459c3c';
const TYPED = { documentType: 'Certificate of Analysis', instructions: 'Look at the header.' };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const db = env.DB;

async function addTenant(id: string, context: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, extraction_context, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, `Tenant ${id}`, id, context)
    .run();
}

async function contextOf(id: string) {
  return db
    .prepare(
      `SELECT extraction_context AS context, extraction_context_updated_at AS at, extraction_context_updated_by AS by
         FROM tenants WHERE id = ?`,
    )
    .bind(id)
    .first<{ context: string | null; at: string | null; by: string | null }>();
}

async function applyMigration(): Promise<number> {
  let changed = 0;
  for (const statement of splitStatements(m0136)) {
    const res = await db.prepare(statement).run();
    changed += res.meta.changes ?? 0;
  }
  return changed;
}

describe('migration 0136 pins the context every existing tenant was extracting with', () => {
  beforeAll(async () => {
    await cleanTables(db);
    await addTenant('ctx-null', null);
    await addTenant('ctx-empty', '');
    await addTenant('ctx-blank', '   \n');
    await addTenant('ctx-own', 'ORG CONTEXT:\nWe import spices.');
  });

  it('is plain ASCII from the first byte to the last, and one statement', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(m0136)).toBe(false);
    expect(splitStatements(m0136)).toHaveLength(1);
  });

  it('writes the worker flavour of the dairy text where there was none, and stamps nobody', async () => {
    expect(await applyMigration()).toBe(2);
    for (const id of ['ctx-null', 'ctx-empty']) {
      const row = await contextOf(id);
      expect(row!.context, id).toBe(DAIRY_CONTEXT_AS_MIGRATED);
      // Nobody edited anything: "Last edited by" must stay blank.
      expect(row!.at, id).toBeNull();
      expect(row!.by, id).toBeNull();
    }
  });

  it('leaves a context somebody wrote alone -- including a blank one, which was never a fallback', async () => {
    expect((await contextOf('ctx-own'))!.context).toBe('ORG CONTEXT:\nWe import spices.');
    expect((await contextOf('ctx-blank'))!.context).toBe('   \n');
  });

  it('is idempotent', async () => {
    expect(await applyMigration()).toBe(0);
  });

  it('stored exactly what the worker was sending before', async () => {
    const stored = (await contextOf('ctx-null'))!.context!;
    expect(await sha256(stored)).toBe(WORKER_DEFAULT_BEFORE);
  });

  it('and the Pages surface reads that stored text back as exactly what IT was sending before', async () => {
    const stored = (await contextOf('ctx-null'))!.context!;
    expect(await sha256(industryLayerForThisSurface(stored))).toBe(PAGES_DEFAULT_BEFORE);
    expect(await sha256(DAIRY_CONTEXT_TEMPLATE)).toBe(PAGES_DEFAULT_BEFORE);
    // The two copies differ on one line and nothing else.
    const a = DAIRY_CONTEXT_TEMPLATE.split('\n');
    const b = stored.split('\n');
    expect(a.length).toBe(b.length);
    const different = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
    expect(different).toEqual([['  "_confidence": "high",', '  "_confidence": 0.95,']]);
  });

  it('the fully assembled prompt of a migrated tenant is the prompt the old default produced', async () => {
    const stored = (await contextOf('ctx-null'))!.context!;
    expect(await sha256(buildPrompt({ industryPrompt: stored }))).toBe(PAGES_PROMPT_BEFORE);
    expect(await sha256(buildPrompt({ industryPrompt: stored, ...TYPED }))).toBe(PAGES_PROMPT_BEFORE_TYPED);
  });

  it('the teach interview still sees "nothing authored" for a migrated tenant, as it did for NULL', async () => {
    const key = { supplierId: 'none', documentTypeId: 'none' };
    expect((await loadTeachBackground(db, { tenantId: 'ctx-null', ...key })).tenantContext).toBe('');
    expect((await loadTeachBackground(db, { tenantId: 'ctx-own', ...key })).tenantContext).toBe('ORG CONTEXT:\nWe import spices.');
  });

  it('recognises what it stored by fingerprint, so rewording the template later cannot orphan a migrated tenant', async () => {
    const stored = (await contextOf('ctx-null'))!.context!;
    expect(isMigratedDefaultContext(stored)).toBe(true);
    expect(isMigratedDefaultContext(stored + ' ')).toBe(false);
    expect(isMigratedDefaultContext(DAIRY_CONTEXT_TEMPLATE)).toBe(false);
    expect(isMigratedDefaultContext('')).toBe(false);
    expect(isMigratedDefaultContext(null)).toBe(false);
  });

  it('an EDITED context is never swapped for a template', () => {
    const edited = DAIRY_CONTEXT_AS_MIGRATED + '\n- We also buy eggs.';
    expect(industryLayerForThisSurface(edited)).toBe(edited);
    expect(industryLayerForThisSurface('anything else')).toBe('anything else');
  });
});

describe('the worker falls back to the same generic block, and nothing else', () => {
  const workerGeneric = () => {
    const m = processWorkerSource.match(/const GENERIC_INDUSTRY_PROMPT = `([\s\S]*?)`;/);
    expect(m, 'GENERIC_INDUSTRY_PROMPT not found in bin/process-worker').toBeTruthy();
    return m![1];
  };

  it('carries a byte-identical generic block', () => {
    expect(workerGeneric()).toBe(GENERIC_INDUSTRY_CONTEXT);
  });

  it('uses it in both prompt builders and has no built-in dairy default left', () => {
    expect(processWorkerSource.match(/stripUnfilledPlaceholders\(tenantContext \|\| GENERIC_INDUSTRY_PROMPT\)/g)).toHaveLength(2);
    expect(processWorkerSource).not.toMatch(/const DAIRY_FOOD_INDUSTRY_PROMPT/);
    expect(processWorkerSource).not.toMatch(/tenantContext \|\| DAIRY/);
  });

  it('a stored context reaches the worker prompt untouched, so a migrated tenant sends what it sent', () => {
    // The worker has no read-back shim and needs none: 0136 stored its own text.
    expect(processWorkerSource).not.toMatch(/industryLayerForThisSurface|DAIRY_CONTEXT_AS_MIGRATED/);
  });
});

describe('a NEW tenant gets a block that assumes nothing about what it buys', () => {
  const assembled = buildPrompt();

  it('is the default when no context is passed, or an empty one', () => {
    expect(assembled).toContain('GENERAL CONTEXT — supplier documents:');
    expect(buildPrompt({ industryPrompt: undefined })).toBe(assembled);
    expect(assembled).not.toContain('INDUSTRY CONTEXT — Dairy & Food:');
  });

  it('says nothing about dairy and names nobody', () => {
    expect(GENERIC_INDUSTRY_CONTEXT).not.toMatch(/dairy|milk|butter|cream|cheese|somatic/i);
    expect(scanSource('functions/lib/generic-context.txt', GENERIC_INDUSTRY_CONTEXT)).toEqual([]);
  });

  it('keeps every hard rule the dairy template carries', () => {
    const rules = (text: string) =>
      text
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.split(/[.:;—]/)[0].trim());
    const generic = rules(GENERIC_INDUSTRY_CONTEXT);
    for (const lead of [
      '- Lab consumables are NEVER product data',
      '- Certification / legal boilerplate numbers are reference, not results',
      '- Capture specifications verbatim',
      '- Result is not the spec',
      '- Lot is the most important field and keys every record',
      '- A missing required pathogen result (Listeria, Salmonella) is a GAP, not a pass',
      '- Capture yeast/mold and sensory (flavor / color / odor) exactly as printed',
      '- Normalize dates to YYYY-MM-DD',
    ]) {
      expect(generic, lead).toContain(lead);
      expect(rules(DAIRY_CONTEXT_TEMPLATE), lead).toContain(lead);
    }
  });

  it('drops the editor placeholder from the wire and keeps the worked example whole', () => {
    const stripped = stripUnfilledPlaceholders(GENERIC_INDUSTRY_CONTEXT);
    expect(GENERIC_INDUSTRY_CONTEXT).toContain('[Describe your organization');
    expect(stripped).not.toContain('ORG CONTEXT:');
    expect(stripped).not.toContain('[Describe your organization');
    expect(stripped).toContain('["Standard Plate Count", "AOAC 989.10", "<20,000", "4,500", "CFU/g", "Pass"]');
    expect(stripped).toContain('EXAMPLE — COA extraction:');
  });

  it('leaves the confidence scale to each surface: the example states none', () => {
    // The Pages surface reads high / medium / low and the worker reads a number.
    // An example that printed either would teach one surface the wrong scale --
    // exactly how the two dairy copies came to differ.
    expect(GENERIC_INDUSTRY_CONTEXT).not.toContain('_confidence');
  });
});

describe('the dairy text is a template a person loads', () => {
  it('is offered by name, and the old export still resolves to it', () => {
    expect(EXTRACTION_CONTEXT_TEMPLATES.map((t) => t.key)).toEqual(['dairy']);
    expect(EXTRACTION_CONTEXT_TEMPLATES[0].text).toBe(DAIRY_CONTEXT_TEMPLATE);
    expect(DEFAULT_DAIRY_CONTEXT).toBe(DAIRY_CONTEXT_TEMPLATE);
  });

  it('GET /api/tenant-extraction-context returns the templates, the generic block and the old field', async () => {
    await cleanTables(db);
    const seed = await seedTestData(db);
    const res = await getContext({
      request: new Request(`http://localhost/api/tenant-extraction-context`),
      env,
      data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
      params: {},
    } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.extraction_context).toBeNull();
    expect(body.generic_context).toBe(GENERIC_INDUSTRY_CONTEXT);
    expect(body.templates).toEqual([{ key: 'dairy', label: 'Dairy & food', text: DAIRY_CONTEXT_TEMPLATE }]);
    // Backward compatible: an older client seeds its one button from this.
    expect(body.default_template).toBe(DAIRY_CONTEXT_TEMPLATE);
  });
});
