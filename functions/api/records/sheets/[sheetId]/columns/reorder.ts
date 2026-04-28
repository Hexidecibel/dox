import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { loadSheetForUser } from '../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../lib/types';
import type { ReorderColumnsRequest } from '../../../../../../shared/types';

/**
 * POST /api/records/sheets/:sheetId/columns/reorder
 *
 * Bulk-reorder. Accepts either:
 *   { column_ids: string[] }                          // typed shape (preferred)
 *   { columns: { column_id: string, position: number }[] }  // explicit positions
 *
 * The typed shape wins on the round-trip with `ReorderColumnsRequest` —
 * index in the array becomes display_order. The explicit form is
 * tolerated because the original spec for this task described it; flagged
 * in the report so we can settle on one.
 *
 * All listed columns must belong to this sheet. Unlisted columns keep
 * their existing display_order (so partial reorders don't reshuffle the
 * world). Updates are issued one row at a time — D1 doesn't expose a
 * transaction primitive in Pages Functions, but a partial failure here
 * leaves columns in a recoverable state because display_order is just
 * an ordinal.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const body = (await context.request.json()) as
      | ReorderColumnsRequest
      | { columns?: Array<{ column_id: string; position: number }> };

    let pairs: Array<{ column_id: string; position: number }> = [];

    if ('column_ids' in body && Array.isArray((body as ReorderColumnsRequest).column_ids)) {
      pairs = (body as ReorderColumnsRequest).column_ids.map((column_id, idx) => ({
        column_id,
        position: idx,
      }));
    } else if ('columns' in body && Array.isArray((body as { columns?: unknown }).columns)) {
      const raw = (body as { columns: Array<{ column_id: string; position: number }> }).columns;
      for (const item of raw) {
        if (!item || typeof item.column_id !== 'string' || typeof item.position !== 'number') {
          throw new BadRequestError('Each entry requires column_id and position');
        }
      }
      pairs = raw;
    } else {
      throw new BadRequestError('column_ids or columns required');
    }

    if (pairs.length === 0) {
      return new Response(JSON.stringify({ success: true, updated: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate: every id belongs to this sheet
    const ids = pairs.map((p) => p.column_id);
    const placeholders = ids.map(() => '?').join(', ');
    const rowsCheck = await context.env.DB.prepare(
      `SELECT id FROM records_columns WHERE sheet_id = ? AND id IN (${placeholders})`,
    )
      .bind(sheetId, ...ids)
      .all<{ id: string }>();

    const found = new Set(rowsCheck.results.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) {
        throw new BadRequestError(`Column ${id} does not belong to sheet ${sheetId}`);
      }
    }

    // Issue updates. We issue them serially; bound is small (column count).
    let updated = 0;
    for (const pair of pairs) {
      const result = await context.env.DB.prepare(
        "UPDATE records_columns SET display_order = ?, updated_at = datetime('now') WHERE id = ? AND sheet_id = ?",
      )
        .bind(pair.position, pair.column_id, sheetId)
        .run();
      if (result.success) updated += 1;
    }

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_column.reordered',
      'records_sheet',
      sheetId,
      JSON.stringify({ count: pairs.length }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true, updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Reorder columns error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
