/**
 * GET /api/records/sheets/:sheetId/forms/:formId/submissions
 *
 * Paginated submission list for a form. Joins records_rows so the admin
 * UI can render the row's display_title alongside metadata without a
 * second round trip per submission.
 */
import {
  NotFoundError,
  errorToResponse,
} from '../../../../../../lib/permissions';
import { loadSheetForUser } from '../../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../../lib/types';
import type { RecordFormSubmission } from '../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const formId = context.params.formId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const form = await context.env.DB.prepare(
      'SELECT id FROM records_forms WHERE id = ? AND sheet_id = ?',
    )
      .bind(formId, sheetId)
      .first<{ id: string }>();
    if (!form) throw new NotFoundError('Form not found');

    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const countRow = await context.env.DB.prepare(
      'SELECT COUNT(*) as total FROM records_form_submissions WHERE form_id = ?',
    )
      .bind(formId)
      .first<{ total: number }>();

    const submissions = await context.env.DB.prepare(
      `SELECT s.*, r.display_title as row_display_title
       FROM records_form_submissions s
       LEFT JOIN records_rows r ON s.row_id = r.id
       WHERE s.form_id = ?
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(formId, limit, offset)
      .all<RecordFormSubmission>();

    return new Response(
      JSON.stringify({
        submissions: submissions.results ?? [],
        total: countRow?.total ?? 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List form submissions error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
