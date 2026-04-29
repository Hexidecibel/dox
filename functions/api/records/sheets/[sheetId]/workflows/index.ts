/**
 * GET    /api/records/sheets/:sheetId/workflows
 * POST   /api/records/sheets/:sheetId/workflows
 *
 * List + create workflows for a sheet. Workflows are created in `draft`
 * status; the builder flips to `active` once the steps are valid.
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
  hydrateWorkflow,
  normalizeWorkflowSteps,
  type WorkflowDbRow,
} from '../../../../../lib/records/workflows';
import type { Env, User } from '../../../../../lib/types';
import type {
  CreateWorkflowRequest,
  RecordColumnRow,
} from '../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const url = new URL(context.request.url);
    const includeArchived = url.searchParams.get('archived') === '1';

    const where = includeArchived
      ? 'WHERE w.sheet_id = ?'
      : 'WHERE w.sheet_id = ? AND w.archived = 0';

    const result = await context.env.DB.prepare(
      `SELECT w.*, u.name as creator_name
         FROM records_workflows w
         LEFT JOIN users u ON w.created_by_user_id = u.id
         ${where}
         ORDER BY w.created_at DESC`,
    )
      .bind(sheetId)
      .all<WorkflowDbRow>();

    const workflows = (result.results ?? []).map(hydrateWorkflow);
    return new Response(
      JSON.stringify({ workflows, total: workflows.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List workflows error:', err);
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

    const body = (await context.request.json()) as CreateWorkflowRequest;

    const name = sanitizeString(body.name ?? '');
    if (!name) throw new BadRequestError('name is required');

    const description = body.description ? sanitizeString(body.description) : null;
    const triggerType = body.trigger_type ?? 'manual';
    if (triggerType !== 'manual' && triggerType !== 'on_row_create') {
      throw new BadRequestError('Invalid trigger_type');
    }
    const status = body.status ?? 'draft';
    if (!['draft', 'active', 'archived'].includes(status)) {
      throw new BadRequestError('Invalid status');
    }

    // Need columns to validate set_cell + update_request steps.
    const colsResult = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
      .bind(sheetId)
      .all<RecordColumnRow>();
    const columns = colsResult.results ?? [];
    const steps = body.steps ? normalizeWorkflowSteps(body.steps, columns) : [];

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO records_workflows
         (id, tenant_id, sheet_id, name, description, trigger_type, trigger_config,
          steps, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        sheet.tenant_id,
        sheetId,
        name,
        description,
        triggerType,
        body.trigger_config ? JSON.stringify(body.trigger_config) : null,
        JSON.stringify(steps),
        status,
        user.id,
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_workflow.created',
      'records_workflow',
      id,
      JSON.stringify({ sheet_id: sheetId, status, trigger_type: triggerType }),
      getClientIp(context.request),
    );

    const row = await context.env.DB.prepare(
      `SELECT w.*, u.name as creator_name
         FROM records_workflows w
         LEFT JOIN users u ON w.created_by_user_id = u.id
         WHERE w.id = ?`,
    )
      .bind(id)
      .first<WorkflowDbRow>();
    if (!row) throw new Error('Failed to load just-created workflow');

    return new Response(JSON.stringify({ workflow: hydrateWorkflow(row) }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create workflow error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
