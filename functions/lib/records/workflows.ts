/**
 * Records workflow engine. The functions here are the heart of Phase 3:
 *
 *   startWorkflowRun          -- create a run, kick off step 0
 *   executeStep               -- dispatch step.type to its handler
 *   advanceWorkflow           -- move from completed step to next, or terminate
 *   handleApprovalResponse    -- approve/reject -> advance
 *   handleUpdateRequestResponse  -- bridge from UR submit -> advance
 *
 * Conventions mirror updateRequests.ts:
 *   - Tenant scoping enforced at the query level by callers; this module
 *     never crosses tenants.
 *   - Best-effort email + activity writes never fail the parent mutation.
 *   - Token entropy: 32 random bytes -> base64url ~43 chars (well past 24).
 *
 * Steps are linked by step.id (not array index) so reordering a workflow
 * mid-run doesn't break the next-step pointers stored on each step_run.
 */

import { generateId } from '../db';
import { logRecordsActivity, parseRowData, computeDisplayTitle, rebuildRowRefs, refTypeForColumn } from './helpers';
import { sendEmail, buildApprovalRequestEmail, buildUpdateRequestEmail } from '../email';
import {
  generateUpdateRequestToken,
  computeExpiresAt,
  normalizeFieldsRequested,
} from './updateRequests';
import { BadRequestError } from '../permissions';
import type {
  ApprovalStepConfig,
  RecordColumnRow,
  RecordRowData,
  RecordWorkflow,
  RecordWorkflowRun,
  RecordWorkflowStep,
  RecordWorkflowStepRun,
  SetCellStepConfig,
  UpdateRequestStepConfig,
  WorkflowStepRunStatus,
  WorkflowStepType,
  PublicApprovalView,
} from '../../../shared/types';

// ---------------------------------------------------------------------
// Token + JSON helpers
// ---------------------------------------------------------------------

/** Tokens for /a/:token approval magic links. Same entropy as URs. */
export function generateApproverToken(): string {
  return generateUpdateRequestToken();
}

/** Tolerant JSON parsing for the steps column. */
export function parseWorkflowSteps(raw: string | null): RecordWorkflowStep[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RecordWorkflowStep[]) : [];
  } catch {
    return [];
  }
}

/** Tolerant JSON parsing for trigger_config + response_value. */
export function parseJsonField<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

/** Server-side normalization for an incoming workflow steps array. */
export function normalizeWorkflowSteps(
  input: unknown,
  columns: RecordColumnRow[],
): RecordWorkflowStep[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new BadRequestError('steps must be an array');
  }
  const seen = new Set<string>();
  const out: RecordWorkflowStep[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestError(`steps[${i}] must be an object`);
    }
    const s = raw as Partial<RecordWorkflowStep>;
    if (typeof s.id !== 'string' || !s.id) {
      throw new BadRequestError(`steps[${i}].id is required`);
    }
    if (seen.has(s.id)) {
      throw new BadRequestError(`steps[${i}].id is duplicated (${s.id})`);
    }
    seen.add(s.id);
    if (s.type !== 'approval' && s.type !== 'update_request' && s.type !== 'set_cell') {
      throw new BadRequestError(`steps[${i}].type must be approval | update_request | set_cell`);
    }
    if (typeof s.name !== 'string' || !s.name.trim()) {
      throw new BadRequestError(`steps[${i}].name is required`);
    }
    if (!s.config || typeof s.config !== 'object') {
      throw new BadRequestError(`steps[${i}].config is required`);
    }
    // Per-type config sanity
    if (s.type === 'set_cell') {
      const cfg = s.config as SetCellStepConfig;
      if (!cfg.column_key || typeof cfg.column_key !== 'string') {
        throw new BadRequestError(`steps[${i}].config.column_key is required for set_cell`);
      }
      const col = columns.find((c) => c.key === cfg.column_key && c.archived === 0);
      if (!col) {
        throw new BadRequestError(`steps[${i}].config.column_key "${cfg.column_key}" is not a fillable column`);
      }
      if (col.type === 'formula' || col.type === 'rollup' || col.type === 'attachment') {
        throw new BadRequestError(`steps[${i}].config.column_key cannot target a ${col.type} column`);
      }
    }
    if (s.type === 'update_request') {
      const cfg = s.config as UpdateRequestStepConfig;
      if (!cfg.recipient_email || typeof cfg.recipient_email !== 'string' || !cfg.recipient_email.includes('@')) {
        throw new BadRequestError(`steps[${i}].config.recipient_email must be a valid email`);
      }
      // Field validation reuses the same allowlist enforced for direct URs.
      normalizeFieldsRequested(cfg.fields_requested, columns);
    }
    if (s.type === 'approval') {
      const cfg = s.config as ApprovalStepConfig;
      if (!cfg.assignee_email && !cfg.assignee_user_id) {
        throw new BadRequestError(`steps[${i}].config requires assignee_email or assignee_user_id`);
      }
    }
    out.push({
      id: s.id,
      type: s.type,
      name: s.name.trim().slice(0, 200),
      config: s.config as RecordWorkflowStep['config'],
      on_approve_next: typeof s.on_approve_next === 'string' ? s.on_approve_next : null,
      on_reject_next: typeof s.on_reject_next === 'string' ? s.on_reject_next : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Hydration -> API shape
// ---------------------------------------------------------------------

export interface WorkflowDbRow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: string | null;
  steps: string;
  status: string;
  archived: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  creator_name?: string | null;
}

export function hydrateWorkflow(row: WorkflowDbRow): RecordWorkflow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    sheet_id: row.sheet_id,
    name: row.name,
    description: row.description,
    trigger_type: (row.trigger_type as RecordWorkflow['trigger_type']) || 'manual',
    trigger_config: parseJsonField(row.trigger_config),
    steps: parseWorkflowSteps(row.steps),
    status: (row.status as RecordWorkflow['status']) || 'draft',
    archived: row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by_user_id: row.created_by_user_id,
    creator_name: row.creator_name ?? null,
  };
}

export interface WorkflowStepRunDbRow {
  id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  step_type: string;
  status: string;
  assignee_email: string | null;
  assignee_user_id: string | null;
  approver_token: string | null;
  token_expires_at: string | null;
  response_value: string | null;
  response_comment: string | null;
  responded_at: string | null;
  responded_by_email_or_user_id: string | null;
  update_request_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  assignee_user_name?: string | null;
}

export function hydrateStepRun(
  row: WorkflowStepRunDbRow,
  opts?: { includeToken?: boolean },
): RecordWorkflowStepRun {
  const out: RecordWorkflowStepRun = {
    id: row.id,
    run_id: row.run_id,
    step_id: row.step_id,
    step_index: row.step_index,
    step_type: row.step_type as WorkflowStepType,
    status: row.status as WorkflowStepRunStatus,
    assignee_email: row.assignee_email,
    assignee_user_id: row.assignee_user_id,
    token_expires_at: row.token_expires_at,
    response_value: parseJsonField(row.response_value),
    response_comment: row.response_comment,
    responded_at: row.responded_at,
    responded_by_email_or_user_id: row.responded_by_email_or_user_id,
    update_request_id: row.update_request_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    assignee_user_name: row.assignee_user_name ?? null,
  };
  if (opts?.includeToken) out.approver_token = row.approver_token;
  return out;
}

// ---------------------------------------------------------------------
// Engine — the heart of this slice
// ---------------------------------------------------------------------

interface EngineEnv {
  DB: D1Database;
  RESEND_API_KEY?: string | null;
  /** Origin of the dox app — used to mint magic links. */
  appOrigin: string;
}

/** Look up a column by key (used by set_cell). */
async function loadColumns(db: D1Database, sheetId: string): Promise<RecordColumnRow[]> {
  const r = await db
    .prepare('SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC')
    .bind(sheetId)
    .all<RecordColumnRow>();
  return r.results ?? [];
}

/** Find the index of a step.id in a workflow's steps array. -1 if missing. */
function indexOfStep(steps: RecordWorkflowStep[], id: string): number {
  return steps.findIndex((s) => s.id === id);
}

/**
 * Resolve "which step.id comes after this one" for the given outcome.
 * Defaults: approve -> next-in-array (or 'complete'); reject -> 'rejected'.
 */
function resolveNextStep(
  steps: RecordWorkflowStep[],
  fromIndex: number,
  outcome: 'approve' | 'reject' | 'complete',
): string {
  const cur = steps[fromIndex];
  if (!cur) return 'complete';
  if (outcome === 'reject') {
    return cur.on_reject_next ?? 'rejected';
  }
  // approve / complete share linear default.
  if (cur.on_approve_next) return cur.on_approve_next;
  const next = steps[fromIndex + 1];
  return next ? next.id : 'complete';
}

/**
 * Create a workflow run + the first step_run, then execute step 0.
 * Returns the new run id.
 */
export async function startWorkflowRun(
  env: EngineEnv,
  params: {
    workflow: RecordWorkflow;
    rowId: string;
    triggeredByUserId: string | null;
  },
): Promise<{ runId: string }> {
  const { workflow, rowId, triggeredByUserId } = params;
  if (workflow.status !== 'active') {
    throw new BadRequestError('Workflow is not active');
  }
  if (workflow.steps.length === 0) {
    throw new BadRequestError('Workflow has no steps');
  }
  const runId = generateId();
  await env.DB.prepare(
    `INSERT INTO records_workflow_runs
       (id, tenant_id, workflow_id, sheet_id, row_id, status, current_step_id,
        triggered_by_user_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, datetime('now'))`,
  )
    .bind(
      runId,
      workflow.tenant_id,
      workflow.id,
      workflow.sheet_id,
      rowId,
      workflow.steps[0].id,
      triggeredByUserId,
    )
    .run();

  await logRecordsActivity(env.DB, {
    tenantId: workflow.tenant_id,
    sheetId: workflow.sheet_id,
    rowId,
    actorId: triggeredByUserId,
    kind: 'workflow_started',
    details: {
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      run_id: runId,
    },
  });

  await executeStep(env, { workflow, runId, stepIndex: 0, rowId });
  return { runId };
}

/**
 * Execute the step at the given index. Side effects:
 *  - creates a records_workflow_step_runs row in the right state
 *  - for approval: mints a token + emails the approver
 *  - for update_request: creates a records_update_requests row + emails
 *  - for set_cell: PATCHes the row, marks step completed, advances
 */
export async function executeStep(
  env: EngineEnv,
  params: {
    workflow: RecordWorkflow;
    runId: string;
    stepIndex: number;
    rowId: string;
  },
): Promise<void> {
  const { workflow, runId, stepIndex, rowId } = params;
  const step = workflow.steps[stepIndex];
  if (!step) {
    // Out-of-bounds means we ran off the end -- treat as completion.
    await markRunComplete(env.DB, runId, 'completed');
    return;
  }

  const stepRunId = generateId();

  if (step.type === 'set_cell') {
    const cfg = step.config as SetCellStepConfig;
    await env.DB.prepare(
      `INSERT INTO records_workflow_step_runs
         (id, run_id, step_id, step_index, step_type, status, started_at)
       VALUES (?, ?, ?, ?, 'set_cell', 'pending', datetime('now'))`,
    )
      .bind(stepRunId, runId, step.id, stepIndex)
      .run();

    // Apply the cell write.
    const columns = await loadColumns(env.DB, workflow.sheet_id);
    const col = columns.find((c) => c.key === cfg.column_key && c.archived === 0);
    if (!col) {
      // Column was archived after workflow creation -- skip and advance.
      await env.DB.prepare(
        `UPDATE records_workflow_step_runs SET status = 'skipped', completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(stepRunId)
        .run();
    } else {
      const row = await env.DB
        .prepare('SELECT id, sheet_id, tenant_id, data FROM records_rows WHERE id = ?')
        .bind(rowId)
        .first<{ id: string; sheet_id: string; tenant_id: string; data: string | null }>();
      if (row) {
        const data = parseRowData(row.data);
        data[cfg.column_key] = cfg.value;
        const titleTouched = col.is_title === 1;
        const nextTitle = titleTouched ? computeDisplayTitle(columns, data) : undefined;
        if (nextTitle !== undefined) {
          await env.DB
            .prepare(`UPDATE records_rows SET data = ?, display_title = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(JSON.stringify(data), nextTitle, row.id)
            .run();
        } else {
          await env.DB
            .prepare(`UPDATE records_rows SET data = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(JSON.stringify(data), row.id)
            .run();
        }
        if (refTypeForColumn(col.type)) {
          await rebuildRowRefs(env.DB, row.tenant_id, row.sheet_id, row.id, columns, data);
        }
        await logRecordsActivity(env.DB, {
          tenantId: workflow.tenant_id,
          sheetId: workflow.sheet_id,
          rowId,
          actorId: null,
          kind: 'cell_updated',
          details: {
            column_key: cfg.column_key,
            from: null,
            to: cfg.value,
            via: 'workflow',
            workflow_id: workflow.id,
            run_id: runId,
            step_id: step.id,
          },
        });
      }
      await env.DB.prepare(
        `UPDATE records_workflow_step_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(stepRunId)
        .run();
    }

    // Set-cell terminates immediately; advance.
    await advanceWorkflow(env, { workflow, runId, fromStepIndex: stepIndex, outcome: 'approve', rowId });
    return;
  }

  if (step.type === 'approval') {
    const cfg = step.config as ApprovalStepConfig;
    const token = generateApproverToken();
    const expiresAt = cfg.due_days
      ? computeExpiresAt(addDaysIso(cfg.due_days))
      : null;

    await env.DB.prepare(
      `INSERT INTO records_workflow_step_runs
         (id, run_id, step_id, step_index, step_type, status,
          assignee_email, assignee_user_id, approver_token, token_expires_at, started_at)
       VALUES (?, ?, ?, ?, 'approval', 'awaiting_response', ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        stepRunId,
        runId,
        step.id,
        stepIndex,
        cfg.assignee_email ?? null,
        cfg.assignee_user_id ?? null,
        token,
        expiresAt,
      )
      .run();

    await logRecordsActivity(env.DB, {
      tenantId: workflow.tenant_id,
      sheetId: workflow.sheet_id,
      rowId,
      actorId: null,
      kind: 'workflow_step_assigned',
      details: {
        workflow_id: workflow.id,
        run_id: runId,
        step_id: step.id,
        step_name: step.name,
        step_type: 'approval',
        assignee_email: cfg.assignee_email ?? null,
        assignee_user_id: cfg.assignee_user_id ?? null,
      },
    });

    // Send email if external approver.
    if (cfg.assignee_email && env.RESEND_API_KEY) {
      try {
        const sheet = await env.DB
          .prepare('SELECT name FROM records_sheets WHERE id = ?')
          .bind(workflow.sheet_id)
          .first<{ name: string }>();
        const row = await env.DB
          .prepare('SELECT display_title FROM records_rows WHERE id = ?')
          .bind(rowId)
          .first<{ display_title: string | null }>();
        const sender = await env.DB
          .prepare('SELECT name, email FROM users WHERE id = ?')
          .bind(workflow.created_by_user_id)
          .first<{ name: string | null; email: string | null }>();
        const tmpl = buildApprovalRequestEmail({
          recipientName: null,
          senderName: sender?.name || sender?.email || 'A teammate',
          senderEmail: sender?.email || '',
          workflowName: workflow.name,
          stepName: step.name,
          message: cfg.message ?? null,
          sheetName: sheet?.name || '',
          rowTitle: row?.display_title ?? null,
          publicUrl: `${env.appOrigin}/a/${token}`,
        });
        await sendEmail(env.RESEND_API_KEY, {
          to: cfg.assignee_email,
          subject: tmpl.subject,
          html: tmpl.html,
        });
      } catch (err) {
        console.error('Approval email send failed:', err);
      }
    }
    return;
  }

  if (step.type === 'update_request') {
    const cfg = step.config as UpdateRequestStepConfig;
    const columns = await loadColumns(env.DB, workflow.sheet_id);
    const fields = normalizeFieldsRequested(cfg.fields_requested, columns);
    const urId = generateId();
    const urToken = generateApproverToken();
    const expiresAt = computeExpiresAt(cfg.due_days ? addDaysIso(cfg.due_days) : null);

    await env.DB.prepare(
      `INSERT INTO records_update_requests
         (id, tenant_id, sheet_id, row_id, token, recipient_email, recipient_user_id,
          fields_requested, message, due_date, status, expires_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'pending', ?, ?)`,
    )
      .bind(
        urId,
        workflow.tenant_id,
        workflow.sheet_id,
        rowId,
        urToken,
        cfg.recipient_email.trim().toLowerCase(),
        JSON.stringify(fields),
        cfg.message ?? null,
        expiresAt,
        workflow.created_by_user_id,
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO records_workflow_step_runs
         (id, run_id, step_id, step_index, step_type, status,
          assignee_email, update_request_id, token_expires_at, started_at)
       VALUES (?, ?, ?, ?, 'update_request', 'awaiting_response', ?, ?, ?, datetime('now'))`,
    )
      .bind(
        stepRunId,
        runId,
        step.id,
        stepIndex,
        cfg.recipient_email,
        urId,
        expiresAt,
      )
      .run();

    await logRecordsActivity(env.DB, {
      tenantId: workflow.tenant_id,
      sheetId: workflow.sheet_id,
      rowId,
      actorId: null,
      kind: 'workflow_step_assigned',
      details: {
        workflow_id: workflow.id,
        run_id: runId,
        step_id: step.id,
        step_name: step.name,
        step_type: 'update_request',
        recipient_email: cfg.recipient_email,
        update_request_id: urId,
      },
    });

    // Send the update-request email so the recipient gets the link.
    if (env.RESEND_API_KEY) {
      try {
        const sheet = await env.DB
          .prepare('SELECT name FROM records_sheets WHERE id = ?')
          .bind(workflow.sheet_id)
          .first<{ name: string }>();
        const row = await env.DB
          .prepare('SELECT display_title FROM records_rows WHERE id = ?')
          .bind(rowId)
          .first<{ display_title: string | null }>();
        const sender = await env.DB
          .prepare('SELECT name, email FROM users WHERE id = ?')
          .bind(workflow.created_by_user_id)
          .first<{ name: string | null; email: string | null }>();
        const tmpl = buildUpdateRequestEmail({
          recipientName: null,
          senderName: sender?.name || sender?.email || 'A teammate',
          senderEmail: sender?.email || '',
          sheetName: sheet?.name || '',
          rowTitle: row?.display_title ?? null,
          message: cfg.message ?? null,
          dueDate: null,
          fieldCount: fields.length,
          publicUrl: `${env.appOrigin}/u/${urToken}`,
        });
        await sendEmail(env.RESEND_API_KEY, {
          to: cfg.recipient_email,
          subject: tmpl.subject,
          html: tmpl.html,
        });
      } catch (err) {
        console.error('Workflow update-request email send failed:', err);
      }
    }
    return;
  }

  // Unknown type -> mark skipped + advance.
  await env.DB.prepare(
    `INSERT INTO records_workflow_step_runs
       (id, run_id, step_id, step_index, step_type, status, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'skipped', datetime('now'), datetime('now'))`,
  )
    .bind(stepRunId, runId, step.id, stepIndex, step.type)
    .run();
  await advanceWorkflow(env, { workflow, runId, fromStepIndex: stepIndex, outcome: 'approve', rowId });
}

/**
 * Move the run from a just-completed step to the next one (or terminate).
 * `outcome` decides which next-pointer to follow.
 */
export async function advanceWorkflow(
  env: EngineEnv,
  params: {
    workflow: RecordWorkflow;
    runId: string;
    fromStepIndex: number;
    outcome: 'approve' | 'reject';
    rowId: string;
  },
): Promise<void> {
  const { workflow, runId, fromStepIndex, outcome, rowId } = params;
  const next = resolveNextStep(workflow.steps, fromStepIndex, outcome);

  if (next === 'complete') {
    await markRunComplete(env.DB, runId, 'completed');
    await logRecordsActivity(env.DB, {
      tenantId: workflow.tenant_id,
      sheetId: workflow.sheet_id,
      rowId,
      actorId: null,
      kind: 'workflow_completed',
      details: { workflow_id: workflow.id, run_id: runId },
    });
    return;
  }
  if (next === 'rejected') {
    await markRunComplete(env.DB, runId, 'rejected');
    await logRecordsActivity(env.DB, {
      tenantId: workflow.tenant_id,
      sheetId: workflow.sheet_id,
      rowId,
      actorId: null,
      kind: 'workflow_rejected',
      details: { workflow_id: workflow.id, run_id: runId },
    });
    return;
  }
  const nextIdx = indexOfStep(workflow.steps, next);
  if (nextIdx < 0) {
    // Pointer to a non-existent step -- treat as completed for safety.
    await markRunComplete(env.DB, runId, 'completed');
    return;
  }
  await env.DB
    .prepare(`UPDATE records_workflow_runs SET current_step_id = ? WHERE id = ?`)
    .bind(next, runId)
    .run();
  await executeStep(env, { workflow, runId, stepIndex: nextIdx, rowId });
}

/** Mark the run terminal (completed/rejected/cancelled). */
export async function markRunComplete(
  db: D1Database,
  runId: string,
  status: 'completed' | 'rejected' | 'cancelled',
): Promise<void> {
  const sentinel = status === 'rejected' ? 'rejected' : 'complete';
  await db
    .prepare(
      `UPDATE records_workflow_runs
         SET status = ?, completed_at = datetime('now'), current_step_id = ?
       WHERE id = ?`,
    )
    .bind(status, sentinel, runId)
    .run();
}

// ---------------------------------------------------------------------
// Response handlers (called by approval public endpoint + UR submit)
// ---------------------------------------------------------------------

/**
 * Apply an approve/reject decision to a step_run. Idempotent: a second
 * call after the run has already moved on is a no-op.
 */
export async function handleApprovalResponse(
  env: EngineEnv,
  params: {
    stepRunId: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    responder: { kind: 'user'; id: string } | { kind: 'email'; email: string };
  },
): Promise<{ advanced: boolean }> {
  const { stepRunId, decision, comment, responder } = params;
  const sr = await env.DB
    .prepare(`SELECT * FROM records_workflow_step_runs WHERE id = ?`)
    .bind(stepRunId)
    .first<WorkflowStepRunDbRow>();
  if (!sr) return { advanced: false };
  if (sr.status !== 'awaiting_response') return { advanced: false };

  const nextStatus: WorkflowStepRunStatus = decision === 'approve' ? 'approved' : 'rejected';
  const responderKey =
    responder.kind === 'user' ? responder.id : responder.email;

  await env.DB
    .prepare(
      `UPDATE records_workflow_step_runs
         SET status = ?, response_comment = ?, responded_at = datetime('now'),
             responded_by_email_or_user_id = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'awaiting_response'`,
    )
    .bind(nextStatus, comment, responderKey, stepRunId)
    .run();

  // Reload the run + workflow snapshot so we can advance.
  const run = await env.DB
    .prepare(`SELECT * FROM records_workflow_runs WHERE id = ?`)
    .bind(sr.run_id)
    .first<{ id: string; tenant_id: string; workflow_id: string; sheet_id: string; row_id: string; status: string }>();
  if (!run) return { advanced: false };

  const wfRow = await env.DB
    .prepare(`SELECT * FROM records_workflows WHERE id = ?`)
    .bind(run.workflow_id)
    .first<WorkflowDbRow>();
  if (!wfRow) return { advanced: false };
  const workflow = hydrateWorkflow(wfRow);

  await logRecordsActivity(env.DB, {
    tenantId: workflow.tenant_id,
    sheetId: workflow.sheet_id,
    rowId: run.row_id,
    actorId: responder.kind === 'user' ? responder.id : null,
    kind: decision === 'approve' ? 'workflow_approved' : 'workflow_rejected',
    details: {
      workflow_id: workflow.id,
      run_id: sr.run_id,
      step_id: sr.step_id,
      responder: responderKey,
      comment,
    },
  });

  await advanceWorkflow(env, {
    workflow,
    runId: sr.run_id,
    fromStepIndex: sr.step_index,
    outcome: decision,
    rowId: run.row_id,
  });
  return { advanced: true };
}

/**
 * Bridge from the existing UR submit flow: when an update_request linked
 * to a workflow is responded to, advance the run.
 */
export async function handleUpdateRequestResponse(
  env: EngineEnv,
  updateRequestId: string,
): Promise<void> {
  const sr = await env.DB
    .prepare(`SELECT * FROM records_workflow_step_runs WHERE update_request_id = ? AND status = 'awaiting_response'`)
    .bind(updateRequestId)
    .first<WorkflowStepRunDbRow>();
  if (!sr) return;
  await env.DB
    .prepare(
      `UPDATE records_workflow_step_runs
         SET status = 'completed', responded_at = datetime('now'), completed_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(sr.id)
    .run();

  const run = await env.DB
    .prepare(`SELECT * FROM records_workflow_runs WHERE id = ?`)
    .bind(sr.run_id)
    .first<{ id: string; tenant_id: string; workflow_id: string; sheet_id: string; row_id: string }>();
  if (!run) return;
  const wfRow = await env.DB
    .prepare(`SELECT * FROM records_workflows WHERE id = ?`)
    .bind(run.workflow_id)
    .first<WorkflowDbRow>();
  if (!wfRow) return;
  const workflow = hydrateWorkflow(wfRow);

  await advanceWorkflow(env, {
    workflow,
    runId: sr.run_id,
    fromStepIndex: sr.step_index,
    outcome: 'approve',
    rowId: run.row_id,
  });
}

// ---------------------------------------------------------------------
// Public-approval projection -- shipped to /a/:token form.
// ---------------------------------------------------------------------

/** Build the sanitized view sent to the approver at /a/:token. */
export async function buildPublicApprovalView(
  db: D1Database,
  stepRun: WorkflowStepRunDbRow,
  data: RecordRowData,
): Promise<PublicApprovalView | null> {
  const run = await db
    .prepare('SELECT * FROM records_workflow_runs WHERE id = ?')
    .bind(stepRun.run_id)
    .first<{ id: string; workflow_id: string; sheet_id: string; row_id: string }>();
  if (!run) return null;
  const wf = await db
    .prepare('SELECT * FROM records_workflows WHERE id = ?')
    .bind(run.workflow_id)
    .first<WorkflowDbRow>();
  if (!wf) return null;
  const workflow = hydrateWorkflow(wf);
  const step = workflow.steps.find((s) => s.id === stepRun.step_id);
  if (!step) return null;

  const sheet = await db
    .prepare('SELECT name FROM records_sheets WHERE id = ? AND archived = 0')
    .bind(run.sheet_id)
    .first<{ name: string }>();
  if (!sheet) return null;

  const row = await db
    .prepare('SELECT display_title FROM records_rows WHERE id = ? AND archived = 0')
    .bind(run.row_id)
    .first<{ display_title: string | null }>();
  if (!row) return null;

  const sender = await db
    .prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(workflow.created_by_user_id)
    .first<{ name: string | null; email: string | null }>();

  const columns = await loadColumns(db, run.sheet_id);
  // Show all non-archived columns -- gives the approver context. Skip
  // attachments since their value shape is opaque.
  const fields = columns
    .filter((c) => c.type !== 'attachment')
    .slice(0, 30)
    .map((c) => ({
      key: c.key,
      label: c.label,
      type: c.type,
      value: data[c.key] ?? null,
    }));

  const cfg = step.config as ApprovalStepConfig;
  return {
    step: {
      name: step.name,
      message: cfg.message ?? null,
      workflow_name: workflow.name,
      sender_name: sender?.name || sender?.email || 'A teammate',
      sender_email: sender?.email || '',
      expires_at: stepRun.token_expires_at,
    },
    row: {
      sheet_name: sheet.name,
      title: row.display_title,
      fields,
    },
  };
}

/** True if a step_run's token is still valid for submitting a decision. */
export function isApprovalAcceptable(stepRun: WorkflowStepRunDbRow): boolean {
  if (stepRun.status !== 'awaiting_response') return false;
  if (stepRun.token_expires_at) {
    const exp = Date.parse(stepRun.token_expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
