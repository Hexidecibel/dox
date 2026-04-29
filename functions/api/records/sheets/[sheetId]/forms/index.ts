/**
 * GET    /api/records/sheets/:sheetId/forms — list forms for the sheet
 * POST   /api/records/sheets/:sheetId/forms — create a form
 *
 * Forms derive 1:1 from the sheet's columns; field_config is the per-form
 * projection. Auto-generates a public_slug when is_public=true so the
 * builder can immediately copy a public URL.
 */
import { generateId, logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { sanitizeString } from '../../../../../lib/validation';
import { loadSheetForUser } from '../../../../../lib/records/helpers';
import {
  generatePublicSlug,
  normalizeFieldConfig,
  normalizeSettings,
  attachSubmissionCounts,
} from '../../../../../lib/records/forms';
import type { Env, User } from '../../../../../lib/types';
import type {
  CreateFormRequest,
  RecordColumnRow,
  RecordForm,
} from '../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const url = new URL(context.request.url);
    const includeArchived = url.searchParams.get('archived') === '1';

    const where = includeArchived
      ? 'WHERE f.sheet_id = ?'
      : 'WHERE f.sheet_id = ? AND f.archived = 0';

    const result = await context.env.DB.prepare(
      `SELECT f.*, u.name as creator_name
       FROM records_forms f
       LEFT JOIN users u ON f.created_by_user_id = u.id
       ${where}
       ORDER BY f.created_at DESC`,
    )
      .bind(sheetId)
      .all<RecordForm>();

    const forms = result.results ?? [];
    await attachSubmissionCounts(context.env.DB, forms);

    return new Response(
      JSON.stringify({ forms, total: forms.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List forms error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const body = (await context.request.json()) as CreateFormRequest;

    const name = sanitizeString(body.name ?? '');
    if (!name) throw new BadRequestError('name is required');

    const description = body.description ? sanitizeString(body.description) : null;
    const isPublic = !!body.is_public;
    const status = body.status ?? 'draft';
    if (!['draft', 'live', 'archived'].includes(status)) {
      throw new BadRequestError('Invalid status');
    }

    // Load the sheet's columns so we can validate field_config against
    // real column ids and seed a sensible default if none were supplied.
    const colsResult = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
      .bind(sheetId)
      .all<RecordColumnRow>();
    const columns = colsResult.results ?? [];
    const validIds = new Set(columns.map((c) => c.id));

    let fieldConfig = normalizeFieldConfig(body.field_config ?? null, validIds);
    if (fieldConfig.length === 0) {
      // Default: every non-formula/rollup column, in display order, with
      // the column's own required flag carried over.
      fieldConfig = columns
        .filter((c) => c.type !== 'formula' && c.type !== 'rollup')
        .map((c, idx) => ({
          column_id: c.id,
          required: c.required === 1,
          label_override: null,
          help_text: null,
          position: idx,
        }));
    }

    const settings = normalizeSettings(body.settings ?? null);

    const id = generateId();
    const slug = isPublic ? generatePublicSlug() : null;

    await context.env.DB.prepare(
      `INSERT INTO records_forms
         (id, tenant_id, sheet_id, name, description, public_slug, is_public, status,
          field_config, settings, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        sheet.tenant_id,
        sheetId,
        name,
        description,
        slug,
        isPublic ? 1 : 0,
        status,
        JSON.stringify(fieldConfig),
        JSON.stringify(settings),
        user.id,
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_form.created',
      'records_form',
      id,
      JSON.stringify({ sheet_id: sheetId, is_public: isPublic, status }),
      getClientIp(context.request),
    );

    const form = await context.env.DB.prepare(
      `SELECT f.*, u.name as creator_name FROM records_forms f
       LEFT JOIN users u ON f.created_by_user_id = u.id WHERE f.id = ?`,
    )
      .bind(id)
      .first<RecordForm>();

    return new Response(JSON.stringify({ form }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create form error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
