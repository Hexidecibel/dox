import { describe, it, expect } from 'vitest';
import { generateId } from '../../functions/lib/db';

describe('generateId', () => {
  it('returns a 32-char hex string (UUID without dashes)', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('-');
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('is always lowercase', () => {
    const id = generateId();
    expect(id).toBe(id.toLowerCase());
  });
});
