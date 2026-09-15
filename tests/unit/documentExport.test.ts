/**
 * The pure half of the export path: what a selection is normalized to, what a
 * refusal says, and what the manifest contains.
 *
 * These are the parts a customer reads (the manifest) or is stopped by (the
 * cap), so they are pinned away from the database.
 */
import { describe, it, expect } from 'vitest';
import {
  EXPORT_MAX_DOCUMENTS,
  EXPORT_MAX_TOTAL_BYTES,
  buildExportManifestCsv,
  exportSizeRefusal,
  exportTotalBytes,
  exportZipFileName,
  normalizeExportIds,
  parseStringList,
  uniqueFileName,
} from '../../functions/lib/document-export';
import type { ExportDocumentRow } from '../../functions/lib/document-export';

function row(over: Partial<ExportDocumentRow> = {}): ExportDocumentRow {
  return {
    document_id: 'doc1',
    title: 'Cream COA',
    supplier_name: 'Darigold, Inc.',
    document_type_name: 'Certificate of Analysis',
    version_number: 2,
    file_name: 'coa.pdf',
    r2_key: 'docs/doc1/coa.pdf',
    mime_type: 'application/pdf',
    file_size: 1024,
    created_at: '2026-07-22 10:00:00',
    lot_label: '10426203 / 03',
    production_date: '2026-07-22',
    ...over,
  };
}

describe('normalizeExportIds', () => {
  it('keeps order, drops blanks and duplicates, ignores non-strings', () => {
    expect(normalizeExportIds(['b', 'a', 'b', '', '  ', 7, null, 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('is empty for anything that is not a list', () => {
    expect(normalizeExportIds(undefined)).toEqual([]);
    expect(normalizeExportIds('a,b')).toEqual([]);
  });

  it('returns one MORE than the cap so the caller can tell "at" from "over"', () => {
    const many = Array.from({ length: EXPORT_MAX_DOCUMENTS + 10 }, (_, i) => `d${i}`);
    expect(normalizeExportIds(many).length).toBe(EXPORT_MAX_DOCUMENTS + 1);
  });
});

describe('exportSizeRefusal', () => {
  it('says nothing when the selection fits', () => {
    expect(exportSizeRefusal([row({ file_size: 5_000_000 })])).toBeNull();
  });

  it('refuses over the cap and quotes BOTH numbers', () => {
    const msg = exportSizeRefusal([
      row({ file_size: EXPORT_MAX_TOTAL_BYTES }),
      row({ file_size: 5 * 1024 * 1024 }),
    ]);
    expect(msg).toContain('45 MB');
    expect(msg).toContain('40 MB');
  });

  it('sums the selection', () => {
    expect(exportTotalBytes([row({ file_size: 10 }), row({ file_size: 5 })])).toBe(15);
  });
});

describe('uniqueFileName', () => {
  it('keeps the extension when de-duplicating', () => {
    const taken = new Set<string>();
    expect(uniqueFileName(taken, 'coa.pdf')).toBe('coa.pdf');
    expect(uniqueFileName(taken, 'coa.pdf')).toBe('coa_1.pdf');
    expect(uniqueFileName(taken, 'coa.pdf')).toBe('coa_2.pdf');
  });

  it('handles a name with no extension, and an empty one', () => {
    const taken = new Set<string>();
    expect(uniqueFileName(taken, 'scan')).toBe('scan');
    expect(uniqueFileName(taken, 'scan')).toBe('scan_1');
    expect(uniqueFileName(taken, '')).toBe('unnamed');
  });
});

describe('buildExportManifestCsv', () => {
  it('names the file first, then the facts the sender was looking at', () => {
    const csv = buildExportManifestCsv(
      [{ file_name: 'coa_1.pdf', row: row() }],
      {
        tenant_name: 'Medosweet Farms',
        exported_by: 'Dana Reid',
        exported_at: '2026-09-15T12:00:00.000Z',
        on_behalf_of: 'Marco in Sales',
      },
    );
    const [header, first] = csv.split('\r\n');
    expect(header).toBe(
      '"File name","Document","Supplier","Document type","Lot","Production date","Version","Filed on"',
    );
    expect(first).toBe(
      '"coa_1.pdf","Cream COA","Darigold, Inc.","Certificate of Analysis","10426203 / 03","2026-07-22","2","2026-07-22"',
    );
    expect(csv).toContain('"Exported by","Dana Reid"');
    expect(csv).toContain('"On behalf of","Marco in Sales"');
  });

  it('quotes a supplier name containing a comma rather than splitting it', () => {
    const csv = buildExportManifestCsv(
      [{ file_name: 'a.pdf', row: row({ supplier_name: 'Smith, Jones & Co' }) }],
      { tenant_name: 't', exported_by: 'u', exported_at: 'now' },
    );
    expect(csv).toContain('"Smith, Jones & Co"');
  });

  it('leaves an unknown lot or production date empty rather than inventing one', () => {
    const csv = buildExportManifestCsv(
      [{ file_name: 'a.pdf', row: row({ lot_label: null, production_date: null }) }],
      { tenant_name: 't', exported_by: 'u', exported_at: 'now' },
    );
    expect(csv.split('\r\n')[1]).toContain('"",""');
  });
});

describe('parseStringList', () => {
  it('is tolerant of null, junk and mixed content', () => {
    expect(parseStringList(null)).toEqual([]);
    expect(parseStringList('not json')).toEqual([]);
    expect(parseStringList('["a", 2, "b"]')).toEqual(['a', 'b']);
  });
});

describe('exportZipFileName', () => {
  it('is dated, so two in a downloads folder differ', () => {
    expect(exportZipFileName(new Date('2026-09-15T00:00:00Z'))).toBe('documents-2026-09-15.zip');
  });
});
