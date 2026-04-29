import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  NotFoundError,
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
  UpdateColumnRequest,
  RecordColumnType,
} from '../../../../../../shared/types';

const COLUMN_TYPES: RecordColumnType[] = [
  'text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime',
  'duration', 'checkbox', 'dropdown_single', 'dropdown_multi', 'contact',
  'email', 'url', 'phone', 'attachment', 'formula', 'rollup',
  'supplier_ref', 'product_ref', 'document_ref', 'record_ref', 'customer_ref',
];

interface ColumnRow {
  id: string;
  sheet_id: string;
  tenant_id: string;
  key: string;
  is_title: number;
  archived: number;
}

async function loadColumnInSheet(
  db: D1Database,
  sheetId: string,
  columnId: string,
): Promise<ColumnRow> {
  const column = await db
    .prepare('SELECT id, sheet_id, tenant_id, key, is_title, archived FROM records_columns WHERE id = ? AND sheet_id = ?')
    .bind(columnId, sheetId)
    .first<ColumnRow>();
  if (!column) {
    throw new NotFoundError('Column not found');
  }
  return column;
}

/**
 * PUT /api/records/sheets/:sheetId/columns/:columnId
 * Update a column. Type changes are accepted but DO NOT migrate existing
 * data — handlers downstream of cell writes are expected to coerce.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const columnId = context.params.columnId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    await loadSheetForUser(context.env.DB, sheetId, user);
    const column = await loadColumnInSheet(context.env.DB, sheetId, columnId);

    const body = (await context.request.json()) as UpdateColumnRequest;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.label !== undefined) {
      const label = sanitizeString(body.label);
      if (!label) throw new BadRequestError('label cannot be empty');
      updates.push('label = ?');
      params.push(label);
    }

    if (body.key !== undefined) {
      const newKey = slugifyRecords(body.key);
      if (!newKey) throw new BadRequestError('Invalid key');
      if (newKey !== column.key) {
        const collision = await context.env.DB.prepare(
          'SELECT id FROM records_columns WHERE sheet_id = ? AND key = ? AND id != ?',
        )
          .bind(sheetId, newKey, columnId)
          .first();
        if (collision) {
          return new Response(
            JSON.stringify({ error: 'A column with this key already exists for this sheet' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      updates.push('key = ?');
      params.push(newKey);
    }

    if (body.type !== undefined) {
      if (!COLUMN_TYPES.includes(body.type)) {
        throw new BadRequestError('Invalid column type');
      }
      updates.push('type = ?');
      params.push(body.type);
    }

    if (body.config !== undefined) {
      updates.push('config = ?');
      params.push(body.config ? JSON.stringify(body.config) : null);
    }

    if (body.required !== undefined) {
      updates.push('required = ?');
      params.push(body.required ? 1 : 0);
    }

    if (body.is_title !== undefined) {
      const next = body.is_title ? 1 : 0;
      if (next === 1 && column.is_title === 0) {
        // Clear other title columns first.
        await context.env.DB.prepare(
          "UPDATE records_columns SET is_title = 0, updated_at = datetime('now') WHERE sheet_id = ? AND is_title = 1",
        )
          .bind(sheetId)
          .run();
      }
      updates.push('is_title = ?');
      params.push(next);
    }

    if (body.display_order !== undefined) {
      updates.push('display_order = ?');
      params.push(body.display_order);
    }

    if (body.width !== undefined) {
      updates.push('width = ?');
      params.push(body.width ?? null);
    }

    if (body.archived !== undefined) {
      updates.push('archived = ?');
      params.push(body.archived ? 1 : 0);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(columnId);

    await context.env.DB.prepare(
      `UPDATE records_columns SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      column.tenant_id,
      'records_column.updated',
      'records_column',
      columnId,
      JSON.stringify({ sheet_id: sheetId, changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE id = ?',
    )
      .bind(columnId)
      .first();

    return new Response(JSON.stringify({ column: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update column error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/records/sheets/:sheetId/columns/:columnId
 * Soft-archive. Cell data in records_rows.data is left intact so
 * unarchive (PUT archived=false) restores the column AND its values.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const columnId = context.params.columnId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    await loadSheetForUser(context.env.DB, sheetId, user);
    const column = await loadColumnInSheet(context.env.DB, sheetId, columnId);

    await context.env.DB.prepare(
      "UPDATE records_columns SET archived = 1, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(columnId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      column.tenant_id,
      'records_column.archived',
      'records_column',
      columnId,
      JSON.stringify({ sheet_id: sheetId, key: column.key }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Archive column error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
