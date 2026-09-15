/**
 * The verified supplier list template (shared/supplierListTemplate.ts): what
 * a QA manager's re-saved spreadsheet turns into.
 */

import { describe, it, expect } from 'vitest';
import {
  csvToSupplierListRows,
  mapHeaders,
  normalizeSupplierListRow,
  parseApproved,
  parseCsv,
  parseSupplierCategory,
  splitClaims,
  supplierListTemplateCsv,
} from '../../shared/supplierListTemplate';
import templateFixture from '../fixtures/supplier-list/verified-supplier-list-template.csv?raw';
import medosweetFixture from '../fixtures/supplier-list/medosweet-verified-suppliers.csv?raw';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('supplier list template', () => {
  it('the downloadable template is the committed fixture', () => {
    expect(lf(supplierListTemplateCsv())).toBe(lf(templateFixture));
  });

  it('parses quoted fields, doubled quotes, CRLF, a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n,\n"multi\nline",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('maps re-titled headers and reports what it did not recognise', () => {
    const { index, unrecognized, missingRequired } = mapHeaders([
      'Vendor',
      'Category',
      'APPROVED',
      'Item #',
      'Description',
      'Certifications',
      'Notes',
    ]);
    expect(index).toEqual({
      supplier_name: 0,
      supplier_category: 1,
      approved: 2,
      product_sku: 3,
      product_name: 4,
      claims: 5,
    });
    expect(unrecognized).toEqual(['Notes']);
    expect(missingRequired).toEqual([]);
    expect(mapHeaders(['Supplier name']).missingRequired).toEqual(['Supplier category', 'Approved (Y/N)']);
  });

  it('reads the Medosweet-like example with every row usable', () => {
    const { rows, missingRequiredHeaders } = csvToSupplierListRows(medosweetFixture);
    expect(missingRequiredHeaders).toEqual([]);
    expect(rows).toHaveLength(8);
    const normalized = rows.map(({ line, row }) => normalizeSupplierListRow(line, row));
    expect(normalized.every((r) => r.problems.length === 0)).toBe(true);
    expect(normalized[0]).toMatchObject({
      line: 2,
      supplier_name: 'Darigold, Inc.',
      category: 'ingredient',
      approved: true,
      product_sku: '0801',
      claims: ['rBST-free'],
    });
    expect(normalized[3].claims).toEqual(['kosher', 'halal']);
    expect(normalized[7].approved).toBe(false);
  });

  it('is strict about approval and category, lenient about their spelling', () => {
    expect(parseApproved('Yes')).toBe(true);
    expect(parseApproved('n')).toBe(false);
    expect(parseApproved('maybe')).toBeNull();
    expect(parseSupplierCategory('Chemical / Sanitation')).toBe('chemical-sanitation');
    expect(parseSupplierCategory('Co-Packer')).toBe('co-packer');
    expect(parseSupplierCategory('widgets')).toBeNull();

    const bad = normalizeSupplierListRow(5, { supplier_name: '', supplier_category: 'widgets', approved: 'maybe' });
    expect(bad.problems).toEqual([
      'Supplier name is blank.',
      'Supplier category "widgets" is not one of: ingredient, packaging, chemical-sanitation, distributor, co-packer.',
      'Approved "maybe" is not Y or N.',
    ]);
  });

  it('splits claims on commas, semicolons and pipes, de-duplicating case-insensitively', () => {
    expect(splitClaims('Kosher; halal | organic, kosher,  ')).toEqual(['Kosher', 'halal', 'organic']);
  });

  it('ignores a malformed contact email with a warning rather than rejecting the row', () => {
    const r = normalizeSupplierListRow(2, {
      supplier_name: 'Acme',
      supplier_category: 'packaging',
      approved: 'Y',
      supplier_contact_email: 'not an email',
    });
    expect(r.problems).toEqual([]);
    expect(r.supplier_contact_email).toBeNull();
    expect(r.warnings[0]).toMatch(/does not look like an email/);
  });
});
