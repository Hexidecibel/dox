/**
 * Three switches promised a behaviour that does not exist.
 *
 * Nothing in dox files a document without a person (a deliberate decision,
 * 2026-06-02; tests/api/queue-results-auto-approve.test.ts guards the removal).
 * Three settings from before that decision were still on screens, each
 * offering to turn it back on:
 *
 *   tenants.auto_approve_threshold            Admin > Tenants
 *   document_types.auto_ingest                Admin > Document Types
 *   extraction_templates.auto_ingest_enabled  the "save as template" dialogs
 *
 * A control nobody reads is worse than no control: an admin sets 0.9, reads
 * "auto-approves only very high-confidence extractions", and believes it.
 *
 * WHAT IS PINNED: the controls are gone, the screens no longer SEND the three
 * keys (so an unrelated edit cannot overwrite a stored value), the help text
 * promises nothing, and the columns and API fields are still there -- stored
 * values are history, and an API client that sends one keeps working.
 *
 * NOT COVERED: src/pages/admin/SupplierDetail.tsx still carries the template
 * and document-type switches. That file belongs to a parallel piece of work;
 * it is listed below so the gap is visible and closes with one line.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import tenantsPage from '../../src/pages/admin/Tenants.tsx?raw';
import documentTypesPage from '../../src/pages/admin/DocumentTypes.tsx?raw';
import reviewQueuePage from '../../src/pages/ReviewQueue.tsx?raw';
import importPage from '../../src/pages/Import.tsx?raw';
import learningPage from '../../src/pages/admin/LearningDashboard.tsx?raw';
import helpContent from '../../src/lib/helpContent.ts?raw';
import tenantApi from '../../functions/api/tenants/[id].ts?raw';
import documentTypeApi from '../../functions/api/document-types/[id].ts?raw';
import templateApi from '../../functions/api/extraction-templates/index.ts?raw';
import { stripCodeComments } from './noFirstTenantValues.scan';

/** Code only: the comments explaining the removal mention what was removed. */
const code = (source: string) => stripCodeComments(source);

/** Screens still to do, with why. Remove an entry when its screen is cleaned. */
const STILL_SHOWN: Array<{ path: string; reason: string }> = [
  {
    path: 'src/pages/admin/SupplierDetail.tsx',
    reason: 'Template "Enable auto-ingest" and document-type "Auto-ingest" switches; the file is owned by the approved-items workstream.',
  },
];

describe('the dead switches are off the screens', () => {
  it('Tenants: no auto-approve threshold, and the key is not sent', () => {
    const src = code(tenantsPage);
    expect(src).not.toMatch(/auto-approve/i);
    expect(src).not.toContain('auto_approve_threshold');
  });

  it('Document Types: no auto-ingest switch, and the key is not sent', () => {
    const src = code(documentTypesPage);
    expect(src).not.toMatch(/auto-?ingest/i);
    expect(src).not.toContain('auto_ingest');
  });

  it('the "save as template" dialogs: no auto-ingest section, no threshold slider, neither key sent', () => {
    for (const [name, page] of [['ReviewQueue', reviewQueuePage], ['Import', importPage]] as const) {
      const src = code(page);
      expect(src, name).not.toContain('Enable auto-ingest');
      expect(src, name).not.toContain('autoIngestEnabled');
      expect(src, name).not.toContain('auto_ingest_enabled');
      expect(src, name).not.toContain('confidence_threshold');
      expect(src, name).not.toContain('<Slider');
      expect(src, name).not.toMatch(/for auto-ingest to work/);
      expect(src, name).not.toMatch(/ingested automatically/);
    }
  });

  it('no screen or help text promises that a document is filed without a person', () => {
    const promises = [
      /auto-ingest without/i,
      /skip review and auto-ingest/i,
      /auto-approves/i,
      /auto-ingest thresholds?/i,
      /whether auto-ingest fires/i,
      /didn't auto-ingest/i,
      /finally auto-ingest/i,
      /ingest unattended\b/i,
    ];
    for (const [name, text] of [
      ['helpContent', helpContent], ['ReviewQueue', reviewQueuePage], ['Import', importPage],
      ['LearningDashboard', learningPage], ['DocumentTypes', documentTypesPage], ['Tenants', tenantsPage],
    ] as const) {
      for (const p of promises) expect(code(text), `${name}: ${p}`).not.toMatch(p);
    }
    // The help DOES say what is true.
    expect(helpContent).toContain('Nothing is filed without a person approving it.');
  });

  it('the list of screens still to clean is short and explained', () => {
    expect(STILL_SHOWN.map((s) => s.path)).toEqual(['src/pages/admin/SupplierDetail.tsx']);
    for (const s of STILL_SHOWN) expect(s.reason.length).toBeGreaterThan(30);
  });
});

describe('the columns and API fields are left alone', () => {
  it('the three columns still exist', async () => {
    const has = async (table: string, column: string) => {
      const rows = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
      return (rows.results ?? []).some((r) => r.name === column);
    };
    expect(await has('tenants', 'auto_approve_threshold')).toBe(true);
    expect(await has('document_types', 'auto_ingest')).toBe(true);
    expect(await has('extraction_templates', 'auto_ingest_enabled')).toBe(true);
  });

  it('the endpoints still accept them, so an existing client keeps working', () => {
    expect(tenantApi).toContain("updates.push('auto_approve_threshold = ?')");
    expect(documentTypeApi).toContain("updates.push('auto_ingest = ?')");
    expect(templateApi).toContain('auto_ingest_enabled');
  });
});
