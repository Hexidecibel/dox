/**
 * GET    /api/records/sheets/:sheetId/forms/:formId — fetch one form
 * PUT    /api/records/sheets/:sheetId/forms/:formId — update form
 * DELETE /api/records/sheets/:sheetId/forms/:formId — soft archive
 */
import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  NotFoundError,
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
  RecordForm,
  RecordFormRow,
  UpdateFormRequest,
} from '../../../../../../../shared/types';

async function loadForm(
  db: D1Database,
  sheetId: string,
  formId: string,
): Promise<RecordFormRow & { creator_name?: string }> {
  const form = await db
    .prepare(
      `SELECT f.*, u.name as creator_name FROM records_forms f
       LEFT JOIN users u ON f.created_by_user_id = u.id
       WHERE f.id = ? AND f.sheet_id = ?`,
    )
    .bind(formId, sheetId)
    .first<RecordFormRow & { creator_name?: string }>();
  if (!form) throw new NotFoundError('Form not found');
  return form;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const formId = context.params.formId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);
    const form = (await loadForm(context.env.DB, sheetId, formId)) as RecordForm;
    await attachSubmissionCounts(context.env.DB, [form]);

    return new Response(JSON.stringify({ form }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get form error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const formId = context.params.formId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const existing = await loadForm(context.env.DB, sheetId, formId);

    const body = (await context.request.json()) as UpdateFormRequest;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) throw new BadRequestError('name cannot be empty');
      updates.push('name = ?');
      params.push(name);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.status !== undefined) {
      if (!['draft', 'live', 'archived'].includes(body.status)) {
        throw new BadRequestError('Invalid status');
      }
      updates.push('status = ?');
      params.push(body.status);
      if (body.status === 'archived') {
        updates.push('archived = 1');
      }
    }

    // is_public toggle: when flipping ON, mint a slug if missing.
    let nextSlug: string | null | undefined = undefined;
    if (body.is_public !== undefined) {
      const next = body.is_public ? 1 : 0;
      updates.push('is_public = ?');
      params.push(next);
      if (next === 1 && !existing.public_slug) {
        nextSlug = generatePublicSlug();
      }
    }

    if (body.rotate_slug) {
      nextSlug = generatePublicSlug();
    }

    if (nextSlug !== undefined) {
      updates.push('public_slug = ?');
      params.push(nextSlug);
    }

    if (body.field_config !== undefined) {
      const colsResult = await context.env.DB.prepare(
        'SELECT id FROM records_columns WHERE sheet_id = ?',
      )
        .bind(sheetId)
        .all<{ id: string }>();
      const validIds = new Set((colsResult.results ?? []).map((r) => r.id));
      const fc = normalizeFieldConfig(body.field_config, validIds);
      updates.push('field_config = ?');
      params.push(JSON.stringify(fc));
    }

    if (body.settings !== undefined) {
      const s = normalizeSettings(body.settings);
      updates.push('settings = ?');
      params.push(JSON.stringify(s));
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(formId);

    await context.env.DB.prepare(
      `UPDATE records_forms SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_form.updated',
      'records_form',
      formId,
      JSON.stringify({ changes: Object.keys(body) }),
      getClientIp(context.request),
    );

    const updated = (await loadForm(context.env.DB, sheetId, formId)) as RecordForm;
    await attachSubmissionCounts(context.env.DB, [updated]);

    return new Response(JSON.stringify({ form: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update form error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const formId = context.params.formId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    await loadForm(context.env.DB, sheetId, formId);

    await context.env.DB.prepare(
      `UPDATE records_forms
         SET archived = 1, status = 'archived', updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(formId)
      .run();

    // Be safe — this also kills public exposure should the slug have leaked.
    // We keep public_slug intact so old links 404 cleanly (vs accidentally
    // rebinding a recycled slug to a different form).

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_form.archived',
      'records_form',
      formId,
      null,
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Archive form error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

