/**
 * Unit tests for shared/connectorSlug.ts.
 *
 * The slug helper is the canonical source for the URL-safe handle used
 * everywhere a connector needs a vendor-facing address (email, HTTP API,
 * S3 bucket, public link). The wizard auto-generates from the
 * connector's name via `slugifyConnectorName`, the create handler
 * validates with `isValidConnectorSlug`, and the regex is shared between
 * client + server so they can't drift. These tests cover the slugifier's
 * contract (collapse runs of non-alphanumerics, trim edges, truncate at
 * 64, return "" on no-content input) and the validator's regex.
 */

import { describe, it, expect } from 'vitest';
import {
  slugifyConnectorName,
  isValidConnectorSlug,
  CONNECTOR_SLUG_REGEX,
} from '../../shared/connectorSlug';

describe('slugifyConnectorName', () => {
  it('lowercases and dashes a typical connector name', () => {
    expect(slugifyConnectorName('Acme Corp Orders')).toBe('acme-corp-orders');
  });

  it('collapses repeated whitespace, symbols, and underscores into single dashes', () => {
    expect(slugifyConnectorName('Spaces  &  multiple   dashes!!')).toBe('spaces-multiple-dashes');
    expect(slugifyConnectorName('foo___bar...baz')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing whitespace + symbols', () => {
    expect(slugifyConnectorName('   !!!Hello World!!!   ')).toBe('hello-world');
    expect(slugifyConnectorName('-already-dashed-')).toBe('already-dashed');
  });

  it('returns empty string for empty / whitespace-only / symbol-only input', () => {
    expect(slugifyConnectorName('')).toBe('');
    expect(slugifyConnectorName('     ')).toBe('');
    expect(slugifyConnectorName('!!!---___')).toBe('');
  });

  it('truncates to 64 chars and never leaves a trailing dash', () => {
    // 50 chars of 'a' + a dash + 20 chars of 'b' = 71 chars total.
    // After truncation to 64, the trailing slice could end on a dash if
    // the cut lands inside a hyphen run; the helper re-trims.
    const longName = `${'a'.repeat(50)} ${'b'.repeat(20)}`;
    const slug = slugifyConnectorName(longName);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('a')).toBe(true);
  });

  it('produces output that passes isValidConnectorSlug for ordinary names', () => {
    const cases = [
      'Daily ERP Report',
      'Vendor: Acme & Co.',
      'CS-2024 Q1',
      'a',
      '123 numbers',
    ];
    for (const c of cases) {
      const slug = slugifyConnectorName(c);
      expect(slug).not.toBe('');
      expect(isValidConnectorSlug(slug)).toBe(true);
    }
  });
});

describe('isValidConnectorSlug / CONNECTOR_SLUG_REGEX', () => {
  it('accepts kebab-case lowercase alphanumerics with internal dashes', () => {
    expect(isValidConnectorSlug('a')).toBe(true);
    expect(isValidConnectorSlug('1')).toBe(true);
    expect(isValidConnectorSlug('acme-orders')).toBe(true);
    expect(isValidConnectorSlug('vendor-2024-q1')).toBe(true);
    // 64 chars exactly is the max.
    expect(isValidConnectorSlug('a' + 'b'.repeat(63))).toBe(true);
  });

  it('rejects uppercase, leading/trailing dashes, and shape violations', () => {
    expect(isValidConnectorSlug('')).toBe(false);
    expect(isValidConnectorSlug('-leading')).toBe(false);
    expect(isValidConnectorSlug('trailing-')).toBe(false);
    expect(isValidConnectorSlug('Has-Caps')).toBe(false);
    expect(isValidConnectorSlug('has spaces')).toBe(false);
    expect(isValidConnectorSlug('under_score')).toBe(false);
    expect(isValidConnectorSlug('dot.name')).toBe(false);
    // 65 chars is too many.
    expect(isValidConnectorSlug('a'.repeat(65))).toBe(false);
  });

  it('exposes the regex for callers that want to share the rule', () => {
    expect(CONNECTOR_SLUG_REGEX.test('acme-orders')).toBe(true);
    expect(CONNECTOR_SLUG_REGEX.test('Bad Slug')).toBe(false);
  });
});
