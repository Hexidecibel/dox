/**
 * Unit tests for `shared/modules.ts` — the module vocabulary and the pure
 * visibility resolver.
 *
 * The rules being pinned are the ones that are easy to "simplify" into their
 * opposite later:
 *   - tenant gates, role filters: an off module cannot be re-granted by a
 *     function row.
 *   - absence means UNCONSTRAINED, both when a user holds no function at all
 *     and when they hold one nobody has scoped. Narrowing needs a written row.
 *   - several functions UNION, and one unconstrained function wins outright.
 *   - super_admin bypasses both layers.
 *   - path matching is longest-prefix and whole-segment, and `null` means
 *     always-on rather than "unknown".
 *
 * Pure functions — no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  MODULE_KEYS,
  MODULES,
  isModuleKey,
  moduleForApiPath,
  moduleForUiPath,
  resolveVisibleModules,
  type ModuleKey,
} from '../../shared/modules';

const ALL: ModuleKey[] = [...MODULE_KEYS];

describe('the vocabulary', () => {
  it('is the four modules, in presentation order', () => {
    expect(ALL).toEqual(['library', 'compliance', 'fulfillment', 'records']);
  });

  it('defaults every module ON, so the migration inserting zero rows is a no-op', () => {
    for (const key of MODULE_KEYS) {
      expect(MODULES[key].defaultEnabled).toBe(true);
    }
  });

  it('describes every module for a human picking one', () => {
    for (const key of MODULE_KEYS) {
      expect(MODULES[key].key).toBe(key);
      expect(MODULES[key].label.length).toBeGreaterThan(0);
      expect(MODULES[key].blurb.length).toBeGreaterThan(0);
      expect(MODULES[key].uiPrefixes.length).toBeGreaterThan(0);
    }
  });

  it('recognises its own keys and nothing else', () => {
    expect(isModuleKey('library')).toBe(true);
    expect(isModuleKey('Library')).toBe(false);
    expect(isModuleKey('billing')).toBe(false);
    expect(isModuleKey(null)).toBe(false);
    expect(isModuleKey(7)).toBe(false);
  });

  it('claims no path prefix twice', () => {
    const seen = new Set<string>();
    for (const key of MODULE_KEYS) {
      for (const prefix of [...MODULES[key].uiPrefixes, ...MODULES[key].apiPrefixes]) {
        expect(seen.has(prefix)).toBe(false);
        seen.add(prefix);
      }
    }
  });
});

describe('moduleForUiPath', () => {
  it('maps a module root and everything under it', () => {
    expect(moduleForUiPath('/documents')).toBe('library');
    expect(moduleForUiPath('/documents/doc_123')).toBe('library');
    expect(moduleForUiPath('/records/sheet_1/forms/form_2')).toBe('records');
    expect(moduleForUiPath('/orders/ord_9')).toBe('fulfillment');
    expect(moduleForUiPath('/spec-alerts')).toBe('compliance');
  });

  it('returns null for the always-on surfaces — a tenant with every module off still has a portal', () => {
    expect(moduleForUiPath('/dashboard')).toBeNull();
    expect(moduleForUiPath('/search')).toBeNull();
    expect(moduleForUiPath('/activity')).toBeNull();
    expect(moduleForUiPath('/settings/spec-limits')).toBeNull();
    expect(moduleForUiPath('/profile')).toBeNull();
    expect(moduleForUiPath('/')).toBeNull();
    expect(moduleForUiPath('')).toBeNull();
  });

  it('matches whole segments only', () => {
    expect(moduleForUiPath('/documentsomething')).toBeNull();
    expect(moduleForUiPath('/records-archive')).toBeNull();
  });

  it('prefers the longest prefix, so a nested admin path is not swallowed', () => {
    // /admin is always-on configuration; only these two branches are owned.
    expect(moduleForUiPath('/admin/suppliers')).toBe('library');
    expect(moduleForUiPath('/admin/suppliers/sup_1')).toBe('library');
    expect(moduleForUiPath('/admin/customers/cus_1')).toBe('fulfillment');
    expect(moduleForUiPath('/admin/users')).toBeNull();
    expect(moduleForUiPath('/admin/requirements')).toBeNull();
  });

  it('tolerates a trailing slash and a query string', () => {
    expect(moduleForUiPath('/documents/')).toBe('library');
    expect(moduleForUiPath('/documents?page=2')).toBe('library');
    expect(moduleForUiPath('/dashboard?x=1')).toBeNull();
  });
});

describe('moduleForApiPath', () => {
  it('maps an endpoint that exclusively serves one module', () => {
    expect(moduleForApiPath('/api/queue')).toBe('library');
    expect(moduleForApiPath('/api/queue/item_1/approve')).toBe('library');
    expect(moduleForApiPath('/api/expirations/run-scheduled')).toBe('compliance');
    expect(moduleForApiPath('/api/lots')).toBe('fulfillment');
    expect(moduleForApiPath('/api/workflow-approvals')).toBe('records');
    // Getting documents OUT of search (0115) is the library's surface, even
    // though /api/documents itself stays unowned: this prefix serves only the
    // export, so gating it cannot take a switched-ON module down with it.
    expect(moduleForApiPath('/api/document-exports/zip')).toBe('library');
    expect(moduleForApiPath('/api/document-exports/send')).toBe('library');
  });

  it('leaves shared read primitives always-on', () => {
    // /api/documents is deliberately unowned: renewal digests, alert landings
    // and COA fulfillment all read documents, so gating it behind `library`
    // would break two modules that are switched ON.
    expect(moduleForApiPath('/api/documents/doc_1')).toBeNull();
    expect(moduleForApiPath('/api/auth/login')).toBeNull();
    expect(moduleForApiPath('/api/users/me')).toBeNull();
    expect(moduleForApiPath('/api/search')).toBeNull();
  });

  it('does not confuse a UI path for an API path', () => {
    expect(moduleForApiPath('/documents')).toBeNull();
    expect(moduleForUiPath('/api/queue')).toBeNull();
  });
});

describe('resolveVisibleModules — the tenant ceiling', () => {
  it('shows everything to a tenant with no rows at all (migration day)', () => {
    expect(
      resolveVisibleModules({ role: 'user', tenantRows: [], functionRows: [] }),
    ).toEqual(ALL);
  });

  it('drops a module the tenant switched off, and keeps presentation order', () => {
    expect(
      resolveVisibleModules({
        role: 'org_admin',
        tenantRows: [{ module_key: 'fulfillment', enabled: 0 }],
        functionRows: [],
      }),
    ).toEqual(['library', 'compliance', 'records']);
  });

  it('accepts either the D1 integer or a boolean for enabled', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [
          { module_key: 'records', enabled: false },
          { module_key: 'library', enabled: true },
          { module_key: 'compliance', enabled: 1 },
        ],
        functionRows: [],
      }),
    ).toEqual(['library', 'compliance', 'fulfillment']);
  });

  it('ignores a row naming a module this build does not know about', () => {
    // There is no CHECK on module_key on purpose; a stale row from a renamed
    // or removed module must not throw and must not hide anything.
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [{ module_key: 'billing', enabled: 0 }],
        functionRows: [],
      }),
    ).toEqual(ALL);
  });

  it('can switch every module off — there is no undisableable core', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: MODULE_KEYS.map((module_key) => ({ module_key, enabled: 0 })),
        functionRows: [],
      }),
    ).toEqual([]);
  });
});

describe('resolveVisibleModules — the function filter', () => {
  it('narrows to what the function was scoped to', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [],
        functionRows: [
          { owner_key: 'qa', module_key: 'library' },
          { owner_key: 'qa', module_key: 'compliance' },
        ],
      }),
    ).toEqual(['library', 'compliance']);
  });

  it('shows everything to a user who holds no function', () => {
    // Absence means unconstrained — the deliberate inverse of owner_routes,
    // where absence means "unrouted, and reported".
    expect(
      resolveVisibleModules({ role: 'reader', tenantRows: [], functionRows: [] }),
    ).toEqual(ALL);
  });

  it('shows everything to a user whose only function was never scoped', () => {
    // The LEFT JOIN produces exactly one row with a null module_key.
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [],
        functionRows: [{ owner_key: 'purchasing', module_key: null }],
      }),
    ).toEqual(ALL);
  });

  it('unions several scoped functions', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [],
        functionRows: [
          { owner_key: 'qa', module_key: 'compliance' },
          { owner_key: 'purchasing', module_key: 'fulfillment' },
        ],
      }),
    ).toEqual(['compliance', 'fulfillment']);
  });

  it('lets ONE unconstrained function win over any number of scoped ones', () => {
    // A QA lead who is also on an unscoped Purchasing route does not lose QA.
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [],
        functionRows: [
          { owner_key: 'qa', module_key: 'compliance' },
          { owner_key: 'purchasing', module_key: null },
        ],
      }),
    ).toEqual(ALL);
  });

  it('ignores an unrecognised module key in a visibility row', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [],
        functionRows: [
          { owner_key: 'qa', module_key: 'billing' },
          { owner_key: 'qa', module_key: 'records' },
        ],
      }),
    ).toEqual(['records']);
  });
});

describe('resolveVisibleModules — where the two layers meet', () => {
  it('tenant-off beats function-on: a scoped role cannot re-grant a module the tenant does not have', () => {
    expect(
      resolveVisibleModules({
        role: 'org_admin',
        tenantRows: [{ module_key: 'fulfillment', enabled: 0 }],
        functionRows: [
          { owner_key: 'purchasing', module_key: 'fulfillment' },
          { owner_key: 'purchasing', module_key: 'library' },
        ],
      }),
    ).toEqual(['library']);
  });

  it('can resolve to nothing when a function is scoped only to disabled modules', () => {
    expect(
      resolveVisibleModules({
        role: 'user',
        tenantRows: [{ module_key: 'records', enabled: 0 }],
        functionRows: [{ owner_key: 'ops', module_key: 'records' }],
      }),
    ).toEqual([]);
  });

  it('super_admin bypasses BOTH layers', () => {
    expect(
      resolveVisibleModules({
        role: 'super_admin',
        tenantRows: MODULE_KEYS.map((module_key) => ({ module_key, enabled: 0 })),
        functionRows: [{ owner_key: 'qa', module_key: 'compliance' }],
      }),
    ).toEqual(ALL);
  });

  it('returns a fresh array the caller may mutate', () => {
    const first = resolveVisibleModules({ role: 'user', tenantRows: [], functionRows: [] });
    first.pop();
    expect(
      resolveVisibleModules({ role: 'user', tenantRows: [], functionRows: [] }),
    ).toEqual(ALL);
  });
});
