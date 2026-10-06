/**
 * The pure half of sending an order's documents (shared/orderSend.ts):
 * how files are packed into emails, and how a lot row's production date is
 * worded. Both are rulings (AJ, 2026-10-05/06), so both are pinned at their
 * edges rather than their middles.
 */
import { describe, it, expect } from 'vitest';
import {
  ORDER_SEND_MAX_PARTS,
  ORDER_SEND_MAX_PART_BYTES,
  describeLotDate,
  humanBytes,
  lotRowLabel,
  packOrderSendFiles,
  partSubject,
} from '../../shared/orderSend';

const MB = 1024 * 1024;
const f = (key: string, bytes: number) => ({ key, bytes });

describe('packOrderSendFiles', () => {
  it('keeps everything in one email while it fits, to the byte', () => {
    const exact = packOrderSendFiles([f('a', 10 * MB), f('b', 5 * MB)]);
    expect(exact.part_count).toBe(1);
    expect(exact.files.map((x) => x.part_number)).toEqual([1, 1]);
    expect(exact.part_bytes).toEqual([ORDER_SEND_MAX_PART_BYTES]);
    expect(exact.refusal).toBeNull();

    // One byte over starts a second email; nothing is dropped.
    const over = packOrderSendFiles([f('a', 10 * MB), f('b', 5 * MB + 1)]);
    expect(over.part_count).toBe(2);
    expect(over.files.map((x) => x.part_number)).toEqual([1, 2]);
    expect(over.files).toHaveLength(2);
  });

  it('keeps the files in the order given, so "2 of N" follows "1 of N"', () => {
    const packed = packOrderSendFiles([f('a', 9 * MB), f('b', 9 * MB), f('c', 1 * MB), f('d', 9 * MB)]);
    // A tighter packing would put c beside a. Order wins.
    expect(packed.files.map((x) => `${x.key}:${x.part_number}`)).toEqual(['a:1', 'b:2', 'c:2', 'd:3']);
    expect(packed.part_count).toBe(3);
  });

  it('a file exactly at the limit attaches; one byte over leaves as a link in part 1', () => {
    const at = packOrderSendFiles([f('a', ORDER_SEND_MAX_PART_BYTES)]);
    expect(at.files[0]).toMatchObject({ delivery: 'attachment', part_number: 1 });

    const over = packOrderSendFiles([f('small', MB), f('huge', ORDER_SEND_MAX_PART_BYTES + 1), f('tail', MB)]);
    expect(over.files.find((x) => x.key === 'huge')).toMatchObject({ delivery: 'link', part_number: 1 });
    // A link costs no attachment room.
    expect(over.part_count).toBe(1);
    expect(over.part_bytes).toEqual([2 * MB]);
  });

  it('an order of only oversize files is still one email, of links', () => {
    const packed = packOrderSendFiles([f('a', 20 * MB), f('b', 30 * MB)]);
    expect(packed.part_count).toBe(1);
    expect(packed.files.every((x) => x.delivery === 'link')).toBe(true);
    expect(packed.refusal).toBeNull();
  });

  it('refuses past the cap with both numbers in the message, and allows exactly the cap', () => {
    const atCap = packOrderSendFiles(Array.from({ length: ORDER_SEND_MAX_PARTS }, (_, i) => f(`f${i}`, 14 * MB)));
    expect(atCap.part_count).toBe(ORDER_SEND_MAX_PARTS);
    expect(atCap.refusal).toBeNull();

    const past = packOrderSendFiles(Array.from({ length: ORDER_SEND_MAX_PARTS + 1 }, (_, i) => f(`f${i}`, 14 * MB)));
    expect(past.refusal).toContain(`${ORDER_SEND_MAX_PARTS + 1} emails`);
    expect(past.refusal).toContain(`at most ${ORDER_SEND_MAX_PARTS}`);
    // Refused, not truncated: every file is still accounted for.
    expect(past.files).toHaveLength(ORDER_SEND_MAX_PARTS + 1);
  });

  it('an empty order is one empty email, which the caller refuses on its own terms', () => {
    expect(packOrderSendFiles([])).toMatchObject({ part_count: 1, files: [], refusal: null });
  });
});

describe('partSubject', () => {
  it('numbers only a split send', () => {
    expect(partSubject('Documents for order 12', 1, 1)).toBe('Documents for order 12');
    expect(partSubject('Documents for order 12', 2, 3)).toBe('Documents for order 12 (2 of 3)');
  });
});

describe('describeLotDate', () => {
  it('prints a stated date plainly and nothing else plainly', () => {
    expect(describeLotDate({ production_date: '2026-07-22', production_date_status: 'resolved', production_date_source: 'extracted' }))
      .toEqual({ state: 'stated', label: 'Jul 22, 2026', note: null });
    expect(describeLotDate({ production_date: '2026-07-22', production_date_status: 'resolved', production_date_source: 'reviewer' }).state)
      .toBe('stated');
  });

  it('a decoded or legacy date carries its doubt in the label itself', () => {
    const decoded = describeLotDate({ production_date: '2026-07-31', production_date_status: 'resolved', production_date_source: 'lot_decode' });
    expect(decoded.state).toBe('decoded');
    expect(decoded.label).toBe('Jul 31, 2026 (from the lot code)');
    expect(decoded.note).toBeTruthy();

    const legacy = describeLotDate({ production_date: '2026-07-31', production_date_status: 'resolved', production_date_source: 'extracted_code_date_legacy' });
    expect(legacy.state).toBe('legacy');
    expect(legacy.label).toBe('Jul 31, 2026 (confirm)');
  });

  it('an ambiguous, conflicting or unreadable date shows what was printed, never a day', () => {
    const ambiguous = describeLotDate({ production_date: null, production_date_raw: '03/04/2026', production_date_status: 'ambiguous' });
    expect(ambiguous).toMatchObject({ state: 'ambiguous', label: '03/04/2026' });
    // Status outranks a stored day: a conflict is a conflict even if one is set.
    const conflict = describeLotDate({ production_date: '2026-08-05', production_date_raw: '2026-08-05 | 2026-08-09', production_date_status: 'conflict' });
    expect(conflict.state).toBe('conflict');
    expect(conflict.label).toBe('2026-08-05 | 2026-08-09');
    expect(describeLotDate({ production_date: null, production_date_status: 'unparseable' }).label).toBe('Unreadable');
  });

  it('no lot, or no date, is nothing', () => {
    expect(describeLotDate(null)).toEqual({ state: 'none', label: null, note: null });
    expect(describeLotDate({ production_date: null })).toEqual({ state: 'none', label: null, note: null });
  });
});

describe('labels', () => {
  it('lotRowLabel and humanBytes', () => {
    expect(lotRowLabel('10426203', '03')).toBe('10426203 / 03');
    expect(lotRowLabel('10426203', '')).toBe('10426203');
    expect(lotRowLabel(null, '03')).toBeNull();
    expect(humanBytes(16 * MB)).toBe('16 MB');
    expect(humanBytes(312 * 1024)).toBe('312 KB');
  });
});
