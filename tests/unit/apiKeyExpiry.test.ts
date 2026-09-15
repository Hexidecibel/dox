/**
 * API key expiry semantics — `shared/apiKeyExpiry.ts`.
 *
 * The bug this pins (prod, 2026-09-15): the create form stored `2026-09-15`,
 * `new Date('2026-09-15')` is midnight UTC at the START of that day, and a key
 * set to expire "today" was rejected as expired on its first request. Every
 * clock here is pinned; nothing reads the wall clock.
 */

import { describe, it, expect } from 'vitest';
import {
  endOfLocalDayIso,
  isApiKeyExpired,
  localDateString,
  parseApiKeyExpiry,
  validateNewApiKeyExpiry,
} from '../../shared/apiKeyExpiry';

const at = (iso: string) => new Date(iso);

describe('isApiKeyExpired — date-only (legacy rows, bare-date API callers)', () => {
  it('a key whose expiry date is today works all day, through 23:59:59.999 UTC', () => {
    expect(isApiKeyExpired('2026-09-15', at('2026-09-15T00:00:00.000Z'))).toBe(false);
    expect(isApiKeyExpired('2026-09-15', at('2026-09-15T12:00:00.000Z'))).toBe(false);
    expect(isApiKeyExpired('2026-09-15', at('2026-09-15T23:59:59.999Z'))).toBe(false);
  });

  it('stops working at the first instant of the next UTC day', () => {
    expect(isApiKeyExpired('2026-09-15', at('2026-09-16T00:00:00.000Z'))).toBe(true);
  });

  it('a key whose expiry date was yesterday is expired', () => {
    expect(isApiKeyExpired('2026-09-14', at('2026-09-15T00:00:00.000Z'))).toBe(true);
    expect(isApiKeyExpired('2026-09-14', at('2026-09-15T10:00:00.000Z'))).toBe(true);
  });

  it('parses to the last millisecond of that UTC day', () => {
    const parsed = parseApiKeyExpiry('2026-07-28');
    expect(parsed.kind).toBe('date');
    if (parsed.kind === 'date') expect(parsed.lastValidAt.toISOString()).toBe('2026-07-28T23:59:59.999Z');
  });
});

describe('isApiKeyExpired — full timestamps', () => {
  it('a zoned timestamp is the last valid instant, to the millisecond', () => {
    const exp = '2026-09-16T06:59:59.999Z';
    expect(isApiKeyExpired(exp, at('2026-09-16T06:59:59.998Z'))).toBe(false);
    expect(isApiKeyExpired(exp, at('2026-09-16T06:59:59.999Z'))).toBe(false);
    expect(isApiKeyExpired(exp, at('2026-09-16T07:00:00.000Z'))).toBe(true);
  });

  it('honours an explicit offset', () => {
    // 23:59:59 in UTC-7 is 06:59:59 UTC the next day.
    const exp = '2026-09-15T23:59:59-07:00';
    expect(isApiKeyExpired(exp, at('2026-09-16T06:59:59.000Z'))).toBe(false);
    expect(isApiKeyExpired(exp, at('2026-09-16T06:59:59.001Z'))).toBe(true);
  });

  it("reads a naive SQLite datetime('now') value as UTC, not local time", () => {
    const exp = '2026-09-15 10:00:00';
    expect(isApiKeyExpired(exp, at('2026-09-15T10:00:00.000Z'))).toBe(false);
    expect(isApiKeyExpired(exp, at('2026-09-15T10:00:00.001Z'))).toBe(true);
  });
});

describe('isApiKeyExpired — absent and unreadable', () => {
  it('no expiry never expires', () => {
    expect(isApiKeyExpired(null, at('2999-01-01T00:00:00Z'))).toBe(false);
    expect(isApiKeyExpired(undefined, at('2999-01-01T00:00:00Z'))).toBe(false);
    expect(isApiKeyExpired('', at('2999-01-01T00:00:00Z'))).toBe(false);
  });

  it('an unreadable expiry fails CLOSED (the old NaN comparison meant "never")', () => {
    expect(isApiKeyExpired('next tuesday', at('2020-01-01T00:00:00Z'))).toBe(true);
    expect(isApiKeyExpired('2026-02-30', at('2020-01-01T00:00:00Z'))).toBe(true);
    expect(parseApiKeyExpiry('9/15/2026').kind).toBe('invalid');
  });
});

describe('validateNewApiKeyExpiry — the create contract', () => {
  const now = at('2026-09-15T15:00:00.000Z');

  it('omitted / null / empty means a key that never expires', () => {
    expect(validateNewApiKeyExpiry(undefined, now)).toEqual({ ok: true, expiresAt: null });
    expect(validateNewApiKeyExpiry(null, now)).toEqual({ ok: true, expiresAt: null });
    expect(validateNewApiKeyExpiry('', now)).toEqual({ ok: true, expiresAt: null });
  });

  it("accepts today's date and normalises it to the end of that UTC day", () => {
    expect(validateNewApiKeyExpiry('2026-09-15', now)).toEqual({
      ok: true,
      expiresAt: '2026-09-15T23:59:59.999Z',
    });
  });

  it('rejects yesterday with a message that says why', () => {
    const result = validateNewApiKeyExpiry('2026-09-14', now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('in the past');
      expect(result.error).toContain('2026-09-14');
    }
  });

  it('normalises a zoned timestamp to UTC and rejects one already past', () => {
    expect(validateNewApiKeyExpiry('2026-09-15T23:59:59.999-07:00', now)).toEqual({
      ok: true,
      expiresAt: '2026-09-16T06:59:59.999Z',
    });
    expect(validateNewApiKeyExpiry('2026-09-15T14:59:59.999Z', now).ok).toBe(false);
    expect(validateNewApiKeyExpiry('2026-09-15T15:00:00.000Z', now).ok).toBe(true);
  });

  it('refuses a zone-less timestamp, a non-date, an impossible date and a non-string', () => {
    for (const bad of ['2026-09-20T10:00:00', '2026-09-20 10:00:00', 'soon', '2026-02-30', 12345, {}]) {
      const result = validateNewApiKeyExpiry(bad, now);
      expect(result.ok, String(bad)).toBe(false);
    }
  });
});

describe('browser helpers', () => {
  it('endOfLocalDayIso is the last millisecond of the picked LOCAL day', () => {
    const iso = endOfLocalDayIso('2026-09-15');
    expect(iso).not.toBeNull();
    const d = new Date(iso!);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 15]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([23, 59, 59, 999]);
    // Round-trips through the server contract as a still-valid key for all of that day.
    expect(validateNewApiKeyExpiry(iso, new Date(2026, 8, 15, 23, 59, 59, 0)).ok).toBe(true);
    expect(endOfLocalDayIso('2026-13-01')).toBeNull();
  });

  it('localDateString is the local calendar date', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
