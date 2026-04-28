import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import {
  loadSheetForUser,
  rebuildRowRefs,
  computeDisplayTitle,
  logRecordsActivity,
} from '../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../lib/types';
import type {
  UpdateRowRequest,
  RecordRowData,
  RecordColumnRow,
  ApiRecordRowRef,
  ApiRecordRowAttachment,
} from '../../../../../../shared/types';

interface RowRecord {
  id: string;
  sheet_id: string;
  tenant_id: string;
  display_title: string | null;
  data: string | null;
  position: number;
  parent_row_id: string | null;
  archived: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

async function loadRowInSheet(
  db: D1Database,
  sheetId: string,
  rowId: string,
): Promise<RowRecord> {
  const row = await db
    .prepare('SELECT * FROM records_rows WHERE id = ? AND sheet_id = ?')
    .bind(rowId, sheetId)
    .first<RowRecord>();
  if (!row) {
    throw new NotFoundError('Row not found');
  }
  return row;
}

/**
 * GET /api/records/sheets/:sheetId/rows/:rowId
 * Returns the row plus its row_refs and attachments. The row drawer
 * needs all three on mount; comments/activity feeds are fetched
 * separately by the drawer endpoints (not yet built).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);
    const row = await loadRowInSheet(context.env.DB, sheetId, rowId);

    const refs = await context.env.DB.prepare(
      'SELECT * FROM records_row_refs WHERE row_id = ?',
    )
      .bind(rowId)
      .all<ApiRecordRowRef>();

    const attachments = await context.env.DB.prepare(
      'SELECT * FROM records_row_attachments WHERE row_id = ? ORDER BY created_at ASC',
    )
      .bind(rowId)
      .all<ApiRecordRowAttachment>();

    return new Response(
      JSON.stringify({
        row,
        refs: refs.results,
        attachments: attachments.results,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get row error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/records/sheets/:sheetId/rows/:rowId
 * Replace the row's full payload. If `data` is provided, it FULLY
 * REPLACES records_rows.data (per the spec — this is the "replace full
 * row data" endpoint; PATCH /cell handles partial updates).
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const row = await loadRowInSheet(context.env.DB, sheetId, rowId);

    const body = (await context.request.json()) as UpdateRowRequest;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    let nextData: RecordRowData | null = null;

    if (body.data !== undefined) {
      if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
        throw new BadRequestError('data must be an object keyed by column key');
      }
      nextData = body.data;
      updates.push('data = ?');
      params.push(JSON.stringify(nextData));
    }

    if (body.display_title !== undefined) {
      updates.push('display_title = ?');
      params.push(body.display_title);
    }

    if (body.parent_row_id !== undefined) {
      updates.push('parent_row_id = ?');
      params.push(body.parent_row_id);
    }

    if (body.position !== undefined) {
      updates.push('position = ?');
      params.push(body.position);
    }

    if (body.archived !== undefined) {
      updates.push('archived = ?');
      params.push(body.archived ? 1 : 0);
    }

    // If data changed but caller didn't provide an explicit display_title,
    // recompute from the title column.
    if (nextData && body.display_title === undefined) {
      const cols = await context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0',
      )
        .bind(sheetId)
        .all<RecordColumnRow>();
      const computed = computeDisplayTitle(cols.results, nextData);
      updates.push('display_title = ?');
      params.push(computed);
    }

    updates.push('updated_by = ?');
    params.push(user.id);

    if (updates.length === 1) {
      // Only the implicit updated_by; nothing meaningful changed.
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(rowId);

    await context.env.DB.prepare(
      `UPDATE records_rows SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    // Rebuild refs if data changed.
    if (nextData) {
      const cols = await context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0',
      )
        .bind(sheetId)
        .all<RecordColumnRow>();
      await rebuildRowRefs(context.env.DB, sheet.tenant_id, sheetId, rowId, cols.results, nextData);
    }

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_row.updated',
      'records_row',
      rowId,
      JSON.stringify({ sheet_id: sheetId, fields: Object.keys(body) }),
      getClientIp(context.request),
    );

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId,
      actorId: user.id,
      kind: 'updated',
      details: {
        fields: Object.keys(body),
        previous_display_title: row.display_title,
      },
    });

    const updated = await context.env.DB.prepare(
      'SELECT * FROM records_rows WHERE id = ?',
    )
      .bind(rowId)
      .first();

    return new Response(JSON.stringify({ row: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update row error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/records/sheets/:sheetId/rows/:rowId
 * Soft-archive. Refs and attachments stay attached for unarchive.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const row = await loadRowInSheet(context.env.DB, sheetId, rowId);

    await context.env.DB.prepare(
      "UPDATE records_rows SET archived = 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(user.id, rowId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_row.archived',
      'records_row',
      rowId,
      JSON.stringify({ sheet_id: sheetId, display_title: row.display_title }),
      getClientIp(context.request),
    );

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId,
      actorId: user.id,
      kind: 'archived',
      details: { display_title: row.display_title },
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Archive row error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
