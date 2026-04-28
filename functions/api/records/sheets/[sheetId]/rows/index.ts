import { generateId, logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
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
  CreateRowRequest,
  RecordRowData,
  RecordColumnRow,
  ApiRecordRow,
} from '../../../../../../shared/types';

/**
 * GET /api/records/sheets/:sheetId/rows
 *
 * Offset-paginated to match the project convention (`documents/index.ts`)
 * and the typed `RecordRowListResponse { rows, total, limit, offset }`.
 * The task spec mentioned cursor pagination but no other endpoint in
 * this codebase uses cursors and the response type pins offset — flagged
 * for review.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const url = new URL(context.request.url);

    await loadSheetForUser(context.env.DB, sheetId, user);

    const includeArchived = url.searchParams.get('archived') === '1';
    const parentRowId = url.searchParams.get('parent_row_id');

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = ['r.sheet_id = ?'];
    const params: (string | number)[] = [sheetId];

    if (!includeArchived) {
      conditions.push('r.archived = 0');
    }
    if (parentRowId) {
      conditions.push('r.parent_row_id = ?');
      params.push(parentRowId);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRow = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM records_rows r ${where}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const rows = await context.env.DB.prepare(
      `SELECT r.*, cu.name as creator_name, uu.name as updater_name
       FROM records_rows r
       LEFT JOIN users cu ON r.created_by = cu.id
       LEFT JOIN users uu ON r.updated_by = uu.id
       ${where}
       ORDER BY r.position ASC, r.created_at ASC
       LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all<ApiRecordRow>();

    return new Response(
      JSON.stringify({
        rows: rows.results,
        total: countRow?.total ?? 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List rows error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/records/sheets/:sheetId/rows
 *
 * Creates a row. `data` is keyed by column.key. If `position` is omitted,
 * the new row appends to the end (max(position)+1).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const body = (await context.request.json()) as CreateRowRequest;

    // Reject string keys we won't honor — `data` must be an object.
    if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data))) {
      throw new BadRequestError('data must be an object keyed by column key');
    }
    const data: RecordRowData = body.data ?? {};

    // Pick position
    let position = body.position;
    if (position === undefined || position === null) {
      const maxRow = await context.env.DB.prepare(
        'SELECT COALESCE(MAX(position), -1) as max_position FROM records_rows WHERE sheet_id = ?',
      )
        .bind(sheetId)
        .first<{ max_position: number }>();
      position = (maxRow?.max_position ?? -1) + 1;
    }

    // Load columns to compute display_title and refs
    const columnsResult = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0',
    )
      .bind(sheetId)
      .all<RecordColumnRow>();

    const displayTitle =
      body.display_title !== undefined && body.display_title !== null
        ? body.display_title
        : computeDisplayTitle(columnsResult.results, data);

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO records_rows
         (id, sheet_id, tenant_id, display_title, data, position, parent_row_id, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        sheetId,
        sheet.tenant_id,
        displayTitle,
        JSON.stringify(data),
        position,
        body.parent_row_id ?? null,
        user.id,
        user.id,
      )
      .run();

    await rebuildRowRefs(
      context.env.DB,
      sheet.tenant_id,
      sheetId,
      id,
      columnsResult.results,
      data,
    );

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_row.created',
      'records_row',
      id,
      JSON.stringify({ sheet_id: sheetId }),
      getClientIp(context.request),
    );

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId: id,
      actorId: user.id,
      kind: 'created',
      details: { display_title: displayTitle },
    });

    const row = await context.env.DB.prepare(
      'SELECT * FROM records_rows WHERE id = ?',
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ row }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create row error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
