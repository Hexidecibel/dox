import { generateId, logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { sanitizeString } from '../../../../../lib/validation';
import {
  loadSheetForUser,
  slugifyRecords,
} from '../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../lib/types';
import type {
  CreateColumnRequest,
  RecordColumnType,
  ApiRecordColumn,
} from '../../../../../../shared/types';

/** Allowed column types — mirror the CHECK in 0040 so we 400 instead of 500. */
const COLUMN_TYPES: RecordColumnType[] = [
  'text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime',
  'duration', 'checkbox', 'dropdown_single', 'dropdown_multi', 'contact',
  'email', 'url', 'phone', 'attachment', 'formula', 'rollup',
  'supplier_ref', 'product_ref', 'document_ref', 'record_ref',
];

/**
 * GET /api/records/sheets/:sheetId/columns
 * Ordered by display_order. Archived columns omitted unless ?archived=1.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const url = new URL(context.request.url);
    const includeArchived = url.searchParams.get('archived') === '1';

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const where = includeArchived ? 'sheet_id = ?' : 'sheet_id = ? AND archived = 0';
    const result = await context.env.DB.prepare(
      `SELECT * FROM records_columns WHERE ${where} ORDER BY display_order ASC, created_at ASC`,
    )
      .bind(sheetId)
      .all<ApiRecordColumn>();

    return new Response(
      JSON.stringify({ columns: result.results, sheet_id: sheet.id }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List columns error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/records/sheets/:sheetId/columns
 * Create a column. `key` defaults to slugified label; uniqueness is
 * enforced per-sheet (matches the schema UNIQUE(sheet_id, key)).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const body = (await context.request.json()) as CreateColumnRequest;

    if (!body.label || !body.label.trim()) {
      throw new BadRequestError('label is required');
    }
    if (!body.type || !COLUMN_TYPES.includes(body.type)) {
      throw new BadRequestError('type is required and must be a valid column type');
    }

    const label = sanitizeString(body.label);
    const baseKey = body.key ? slugifyRecords(body.key) : slugifyRecords(label);
    if (!baseKey) {
      throw new BadRequestError('Could not derive a valid key from label');
    }

    // Resolve key collision
    let key = baseKey;
    let attempt = 1;
    while (true) {
      const collision = await context.env.DB.prepare(
        'SELECT id FROM records_columns WHERE sheet_id = ? AND key = ?',
      )
        .bind(sheetId, key)
        .first();
      if (!collision) break;
      attempt += 1;
      key = `${baseKey}_${attempt}`;
      if (attempt > 50) {
        throw new BadRequestError('Could not allocate a unique column key');
      }
    }

    // Pick display_order: explicit, else max+1
    let displayOrder = body.display_order;
    if (displayOrder === undefined || displayOrder === null) {
      const maxRow = await context.env.DB.prepare(
        'SELECT COALESCE(MAX(display_order), -1) as max_order FROM records_columns WHERE sheet_id = ?',
      )
        .bind(sheetId)
        .first<{ max_order: number }>();
      displayOrder = (maxRow?.max_order ?? -1) + 1;
    }

    // Enforce single is_title per sheet: clearing if requested.
    const isTitle = body.is_title ? 1 : 0;
    if (isTitle) {
      await context.env.DB.prepare(
        "UPDATE records_columns SET is_title = 0, updated_at = datetime('now') WHERE sheet_id = ? AND is_title = 1",
      )
        .bind(sheetId)
        .run();
    }

    const id = generateId();
    const config = body.config ? JSON.stringify(body.config) : null;

    await context.env.DB.prepare(
      `INSERT INTO records_columns
         (id, sheet_id, tenant_id, key, label, type, config, required, is_title, display_order, width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        sheetId,
        sheet.tenant_id,
        key,
        label,
        body.type,
        config,
        body.required ? 1 : 0,
        isTitle,
        displayOrder,
        body.width ?? null,
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_column.created',
      'records_column',
      id,
      JSON.stringify({ sheet_id: sheetId, key, label, type: body.type }),
      getClientIp(context.request),
    );

    const column = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE id = ?',
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ column }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create column error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
