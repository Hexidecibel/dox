/**
 * The verified supplier list template — "easy mode" for requirements derived
 * from real data (AJ Conner, 2026-09-14).
 *
 * ONE ROW PER (SUPPLIER, PRODUCT BOUGHT). A supplier we buy nothing itemised
 * from (a pest-control contractor, a distributor) is one row with the product
 * columns left blank. That shape is what a QA manager already keeps — the
 * approved supplier list with the items against it — and it needs no second
 * sheet, no ids, and no knowledge of our vocabulary.
 *
 * PURE. No D1, no network, no DOM. The page uses it to generate the
 * downloadable template; the API uses it to parse what comes back. A future
 * webhook caller may skip the spreadsheet and send `rows` directly, and those
 * rows go through `normalizeSupplierListRow` exactly as parsed CSV rows do.
 *
 * Headers are matched leniently (case, spaces, punctuation and a handful of
 * obvious synonyms) because the file will have been re-saved by Excel and
 * retitled by a person. Values are matched strictly: an "approved" that is not
 * recognisably yes or no REJECTS the row rather than guessing, because a
 * guessed approval is exactly what produced the uniform checklist this
 * replaces.
 */

export type SupplierCategory =
  | 'ingredient'
  | 'packaging'
  | 'chemical-sanitation'
  | 'distributor'
  | 'co-packer';

export const SUPPLIER_CATEGORIES: readonly SupplierCategory[] = [
  'ingredient',
  'packaging',
  'chemical-sanitation',
  'distributor',
  'co-packer',
];

export const SUPPLIER_CATEGORY_LABELS: Record<SupplierCategory, string> = {
  ingredient: 'Ingredient',
  packaging: 'Packaging',
  'chemical-sanitation': 'Chemical / sanitation',
  distributor: 'Distributor',
  'co-packer': 'Co-packer',
};

/** The template's columns, in order. `key` is the normalized field name. */
export interface SupplierListColumn {
  key: keyof SupplierListInputRow;
  header: string;
  required: boolean;
  help: string;
  synonyms: readonly string[];
}

export const SUPPLIER_LIST_COLUMNS: readonly SupplierListColumn[] = [
  {
    key: 'supplier_name',
    header: 'Supplier name',
    required: true,
    help: 'As you know them. Matched to existing suppliers by name and known aliases; a new name creates the supplier.',
    synonyms: ['supplier', 'vendor', 'vendor name', 'company'],
  },
  {
    key: 'supplier_contact_email',
    header: 'Supplier contact email',
    required: false,
    help: 'Optional. Recorded on the import for reference.',
    synonyms: ['contact email', 'email', 'supplier email', 'contact'],
  },
  {
    key: 'supplier_category',
    header: 'Supplier category',
    required: true,
    help: 'ingredient, packaging, chemical-sanitation, distributor, or co-packer.',
    synonyms: ['category', 'supplier type', 'type', 'vendor type'],
  },
  {
    key: 'approved',
    header: 'Approved (Y/N)',
    required: true,
    help: 'Y if the supplier is on your approved list. N rows derive nothing.',
    synonyms: ['approved', 'approved y n', 'is approved', 'status'],
  },
  {
    key: 'product_sku',
    header: 'Product SKU',
    required: false,
    help: 'Your item number for the product bought (or the supplier\'s). Leave blank if nothing itemised is bought.',
    synonyms: ['sku', 'item', 'item number', 'item #', 'product code', 'product number'],
  },
  {
    key: 'product_name',
    header: 'Product name',
    required: false,
    help: 'The product bought from this supplier.',
    synonyms: ['product', 'item name', 'description', 'product description'],
  },
  {
    key: 'claims',
    header: 'Claims made',
    required: false,
    help: 'Claims made on this product, comma separated: kosher, halal, organic, rBST-free, non-GMO, gluten-free...',
    synonyms: ['claims', 'claim', 'certifications', 'product claims'],
  },
];

/** A row as a caller supplies it: every value a string, possibly blank. */
export interface SupplierListInputRow {
  supplier_name: string;
  supplier_contact_email: string;
  supplier_category: string;
  approved: string;
  product_sku: string;
  product_name: string;
  claims: string;
}

/** A row after validation. `problems` non-empty means the row is rejected. */
export interface NormalizedSupplierListRow {
  /** 1-based line in the source file (header is line 1), or row index + 1 for JSON rows. */
  line: number;
  supplier_name: string;
  supplier_contact_email: string | null;
  category: SupplierCategory | null;
  approved: boolean | null;
  product_sku: string | null;
  product_name: string | null;
  /** Claim phrases as written, split and trimmed. Matched to claim types later. */
  claims: string[];
  /** Reasons the row cannot be used at all. */
  problems: string[];
  /** Things that do not reject the row but a person should see. */
  warnings: string[];
}

export function normalizeHeader(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Map a file's header row onto template keys. Returns the column index per
 * key, plus the headers nobody recognised (reported, never an error — an
 * extra "Notes" column is normal).
 */
export function mapHeaders(headers: readonly string[]): {
  index: Partial<Record<keyof SupplierListInputRow, number>>;
  unrecognized: string[];
  missingRequired: string[];
} {
  const index: Partial<Record<keyof SupplierListInputRow, number>> = {};
  const unrecognized: string[] = [];
  headers.forEach((raw, i) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    const col = SUPPLIER_LIST_COLUMNS.find(
      (c) =>
        normalizeHeader(c.header) === h ||
        normalizeHeader(c.key) === h ||
        c.synonyms.some((s) => normalizeHeader(s) === h),
    );
    if (col && index[col.key] === undefined) index[col.key] = i;
    else unrecognized.push(raw);
  });
  const missingRequired = SUPPLIER_LIST_COLUMNS.filter(
    (c) => c.required && index[c.key] === undefined,
  ).map((c) => c.header);
  return { index, unrecognized, missingRequired };
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside
 * quotes, CRLF. A claims cell reads `"kosher, halal"`, so the naive
 * split-on-comma parser elsewhere in the codebase would cut it in half.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines (every cell empty) are not rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The downloadable template: header row plus two illustrative rows. */
export function supplierListTemplateCsv(): string {
  return toCsv([
    SUPPLIER_LIST_COLUMNS.map((c) => c.header),
    ['Example Dairy Co', 'qa@exampledairy.com', 'ingredient', 'Y', '10042', 'Unsalted Butter 25kg', 'kosher, rBST-free'],
    ['Example Sanitation Supply', '', 'chemical-sanitation', 'Y', '', '', ''],
  ]);
}

/** Split the file into input rows keyed by template field. */
export function csvToSupplierListRows(text: string): {
  rows: Array<{ line: number; row: SupplierListInputRow }>;
  unrecognizedHeaders: string[];
  missingRequiredHeaders: string[];
} {
  const table = parseCsv(text);
  if (table.length === 0) {
    return { rows: [], unrecognizedHeaders: [], missingRequiredHeaders: SUPPLIER_LIST_COLUMNS.filter((c) => c.required).map((c) => c.header) };
  }
  const { index, unrecognized, missingRequired } = mapHeaders(table[0]);
  const rows = table.slice(1).map((cells, i) => {
    const get = (k: keyof SupplierListInputRow) => {
      const idx = index[k];
      return idx === undefined ? '' : String(cells[idx] ?? '');
    };
    return {
      line: i + 2,
      row: {
        supplier_name: get('supplier_name'),
        supplier_contact_email: get('supplier_contact_email'),
        supplier_category: get('supplier_category'),
        approved: get('approved'),
        product_sku: get('product_sku'),
        product_name: get('product_name'),
        claims: get('claims'),
      },
    };
  });
  return { rows, unrecognizedHeaders: unrecognized, missingRequiredHeaders: missingRequired };
}

const CATEGORY_SYNONYMS: Record<string, SupplierCategory> = {
  ingredient: 'ingredient',
  ingredients: 'ingredient',
  'raw material': 'ingredient',
  'raw materials': 'ingredient',
  food: 'ingredient',
  packaging: 'packaging',
  package: 'packaging',
  'packaging material': 'packaging',
  'packaging materials': 'packaging',
  chemical: 'chemical-sanitation',
  chemicals: 'chemical-sanitation',
  sanitation: 'chemical-sanitation',
  'chemical sanitation': 'chemical-sanitation',
  'chemical and sanitation': 'chemical-sanitation',
  'sanitation chemical': 'chemical-sanitation',
  'sanitation chemicals': 'chemical-sanitation',
  distributor: 'distributor',
  distribution: 'distributor',
  broker: 'distributor',
  'co packer': 'co-packer',
  copacker: 'co-packer',
  'co manufacturer': 'co-packer',
  'contract manufacturer': 'co-packer',
};

export function parseSupplierCategory(raw: string): SupplierCategory | null {
  const key = normalizeHeader(raw);
  if (!key) return null;
  return CATEGORY_SYNONYMS[key] ?? null;
}

export function parseApproved(raw: string): boolean | null {
  const v = normalizeHeader(raw);
  if (['y', 'yes', 'true', '1', 'approved', 'active'].includes(v)) return true;
  if (['n', 'no', 'false', '0', 'not approved', 'unapproved', 'inactive', 'disapproved'].includes(v)) return false;
  return null;
}

/** "kosher, halal; organic | rBST-free" -> ["kosher", "halal", "organic", "rBST-free"]. */
export function splitClaims(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? '').split(/[,;|\n]/)) {
    const t = part.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSupplierListRow(line: number, input: Partial<SupplierListInputRow>): NormalizedSupplierListRow {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const problems: string[] = [];
  const warnings: string[] = [];

  const supplierName = s(input.supplier_name);
  if (!supplierName) problems.push('Supplier name is blank.');

  const categoryRaw = s(input.supplier_category);
  const category = parseSupplierCategory(categoryRaw);
  if (!categoryRaw) {
    problems.push(`Supplier category is blank. Use one of: ${SUPPLIER_CATEGORIES.join(', ')}.`);
  } else if (!category) {
    problems.push(`Supplier category "${categoryRaw}" is not one of: ${SUPPLIER_CATEGORIES.join(', ')}.`);
  }

  const approvedRaw = s(input.approved);
  const approved = parseApproved(approvedRaw);
  if (!approvedRaw) problems.push('Approved is blank. Enter Y or N.');
  else if (approved === null) problems.push(`Approved "${approvedRaw}" is not Y or N.`);

  let email: string | null = s(input.supplier_contact_email) || null;
  if (email && !EMAIL_RE.test(email)) {
    warnings.push(`Contact email "${email}" does not look like an email address and was ignored.`);
    email = null;
  }

  const sku = s(input.product_sku) || null;
  const productName = s(input.product_name) || null;
  const claims = splitClaims(s(input.claims));
  if (claims.length > 0 && !sku && !productName) {
    warnings.push('Claims are listed with no product; they are applied to the supplier.');
  }

  return {
    line,
    supplier_name: supplierName,
    supplier_contact_email: email,
    category,
    approved,
    product_sku: sku,
    product_name: productName,
    claims,
    problems,
    warnings,
  };
}

/** The most rows one import will take. A list past this is a design review. */
export const SUPPLIER_LIST_MAX_ROWS = 2000;
