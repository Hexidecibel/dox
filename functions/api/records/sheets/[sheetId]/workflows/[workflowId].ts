/**
 * GET    /api/records/sheets/:sheetId/workflows/:workflowId
 * PUT    /api/records/sheets/:sheetId/workflows/:workflowId
 * DELETE /api/records/sheets/:sheetId/workflows/:workflowId  (soft archive)
 */
import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
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
  RecordColumnRow,
  UpdateWorkflowRequest,
} from '../../../../../../shared/types';

async function loadWorkflow(
  db: D1Database,
  sheetId: string,
  workflowId: string,
): Promise<WorkflowDbRow | null> {
  return db
    .prepare(
      `SELECT w.*, u.name as creator_name
         FROM records_workflows w
         LEFT JOIN users u ON w.created_by_user_id = u.id
         WHERE w.id = ? AND w.sheet_id = ?`,
    )
    .bind(workflowId, sheetId)
    .first<WorkflowDbRow>();
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const workflowId = context.params.workflowId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const row = await loadWorkflow(context.env.DB, sheetId, workflowId);
    if (!row) throw new NotFoundError('Workflow not found');

    return new Response(JSON.stringify({ workflow: hydrateWorkflow(row) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get workflow error:', err);
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
    const workflowId = context.params.workflowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const existing = await loadWorkflow(context.env.DB, sheetId, workflowId);
    if (!existing) throw new NotFoundError('Workflow not found');

    const body = (await context.request.json()) as UpdateWorkflowRequest;
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
    if (body.trigger_type !== undefined) {
      if (body.trigger_type !== 'manual' && body.trigger_type !== 'on_row_create') {
        throw new BadRequestError('Invalid trigger_type');
      }
      updates.push('trigger_type = ?');
      params.push(body.trigger_type);
    }
    if (body.trigger_config !== undefined) {
      updates.push('trigger_config = ?');
      params.push(body.trigger_config ? JSON.stringify(body.trigger_config) : null);
    }
    if (body.status !== undefined) {
      if (!['draft', 'active', 'archived'].includes(body.status)) {
        throw new BadRequestError('Invalid status');
      }
      updates.push('status = ?');
      params.push(body.status);
      if (body.status === 'archived') {
        updates.push('archived = 1');
      }
    }
    if (body.steps !== undefined) {
      const colsResult = await context.env.DB.prepare(
        'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
      )
        .bind(sheetId)
        .all<RecordColumnRow>();
      const columns = colsResult.results ?? [];
      const steps = normalizeWorkflowSteps(body.steps, columns);
      updates.push('steps = ?');
      params.push(JSON.stringify(steps));
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ workflow: hydrateWorkflow(existing) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    updates.push("updated_at = datetime('now')");
    params.push(workflowId);

    await context.env.DB.prepare(
      `UPDATE records_workflows SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_workflow.updated',
      'records_workflow',
      workflowId,
      JSON.stringify({ fields: Object.keys(body) }),
      getClientIp(context.request),
    );

    const row = await loadWorkflow(context.env.DB, sheetId, workflowId);
    if (!row) throw new Error('Failed to reload workflow');
    return new Response(JSON.stringify({ workflow: hydrateWorkflow(row) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update workflow error:', err);
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
    const workflowId = context.params.workflowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const existing = await loadWorkflow(context.env.DB, sheetId, workflowId);
    if (!existing) throw new NotFoundError('Workflow not found');

    await context.env.DB.prepare(
      `UPDATE records_workflows SET archived = 1, status = 'archived', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(workflowId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_workflow.archived',
      'records_workflow',
      workflowId,
      null,
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Archive workflow error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
