/**
 * Unit tests for the pure subject/sender matching helpers used by the
 * /api/connectors/match-email endpoint.
 *
 * The key user-facing invariant we pin down here: matching is
 * case-insensitive by default, because email subjects are often inconsistent
 * in casing (e.g. "Daily COA Report" vs "DAILY COA REPORT").
 */

import { describe, it, expect } from 'vitest';
import {
  subjectMatches,
  senderMatches,
} from '../../functions/lib/connectors/matchEmail';

describe('subjectMatches', () => {
  it('returns true when no patterns are set (empty list matches everything)', () => {
    expect(subjectMatches('anything', [])).toBe(true);
    expect(subjectMatches('anything', undefined)).toBe(true);
    expect(subjectMatches('anything', null)).toBe(true);
  });

  it('returns false when patterns are set but subject is missing', () => {
    expect(subjectMatches(null, ['Daily COA'])).toBe(false);
    expect(subjectMatches('', ['Daily COA'])).toBe(false);
  });

  it('matches literal substring patterns', () => {
    expect(subjectMatches('Daily COA Report - April 15', ['Daily COA Report'])).toBe(true);
    expect(subjectMatches('Weekly Order Summary', ['Daily COA Report'])).toBe(false);
  });

  it('is case-insensitive', () => {
    const pattern = ['Daily COA Report'];
    expect(subjectMatches('Daily COA Report', pattern)).toBe(true);
    expect(subjectMatches('DAILY COA REPORT', pattern)).toBe(true);
    expect(subjectMatches('daily coa report', pattern)).toBe(true);
    expect(subjectMatches('dAiLy CoA rEpOrT', pattern)).toBe(true);
  });

  it('supports regex wildcards', () => {
    expect(subjectMatches('Order 12345 Report', ['Order.*Report'])).toBe(true);
    expect(subjectMatches('Order Summary', ['Order.*Report'])).toBe(false);
  });

  it('matches if ANY pattern in the list matches', () => {
    const patterns = ['COA', 'Spec Sheet'];
    expect(subjectMatches('Spec Sheet for Widget', patterns)).toBe(true);
    expect(subjectMatches('COA April', patterns)).toBe(true);
    expect(subjectMatches('Invoice 123', patterns)).toBe(false);
  });

  it('silently skips invalid regex patterns', () => {
    // `[` is an unterminated character class — should not throw.
    expect(() => subjectMatches('anything', ['['])).not.toThrow();
    expect(subjectMatches('Daily COA', ['[', 'Daily'])).toBe(true);
    expect(subjectMatches('Invoice', ['['])).toBe(false);
  });

  it('skips empty / non-string pattern entries', () => {
    expect(subjectMatches('Daily COA', ['', 'Daily'])).toBe(true);
    // @ts-expect-error — testing defensive handling at runtime
    expect(subjectMatches('Daily COA', [null, 'Daily'])).toBe(true);
  });
});

describe('senderMatches', () => {
  it('returns true when no filter is set', () => {
    expect(senderMatches('anyone@example.com', '')).toBe(true);
    expect(senderMatches('anyone@example.com', undefined)).toBe(true);
    expect(senderMatches('anyone@example.com', null)).toBe(true);
  });

  it('returns false when a filter is set but sender is missing', () => {
    expect(senderMatches(null, '@supplier.com')).toBe(false);
    expect(senderMatches('', '@supplier.com')).toBe(false);
  });

  it('matches by substring', () => {
    expect(senderMatches('bob@supplier.com', '@supplier.com')).toBe(true);
    expect(senderMatches('bob@other.com', '@supplier.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(senderMatches('Bob@Supplier.COM', '@supplier.com')).toBe(true);
    expect(senderMatches('bob@SUPPLIER.COM', '@Supplier.Com')).toBe(true);
  });

  it('fail-open on invalid regex filter', () => {
    // Historical behavior preserved: bad regex should not lock the user out.
    expect(senderMatches('bob@example.com', '[')).toBe(true);
  });
});
