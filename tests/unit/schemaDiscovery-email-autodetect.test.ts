/**
 * Unit tests for looksLikeEmail — the content-sniffing helper used by the
 * connector wizard to catch emails saved as `.txt` (or other ambiguous
 * extensions) before they hit the CSV parser and get shredded on commas
 * in `Subject:` lines.
 */

import { describe, it, expect } from 'vitest';
import { looksLikeEmail } from '../../functions/lib/connectors/schemaDiscovery';

describe('looksLikeEmail', () => {
  it('detects a plain-text email saved as .txt with common headers', () => {
    const text = `Subject: Daily COA Report - April 6, 2026
From: orders@medosweet.test
To: ingest@dox.test
Date: Mon, 06 Apr 2026 08:15:00 -0700

Please process today's batch:
Order: 1784767  Customer: K00166
`;
    expect(looksLikeEmail(text)).toBe(true);
  });

  it('detects a minimal two-header email body', () => {
    const text = `From: a@b.test
Subject: Hello

Body here.`;
    expect(looksLikeEmail(text)).toBe(true);
  });

  it('returns true on a message with Content-Type + Message-ID + Received', () => {
    const text = `Received: from mail.test ([1.2.3.4])
Message-ID: <abc@test>
Content-Type: text/plain

payload`;
    expect(looksLikeEmail(text)).toBe(true);
  });

  it('returns false for a normal CSV header row', () => {
    const text = `Order #,Customer,PO Number,Ship Date
SO-1001,Acme Corp,PO-500,2026-04-15
SO-1002,Beta Inc,PO-600,2026-04-16
`;
    expect(looksLikeEmail(text)).toBe(false);
  });

  it('returns false for a single pseudo-header (no second signal)', () => {
    const text = `Subject: this is not really an email\nSome free-form prose follows.`;
    expect(looksLikeEmail(text)).toBe(false);
  });

  it('returns false for empty or very short input', () => {
    expect(looksLikeEmail('')).toBe(false);
    expect(looksLikeEmail('hi')).toBe(false);
  });

  it('is case-insensitive on header names', () => {
    const text = `SUBJECT: Upper Case
FROM: x@y.test

Body`;
    expect(looksLikeEmail(text)).toBe(true);
  });

  it('only inspects the first ~10 lines — buried headers do not count', () => {
    const padding = Array.from({ length: 20 }, (_, i) => `row${i},a,b,c`).join('\n');
    const text = `${padding}\nSubject: sneaky\nFrom: x@y.test\n`;
    expect(looksLikeEmail(text)).toBe(false);
  });

  it('handles CRLF line endings', () => {
    const text = 'Subject: CRLF test\r\nFrom: a@b.test\r\n\r\nBody';
    expect(looksLikeEmail(text)).toBe(true);
  });
});
