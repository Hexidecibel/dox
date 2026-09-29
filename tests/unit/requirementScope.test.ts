import { describe, it, expect } from 'vitest';
import migrationSql from '../../migrations/0123_requirement_scope.sql?raw';
import {
  REQUIREMENT_SCOPES,
  DEFAULT_REQUIREMENT_SCOPE,
  EVALUATED_REQUIREMENT_SCOPES,
  isRequirementScope,
  normalizeRequirementScope,
  isProductRequirementMode,
  isProductSupplierSource,
} from '../../shared/requirementScope';

describe('requirement scope vocabulary (0123)', () => {
  it('is supplier / product / lot, defaulting to supplier', () => {
    expect([...REQUIREMENT_SCOPES]).toEqual(['supplier', 'product', 'lot']);
    expect(DEFAULT_REQUIREMENT_SCOPE).toBe('supplier');
  });

  it('reads NULL and unknown stored values as supplier — never stricter or looser', () => {
    expect(normalizeRequirementScope(null)).toBe('supplier');
    expect(normalizeRequirementScope(undefined)).toBe('supplier');
    expect(normalizeRequirementScope('facility')).toBe('supplier');
    expect(normalizeRequirementScope('Product')).toBe('supplier');
    expect(normalizeRequirementScope('product')).toBe('product');
    expect(normalizeRequirementScope('lot')).toBe('lot');
  });

  it('validates writes', () => {
    expect(isRequirementScope('product')).toBe(true);
    expect(isRequirementScope('facility')).toBe(false);
    expect(isRequirementScope(3)).toBe(false);
    expect(isProductRequirementMode('exempt')).toBe(true);
    expect(isProductRequirementMode('remove')).toBe(false);
    expect(isProductSupplierSource('certificate')).toBe(true);
    expect(isProductSupplierSource('guess')).toBe(false);
  });

  it('lot is stored but not evaluated at its own grain yet', () => {
    expect(EVALUATED_REQUIREMENT_SCOPES).toEqual(['supplier', 'product']);
  });

  it('the migration enforces scope in code, not with a CHECK (requirements is a CASCADE target)', () => {
    const sql = migrationSql;
    const stmt = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(stmt).toMatch(/ALTER TABLE requirements ADD COLUMN scope TEXT NOT NULL DEFAULT 'supplier';/);
    expect(stmt).not.toMatch(/scope[^\n]*CHECK/);
    // Plain-ASCII (the 0110 D1 import finding).
    expect(/^[\x00-\x7F]*$/.test(sql)).toBe(true);
  });
});
