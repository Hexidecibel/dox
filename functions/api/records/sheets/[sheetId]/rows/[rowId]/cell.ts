import { logAudit, getClientIp } from '../../../../../../lib/db';
import {
  requireRole,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../../../lib/permissions';
import {
  loadSheetForUser,
  rebuildRowRefs,
  computeDisplayTitle,
  logRecordsActivity,
  parseRowData,
  refTypeForColumn,
} from '../../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../../lib/types';
import type {
  UpdateCellRequest,
  RecordColumnRow,
  RecordRowData,
} from '../../../../../../../shared/types';

interface RowSnapshot {
  id: string;
  sheet_id: string;
  tenant_id: string;
  data: string | null;
}

/**
 * PATCH /api/records/sheets/:sheetId/rows/:rowId/cell
 *
 * Single-cell update. Source of truth is D1: we merge the new value into
 * records_rows.data, recompute display_title if the title column was
 * touched, and resync records_row_refs for entity-typed columns.
 *
 * After D1 commits, we POST the edit payload to the SheetSession Durable
 * Object so connected WebSocket clients see the change. DO failure is
 * logged but NEVER fails the request — the D1 write stands and clients
 * catch up via snapshot on reconnect.
 *
 * Body: { column_key: string, value: unknown, clientSeq?: number }
 */
export const onRequestPatch: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const body = (await context.request.json()) as UpdateCellRequest & { clientSeq?: number };
    if (!body.column_key || typeof body.column_key !== 'string') {
      throw new BadRequestError('column_key is required');
    }

    // Load row + column in parallel.
    const [row, column] = await Promise.all([
      context.env.DB.prepare(
        'SELECT id, sheet_id, tenant_id, data FROM records_rows WHERE id = ? AND sheet_id = ?',
      )
        .bind(rowId, sheetId)
        .first<RowSnapshot>(),
      context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND key = ? AND archived = 0',
      )
        .bind(sheetId, body.column_key)
        .first<RecordColumnRow>(),
    ]);

    if (!row) {
      throw new NotFoundError('Row not found');
    }
    if (!column) {
      throw new NotFoundError(`Column ${body.column_key} not found on this sheet`);
    }

    const data: RecordRowData = parseRowData(row.data);
    const previousValue = data[body.column_key];
    data[body.column_key] = body.value;

    // Recompute display_title if the touched column is the title column.
    let nextDisplayTitle: string | null | undefined;
    if (column.is_title === 1) {
      // Only need columns when title-related; cheap query but skip otherwise.
      const cols = await context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0',
      )
        .bind(sheetId)
        .all<RecordColumnRow>();
      nextDisplayTitle = computeDisplayTitle(cols.results, data);
    }

    if (nextDisplayTitle !== undefined) {
      await context.env.DB.prepare(
        `UPDATE records_rows
           SET data = ?, display_title = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(JSON.stringify(data), nextDisplayTitle, user.id, rowId)
        .run();
    } else {
      await context.env.DB.prepare(
        `UPDATE records_rows
           SET data = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(JSON.stringify(data), user.id, rowId)
        .run();
    }

    // Resync row_refs only when an entity-ref column changed (avoids the
    // delete+reinsert churn on every plain text edit).
    if (refTypeForColumn(column.type)) {
      const cols = await context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0',
      )
        .bind(sheetId)
        .all<RecordColumnRow>();
      await rebuildRowRefs(context.env.DB, sheet.tenant_id, sheetId, rowId, cols.results, data);
    }

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_row.cell_updated',
      'records_row',
      rowId,
      JSON.stringify({ sheet_id: sheetId, column_key: body.column_key }),
      getClientIp(context.request),
    );

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId,
      actorId: user.id,
      kind: 'cell_updated',
      details: {
        column_key: body.column_key,
        from: previousValue ?? null,
        to: body.value ?? null,
      },
    });

    // Best-effort fan-out to the SheetSession Durable Object. Failures
    // here must NOT fail the request — D1 is canonical.
    let broadcastSeq: number | null = null;
    try {
      const stubId = context.env.SHEET_SESSION.idFromName(sheetId);
      const stub = context.env.SHEET_SESSION.get(stubId);
      const doResponse = await stub.fetch(
        new Request('https://sheet-session.do/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.id,
            rowId,
            columnKey: body.column_key,
            value: body.value,
            clientSeq: body.clientSeq,
          }),
        }),
      );
      if (doResponse.ok) {
        try {
          const json = (await doResponse.json()) as { seq?: number };
          if (typeof json.seq === 'number') broadcastSeq = json.seq;
        } catch {
          // Ignore parse error — broadcast still succeeded.
        }
      } else {
        console.error('SheetSession broadcast non-ok:', doResponse.status);
      }
    } catch (err) {
      console.error('SheetSession broadcast failed:', err);
    }

    return new Response(
      JSON.stringify({
        cell: {
          row_id: rowId,
          column_key: body.column_key,
          value: body.value,
        },
        seq: broadcastSeq,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update cell error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
