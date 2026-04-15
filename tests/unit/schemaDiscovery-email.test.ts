/**
 * Unit tests for discoverFromEmail + parseEmlText.
 *
 * Feeds a synthetic .eml string through the parser, verifies the headers /
 * body are extracted correctly, then runs the discovery path with a Qwen
 * mock returning a canned schema response.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverFromEmail,
  parseEmlText,
} from '../../functions/lib/connectors/schemaDiscovery';
import {
  installQwenMock,
  uninstallQwenMock,
  getQwenCallLog,
} from '../helpers/qwen-mock';

const EML_FIXTURE = `From: orders@medosweet.test
To: ingest@dox.test
Subject: Daily Order Batch 2026-04-10
Content-Type: text/plain

Please process the following orders:

Order: 1784767  Customer: K00166 - CHUCKANUT BAY FOODS  PO: PO-500  Ship Date: 2026-04-15
Order: 1783966  Customer: K14534 - COUGAR MOUNTAIN BAKING  PO: PO-600  Ship Date: 2026-04-16
Order: 1784964  Customer: P2264  - GRAND CENTRAL FREMONT   PO: PO-700  Ship Date: 2026-04-17
`;

const MULTIPART_EML = `From: orders@medosweet.test
To: ingest@dox.test
Subject: Multipart test
Content-Type: multipart/alternative; boundary="BOUNDARY123"

--BOUNDARY123
Content-Type: text/plain

Plain text body with Order 12345
--BOUNDARY123
Content-Type: text/html

<html><body><p>HTML body with Order 67890</p></body></html>
--BOUNDARY123--
`;

describe('parseEmlText', () => {
  it('extracts From, Subject, and body from a simple RFC822 message', () => {
    const parsed = parseEmlText(EML_FIXTURE);
    expect(parsed.from).toContain('orders@medosweet.test');
    expect(parsed.subject).toBe('Daily Order Batch 2026-04-10');
    expect(parsed.body).toContain('1784767');
    expect(parsed.body).toContain('CHUCKANUT BAY FOODS');
  });

  it('prefers text/plain over text/html in multipart messages', () => {
    const parsed = parseEmlText(MULTIPART_EML);
    expect(parsed.subject).toBe('Multipart test');
    expect(parsed.body).toContain('Plain text body');
    expect(parsed.body).toContain('Order 12345');
    expect(parsed.body).not.toContain('<p>');
  });

  it('handles empty input without throwing', () => {
    const parsed = parseEmlText('');
    expect(parsed.from).toBe('');
    expect(parsed.subject).toBe('');
    expect(parsed.body).toBe('');
  });
});

describe('discoverFromEmail', () => {
  beforeEach(() => {
    installQwenMock(((bodyText: string) => {
      if (/Source kind: email/i.test(bodyText) || /Daily Order Batch/i.test(bodyText)) {
        return {
          orders: [],
          customers: [],
          detected_fields: [
            {
              name: 'Order',
              inferred_type: 'id',
              sample_values: ['1784767', '1783966'],
              inferred_aliases: ['order_number'],
              candidate_target: 'order_number',
              confidence: 0.95,
            },
            {
              name: 'Customer',
              inferred_type: 'id',
              sample_values: ['K00166', 'K14534', 'P2264'],
              inferred_aliases: ['customer_number'],
              candidate_target: 'customer_number',
              confidence: 0.92,
            },
            {
              name: 'PO',
              inferred_type: 'id',
              sample_values: ['PO-500', 'PO-600'],
              inferred_aliases: ['po_number', 'Purchase Order'],
              candidate_target: 'po_number',
              confidence: 0.9,
            },
          ],
          layout_hint: 'key_value',
          warnings: [],
        };
      }
      return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('parses the email body and runs Qwen schema discovery', async () => {
    const result = await discoverFromEmail(EML_FIXTURE, {
      url: 'https://qwen.test',
      secret: 'test-secret',
    });

    expect(result.detected_fields.length).toBe(3);
    const byName = Object.fromEntries(result.detected_fields.map((f) => [f.name, f]));
    expect(byName['Order']?.candidate_target).toBe('order_number');
    expect(byName['Customer']?.candidate_target).toBe('customer_number');
    expect(byName['PO']?.candidate_target).toBe('po_number');

    expect(result.layout_hint).toBe('key_value');

    // Qwen was called with the schema-discovery prompt.
    const log = getQwenCallLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].systemMessage).toContain('data schema analyzer');
  });

  it('returns a warning when Qwen is not configured', async () => {
    const result = await discoverFromEmail(EML_FIXTURE, { url: undefined });
    expect(result.detected_fields).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns an empty-body warning for a message with no body content', async () => {
    const empty = `From: a@b.test
Subject: Empty

`;
    const result = await discoverFromEmail(empty, {
      url: 'https://qwen.test',
      secret: 'test-secret',
    });
    expect(result.detected_fields).toEqual([]);
    expect(result.warnings.some((w) => /empty|too short/i.test(w))).toBe(true);
  });
});
