import { describe, it, expect } from 'vitest';
import { ensureUtc, parseUtc, formatDate, formatDateTime } from './format';

describe('format date helpers', () => {
  describe('ensureUtc', () => {
    it('appends Z to a bare SQLite timestamp', () => {
      expect(ensureUtc('2026-06-02 00:09:56')).toBe('2026-06-02 00:09:56Z');
    });

    it('leaves a value that already ends in Z alone', () => {
      expect(ensureUtc('2026-06-02T00:09:56Z')).toBe('2026-06-02T00:09:56Z');
    });

    it('leaves an explicit offset alone (with or without colon)', () => {
      expect(ensureUtc('2026-06-02T00:09:56+02:00')).toBe('2026-06-02T00:09:56+02:00');
      expect(ensureUtc('2026-06-02T00:09:56-0700')).toBe('2026-06-02T00:09:56-0700');
    });
  });

  describe('parseUtc', () => {
    it('parses a bare SQLite timestamp as UTC, not local', () => {
      const d = parseUtc('2026-06-02 00:09:56');
      // Independent of the test runner's timezone: the epoch must equal the
      // UTC interpretation of the string.
      expect(d?.getTime()).toBe(Date.UTC(2026, 5, 2, 0, 9, 56));
    });

    it('returns null for empty / invalid input', () => {
      expect(parseUtc(null)).toBeNull();
      expect(parseUtc(undefined)).toBeNull();
      expect(parseUtc('not a date')).toBeNull();
    });
  });

  describe('formatDate', () => {
    it('returns "Never" for empty input', () => {
      expect(formatDate(null)).toBe('Never');
    });

    it('returns "Invalid date" for garbage', () => {
      expect(formatDate('not a date')).toBe('Invalid date');
    });
  });

  describe('formatDateTime', () => {
    it('returns "Never" for empty input', () => {
      expect(formatDateTime(null)).toBe('Never');
    });

    it('includes a short timezone label so the local tz is explicit', () => {
      const out = formatDateTime('2026-06-02 00:09:56');
      // The exact tz abbreviation depends on the host locale/tz, but a short
      // tz label always contains either "GMT"/"UTC" or an alpha abbreviation.
      expect(out).toMatch(/(GMT|UTC|[A-Z]{2,5})/);
      // Sanity: it is a date+time render, not a bare date.
      expect(out).toMatch(/\d{1,2}:\d{2}/);
    });
  });
});
