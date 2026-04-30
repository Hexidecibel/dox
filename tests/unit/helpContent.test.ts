/**
 * helpContent — content-library invariants.
 *
 * The Workers-pool vitest runner can't render the React shell that
 * displays helpContent, so we instead assert the structural invariants
 * the runtime relies on:
 *   - every top-level module key carries `headline` + `well`
 *   - the keys we expect to scaffold for D1-D6 are all present
 *   - well copy is non-empty
 */

import { describe, it, expect } from 'vitest';
import { helpContent } from '../../src/lib/helpContent';

const REQUIRED_MODULES = [
  'connectors',
  'orders',
  'customers',
  'suppliers',
  'products',
  'documents',
  'document_types',
  'naming_templates',
  'bundles',
  'reports',
  'activity',
  'audit',
  'search',
  'tenants',
  'users',
  'api_keys',
  'settings',
] as const;

describe('helpContent', () => {
  it('exposes every required top-level module key', () => {
    for (const key of REQUIRED_MODULES) {
      expect(helpContent, `missing module: ${key}`).toHaveProperty(key);
    }
  });

  it('every module entry has a non-empty headline + well', () => {
    for (const [key, entry] of Object.entries(helpContent)) {
      expect(entry.headline, `${key}.headline`).toBeTruthy();
      expect(entry.well, `${key}.well`).toBeTruthy();
      expect(typeof entry.headline).toBe('string');
      expect(typeof entry.well).toBe('string');
    }
  });

  it('connectors.list scaffolding is filled out (D0 spec)', () => {
    const list = helpContent.connectors.list;
    expect(list).toBeDefined();
    expect(list?.headline).toBe('Connectors');
    expect(list?.emptyTitle).toBe('No connectors yet');
    expect(list?.emptyDescription).toContain('Connectors');
  });
});
