import { describe, it, expect } from 'vitest';
import { validatePassword, validateEmail, sanitizeString } from '../../functions/lib/validation';

describe('validatePassword', () => {
  it('accepts a valid password', () => {
    const result = validatePassword('SecurePass1');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects password shorter than 8 chars', () => {
    const result = validatePassword('Sh1');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must be at least 8 characters');
  });

  it('rejects password longer than 128 chars', () => {
    const result = validatePassword('A1' + 'a'.repeat(127));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must be less than 128 characters');
  });

  it('rejects password without uppercase letter', () => {
    const result = validatePassword('nouppercase1');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must contain an uppercase letter');
  });

  it('rejects password without lowercase letter', () => {
    const result = validatePassword('NOLOWERCASE1');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must contain a lowercase letter');
  });

  it('rejects password without a number', () => {
    const result = validatePassword('NoNumberHere');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must contain a number');
  });

  it('collects multiple errors', () => {
    const result = validatePassword('short');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts exactly 8 characters with all requirements', () => {
    const result = validatePassword('Abcdef1x');
    expect(result.valid).toBe(true);
  });
});

describe('validateEmail', () => {
  it('accepts valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  it('accepts email with subdomain', () => {
    expect(validateEmail('user@mail.example.co.uk')).toBe(true);
  });

  it('accepts email with plus addressing', () => {
    expect(validateEmail('user+tag@example.com')).toBe(true);
  });

  it('rejects email without @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  it('rejects email without domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  it('rejects email without local part', () => {
    expect(validateEmail('@example.com')).toBe(false);
  });

  it('rejects email with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateEmail('')).toBe(false);
  });
});

describe('sanitizeString', () => {
  it('trims whitespace', () => {
    expect(sanitizeString('  hello  ')).toBe('hello');
  });

  it('removes null bytes', () => {
    expect(sanitizeString('hello\0world')).toBe('helloworld');
  });

  it('handles both trim and null byte removal', () => {
    expect(sanitizeString('  test\0data  ')).toBe('testdata');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeString('   ')).toBe('');
  });

  it('passes through clean strings unchanged', () => {
    expect(sanitizeString('clean string')).toBe('clean string');
  });
});
