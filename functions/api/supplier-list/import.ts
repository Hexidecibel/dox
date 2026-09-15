/**
 * POST /api/supplier-list/import — the verified supplier list, derived into
 * supplier requirements (migration 0111).
 *
 * The one door to `runSupplierListImport`. The Supplier Requirements page
 * posts a spreadsheet here; a webhook or API feed posts `rows` here. The rules
 * live in shared/requirementDerivation.ts and nowhere else, so a supplier's
 * requirements cannot depend on which caller delivered its row.
 *
 * Body (exactly one list source):
 *   csv          CSV text in the template's columns
 *   xlsx_base64  an .xlsx workbook; the first sheet is read
 *   rows         structured rows keyed by template field
 *   rerun_of     the id of an earlier APPLIED run; its stored input is re-run
 * plus dry_run (default TRUE — a caller has to say it means to write),
 * file_name, pack, tenant_id (super_admin only).
 *
 * dry_run writes nothing at all. Apply creates missing suppliers, writes the
 * derived rows with provenance, flags derived rows no longer on the list, and
 * stores the run.
 *
 * Role: super_admin, org_admin — the tier that owns /api/supplier-requirements.
 */

import { getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, NotFoundError, errorToResponse } from '../../lib/permissions';
import { resolveWriteTenant } from '../../lib/registry-vocab';
import { runSupplierListImport } from '../../lib/supplier-list-import';
import {
  SUPPLIER_LIST_MAX_ROWS,
  csvToSupplierListRows,
  type SupplierListInputRow,
} from '../../../shared/supplierListTemplate';
import type { Env, User } from '../../lib/types';
import type { SupplierListImportRequest } from '../../../shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** ~5 MB of workbook. A supplier list past that is not a supplier list. */
const MAX_XLSX_BASE64 = 7_000_000;
const MAX_CSV_CHARS = 5_000_000;

async function xlsxToCsv(base64: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const bin = atob(base64.replace(/^data:[^,]*,/, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new BadRequestError('xlsx_base64 is not valid base64');
  }
  const XLSX = await import('xlsx');
  let workbook: import('xlsx').WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: 'array' });
  } catch {
    throw new BadRequestError('The workbook could not be read. Save it as .xlsx or .csv and try again.');
  }
  const first = workbook.SheetNames[0];
  const sheet = first ? workbook.Sheets[first] : undefined;
  if (!sheet) throw new BadRequestError('The workbook has no sheets');
  return XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n', blankrows: false });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json().catch(() => null)) as SupplierListImportRequest | null;
    if (!body || typeof body !== 'object') throw new BadRequestError('A JSON body is required');

    const tenantId = resolveWriteTenant(user, body.tenant_id);
    const dryRun = body.dry_run !== false;

    const sources = [body.csv, body.xlsx_base64, body.rows, body.rerun_of].filter(
      (v) => v !== undefined && v !== null,
    );
    if (sources.length !== 1) {
      throw new BadRequestError('Send exactly one of: csv, xlsx_base64, rows, rerun_of');
    }

    let format: 'csv' | 'xlsx' | 'rows';
    let rows: Array<{ line: number; row: Partial<SupplierListInputRow> }>;
    let unrecognizedHeaders: string[] = [];
    let fileName = body.file_name ? String(body.file_name).slice(0, 255) : null;

    if (typeof body.csv === 'string' || typeof body.xlsx_base64 === 'string') {
      let text: string;
      if (typeof body.csv === 'string') {
        if (body.csv.length > MAX_CSV_CHARS) throw new BadRequestError('The CSV is too large');
        format = 'csv';
        text = body.csv;
      } else {
        const b64 = body.xlsx_base64 as string;
        if (b64.length > MAX_XLSX_BASE64) throw new BadRequestError('The workbook is too large');
        format = 'xlsx';
        text = await xlsxToCsv(b64);
      }
      const parsed = csvToSupplierListRows(text);
      if (parsed.missingRequiredHeaders.length > 0) {
        throw new BadRequestError(
          `The file is missing required columns: ${parsed.missingRequiredHeaders.join(', ')}. Download the template for the expected headers.`,
        );
      }
      rows = parsed.rows;
      unrecognizedHeaders = parsed.unrecognizedHeaders;
    } else if (Array.isArray(body.rows)) {
      format = 'rows';
      rows = body.rows.map((row, i) => ({ line: i + 1, row: (row ?? {}) as Partial<SupplierListInputRow> }));
    } else if (typeof body.rerun_of === 'string') {
      const run = await context.env.DB.prepare(
        'SELECT input_format, file_name, input_rows FROM supplier_list_imports WHERE id = ? AND tenant_id = ?',
      )
        .bind(body.rerun_of, tenantId)
        .first<{ input_format: 'csv' | 'xlsx' | 'rows'; file_name: string | null; input_rows: string }>();
      if (!run) throw new NotFoundError('Import run not found');
      format = run.input_format;
      fileName = fileName ?? run.file_name;
      rows = JSON.parse(run.input_rows) as typeof rows;
    } else {
      throw new BadRequestError('csv and xlsx_base64 must be strings, rows an array, rerun_of an id');
    }

    if (rows.length === 0) throw new BadRequestError('The list has no rows');
    if (rows.length > SUPPLIER_LIST_MAX_ROWS) {
      throw new BadRequestError(`At most ${SUPPLIER_LIST_MAX_ROWS} rows per import`);
    }

    const result = await runSupplierListImport(context.env.DB, {
      tenantId,
      actorId: user.id,
      ip: getClientIp(context.request),
      dryRun,
      fileName,
      format,
      rows,
      unrecognizedHeaders,
      packOverride: body.pack ?? null,
    });
    return json(result, dryRun ? 200 : 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('supplier list import error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
