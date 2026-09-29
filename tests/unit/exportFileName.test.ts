/**
 * Rules table H4 (AJ Conner, 2026-09-20): the original file name never
 * travels to the customer. `generatedExportFileName` / `exportFileNames` in
 * functions/lib/document-export.ts build the name every exported file goes
 * under: `{Supplier}_{DocType}_{lot or date}_{n}.{ext}`.
 */
import { describe, it, expect } from 'vitest';
import {
  EXPORT_FILE_NAME_MAX,
  exportFileNames,
  externalDocumentTitle,
  generatedExportFileName,
  type ExportDocumentRow,
} from '../../functions/lib/document-export';

function row(over: Partial<ExportDocumentRow> = {}): ExportDocumentRow {
  return {
    document_id: 'd1',
    title: 'Some title',
    supplier_name: 'Darigold, Inc.',
    document_type_name: 'Certificate of Analysis',
    version_number: 1,
    file_name: 'internal - do not send.PDF',
    r2_key: 'k',
    mime_type: 'application/pdf',
    file_size: 10,
    created_at: '2026-09-01 10:00:00',
    lot_label: null,
    production_date: null,
    ...over,
  };
}

describe('generatedExportFileName', () => {
  it('is supplier, type, lot, position and the extension, and nothing of the uploaded name', () => {
    const name = generatedExportFileName(row({ lot_label: '10426203 / 03' }), 1);
    expect(name).toBe('Darigold-Inc_Certificate-of-Analysis_10426203-03_1.pdf');
    expect(name).not.toMatch(/internal|send/i);
  });

  it('uses the production date, then the filed date, when there is no lot', () => {
    expect(generatedExportFileName(row({ production_date: '2026-07-22' }), 2)).toBe(
      'Darigold-Inc_Certificate-of-Analysis_2026-07-22_2.pdf',
    );
    expect(generatedExportFileName(row(), 3)).toBe('Darigold-Inc_Certificate-of-Analysis_2026-09-01_3.pdf');
  });

  it('names the first of several lots and counts the rest', () => {
    expect(generatedExportFileName(row({ lot_label: '111; 222; 333' }), 1)).toBe(
      'Darigold-Inc_Certificate-of-Analysis_111-plus2_1.pdf',
    );
  });

  it('is plain ASCII: accents folded, punctuation collapsed', () => {
    const name = generatedExportFileName(
      row({ supplier_name: 'Crème & Brûlée Laiterie S.A.', document_type_name: 'Spec/Sheet (FR)' }),
      1,
    );
    expect(name).toBe('Creme-and-Brulee-Laiterie-S-A_Spec-Sheet-FR_2026-09-01_1.pdf');
    expect(/^[\x21-\x7e]+$/.test(name)).toBe(true);
  });

  it('leaves out a missing supplier and falls back to "Document" for a missing type', () => {
    expect(generatedExportFileName(row({ supplier_name: null, document_type_name: null }), 1)).toBe(
      'Document_2026-09-01_1.pdf',
    );
  });

  it('takes the extension from the MIME type when the name has none', () => {
    expect(generatedExportFileName(row({ file_name: 'no extension', mime_type: 'image/png' }), 1)).toMatch(/_1\.png$/);
  });

  it('never exceeds the limit, and keeps the position and extension when it trims', () => {
    const name = generatedExportFileName(row({ supplier_name: 'S'.repeat(150), lot_label: 'L'.repeat(80) }), 12);
    expect(name.length).toBeLessThanOrEqual(EXPORT_FILE_NAME_MAX);
    expect(name.endsWith('_12.pdf')).toBe(true);
  });
});

describe('exportFileNames', () => {
  it('is deterministic and unique within one export, even for identical documents', () => {
    const rows = [row(), row(), row({ lot_label: 'A' })];
    const names = exportFileNames(rows);
    expect(new Set(names).size).toBe(3);
    expect(exportFileNames(rows)).toEqual(names);
    expect(names).not.toContain('manifest.csv');
  });
});

describe('externalDocumentTitle', () => {
  it('replaces a title that is the uploaded file name, keeps one a person wrote', () => {
    expect(externalDocumentTitle(row({ title: 'internal - do not send' }))).toBe(
      'Certificate of Analysis - Darigold, Inc.',
    );
    expect(externalDocumentTitle(row({ title: 'Cream COA July', lot_label: null }))).toBe('Cream COA July');
    expect(externalDocumentTitle(row({ title: '', lot_label: '55501 / 01' }))).toBe(
      'Certificate of Analysis - Darigold, Inc. - Lot 55501 / 01',
    );
  });
});
