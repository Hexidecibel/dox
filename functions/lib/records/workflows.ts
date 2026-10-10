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

import { generateId, logAudit } from '../db';
import { takeAttempt } from '../ratelimit';
import { logRecordsActivity, parseRowData, computeDisplayTitle, rebuildRowRefs, refTypeForColumn } from './helpers';
import {
  sendEmail,
  buildApprovalRequestEmail,
  buildUpdateRequestEmail,
  buildWorkflowStepFailedEmail,
} from '../email';
import {
  generateUpdateRequestToken,
  computeExpiresAt,
  normalizeFieldsRequested,
  requestFillFields,
} from './updateRequests';
import { BadRequestError } from '../permissions';
import {
  loadPublicRowTitle,
  publicCellValue,
  publicRowTitle,
  publicSenderName,
  recordsPublicAvailable,
} from './publicView';
import type {
  ApprovalStepConfig,
  RecordColumnRow,
  RecordRowData,
  RecordWorkflow,
  RecordWorkflowStep,
  RecordWorkflowStepRun,
  SetCellStepConfig,
  UpdateRequestStepConfig,
  WorkflowStepRunStatus,
  WorkflowStepType,
  PublicApprovalView,
} from '../../../shared/types';
import { loadPublicBrand } from '../tenant-brand';

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
      // What the sign-off page shows of the row (C-122). Each key must be a
      // live column of this sheet that is not a file; a step that names
      // nothing shows the row's title only.
      if (cfg.visible_fields != null) {
        if (!Array.isArray(cfg.visible_fields)) {
          throw new BadRequestError(`steps[${i}].config.visible_fields must be a list of column keys`);
        }
        for (const key of cfg.visible_fields) {
          const col = typeof key === 'string' ? columns.find((c) => c.key === key && c.archived === 0) : undefined;
          // A file is never shown; a computed column has no stored value, so
          // it would always be a dash on the page (C-139).
          if (!col || col.type === 'attachment' || col.type === 'formula' || col.type === 'rollup') {
            throw new BadRequestError(`steps[${i}].config.visible_fields: "${String(key)}" is not a column that can be shown`);
          }
        }
        (s.config as ApprovalStepConfig).visible_fields = approvalVisibleFields(cfg);
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

/**
 * A sheet's live columns. The public sign-off page passes the tenant it
 * resolved, and the read then carries it as a predicate.
 */
async function loadColumns(db: D1Database, sheetId: string, tenantId?: string): Promise<RecordColumnRow[]> {
  const r = tenantId
    ? await db
        .prepare(
          `SELECT id, sheet_id, tenant_id, key, label, type, config, required, is_title,
                  display_order, width, archived, created_at, updated_at
             FROM records_columns
            WHERE sheet_id = ? AND tenant_id = ? AND archived = 0
            ORDER BY display_order ASC`,
        )
        .bind(sheetId, tenantId)
        .all<RecordColumnRow>()
    : await db
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
): Promise<{ runId: string; failed: string | null }> {
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

  // `failed` is the reason the FIRST step could not be started, in which case
  // the run already ended `cancelled` (C-135). The caller is a signed-in
  // builder and is told so (C-147), rather than "started".
  const failed = await startStep(env, { workflow, runId, stepIndex: 0, rowId });
  return { runId, failed };
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
        // The title that leaves is the public projection of the title cell,
        // never the grid's stored display_title (C-133).
        const rowTitle = await loadPublicRowTitle(env.DB, workflow.tenant_id, rowId);
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
          rowTitle,
          publicUrl: `${env.appOrigin}/a/${token}`,
          // The organisation's brand (0140), from the workflow's own tenant.
          brand: await loadPublicBrand(env.DB, workflow.tenant_id, 'records_approval', { origin: env.appOrigin }),
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
    // A step saved before document, record and contact columns stopped being
    // requestable (C-124) may still name one. Those keys are dropped here
    // rather than failing a run that is already under way; what is left is
    // validated as before.
    const requestable = requestFillFields(columns, Array.isArray(cfg.fields_requested) ? cfg.fields_requested : []);
    if (requestable.length === 0) {
      // Nothing left to ask for. The step cannot be sent; `startStep` stops
      // the run and tells the owner this sentence (C-135). It is never shown
      // to anybody outside.
      throw new BadRequestError(
        'None of the fields this step asks for can be requested from somebody outside the organization ' +
          '(a document, another record, a contact, a file or a computed column cannot be, and an archived column is gone). ' +
          'Pick other fields for the step.',
      );
    }
    const fields = normalizeFieldsRequested(requestable.map((f) => f.column.key), columns);
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
        const rowTitle = await loadPublicRowTitle(env.DB, workflow.tenant_id, rowId);
        const sender = await env.DB
          .prepare('SELECT name, email FROM users WHERE id = ?')
          .bind(workflow.created_by_user_id)
          .first<{ name: string | null; email: string | null }>();
        const tmpl = buildUpdateRequestEmail({
          recipientName: null,
          senderName: sender?.name || sender?.email || 'A teammate',
          senderEmail: sender?.email || '',
          sheetName: sheet?.name || '',
          rowTitle,
          message: cfg.message ?? null,
          dueDate: null,
          fieldCount: fields.length,
          publicUrl: `${env.appOrigin}/u/${urToken}`,
          // The organisation's brand (0140), from the workflow's own tenant.
          brand: await loadPublicBrand(env.DB, workflow.tenant_id, 'records_update_request', { origin: env.appOrigin }),
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
 *
 * THE MOVE IS A COMPARE-AND-SWAP ON THE RUN (C-146). The run's pointer is
 * moved -- or the run finished -- by one UPDATE that requires the run to be
 * STILL `in_progress` and STILL pointing at the step being left. So:
 *
 *   - a cancel that lands between a decision being recorded and this call
 *     makes the UPDATE change nothing, and nothing is started: no step, and
 *     no mail carrying a link to a run that is already cancelled;
 *   - two callers trying to move the same run from the same step (a decision
 *     and a resume, or two resumes) cannot both do it.
 *
 * Returns whether THIS call moved the run.
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
): Promise<boolean> {
  const { workflow, runId, fromStepIndex, outcome, rowId } = params;
  const fromStepId = workflow.steps[fromStepIndex]?.id ?? null;
  const next = resolveNextStep(workflow.steps, fromStepIndex, outcome);
  const nextIdx = next === 'complete' || next === 'rejected' ? -1 : indexOfStep(workflow.steps, next);

  if (nextIdx < 0) {
    // 'complete', 'rejected', or a pointer to a step that no longer exists
    // (treated as completed for safety).
    const status = next === 'rejected' ? 'rejected' : 'completed';
    if (!(await moveRun(env.DB, runId, fromStepIndex >= 0 ? fromStepId : null, { finish: status }))) return false;
    if (next === 'complete' || next === 'rejected') {
      await logRecordsActivity(env.DB, {
        tenantId: workflow.tenant_id,
        sheetId: workflow.sheet_id,
        rowId,
        actorId: null,
        kind: next === 'rejected' ? 'workflow_rejected' : 'workflow_completed',
        details: { workflow_id: workflow.id, run_id: runId },
      });
    }
    return true;
  }

  if (!(await moveRun(env.DB, runId, fromStepId, { to: next }))) return false;
  await startStep(env, { workflow, runId, stepIndex: nextIdx, rowId });
  return true;
}

/**
 * The one statement that moves a run on or finishes it: only while it is in
 * progress and still on the step being left. (A run written before the
 * pointer was kept has no `current_step_id`; that is accepted as "on it".)
 */
async function moveRun(
  db: D1Database,
  runId: string,
  fromStepId: string | null,
  move: { to: string } | { finish: 'completed' | 'rejected' },
): Promise<boolean> {
  const res =
    'to' in move
      ? await db
          .prepare(
            `UPDATE records_workflow_runs SET current_step_id = ?
              WHERE id = ? AND status = 'in_progress' AND (current_step_id = ? OR current_step_id IS NULL)`,
          )
          .bind(move.to, runId, fromStepId)
          .run()
      : await db
          .prepare(
            `UPDATE records_workflow_runs
                SET status = ?, completed_at = datetime('now'), current_step_id = ?
              WHERE id = ? AND status = 'in_progress' AND (current_step_id = ? OR current_step_id IS NULL)`,
          )
          .bind(move.finish, move.finish === 'rejected' ? 'rejected' : 'complete', runId, fromStepId)
          .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Update requests a run sent that are still open, closed with it (C-148).
 * The link already answers 404 once the run is not in progress (C-137); this
 * makes the signed-in list say so instead of going on showing "Pending".
 */
export async function cancelRunUpdateRequests(db: D1Database, runId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE records_update_requests
          SET status = 'cancelled'
        WHERE status = 'pending'
          AND id IN (SELECT update_request_id FROM records_workflow_step_runs
                      WHERE run_id = ? AND update_request_id IS NOT NULL)`,
    )
    .bind(runId)
    .run();
}

/** How long a run may sit with nothing waiting before it is reported as stalled. */
export const STALLED_AFTER_MINUTES = 2;

/** What a stalled run is, as the signed-in run view reports it. */
export interface RunStall {
  /** One plain sentence: what state the run is in. */
  reason: string;
  /** May "Resume" be offered? False means only "Cancel" is. */
  resumable: boolean;
  /** Internal: what a resume would do. Not serialised. */
  plan: { kind: 'start'; stepIndex: number } | { kind: 'move'; fromStepIndex: number; outcome: 'approve' | 'reject' } | null;
  /** Internal: the exact state the judgement was made on, for the resume's claim. */
  stateKey: string;
}

function parseDbTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * Is this run STALLED -- in progress, with no step waiting on anybody, and
 * nothing having happened for `STALLED_AFTER_MINUTES` -- and if so, can it be
 * resumed without guessing? (C-151, which supersedes C-146's heal-on-read.)
 *
 * READS ONLY. The first version repaired such a run from inside the run-list
 * GET: a read that started steps and sent mail, on a row id the route had not
 * checked, treating a skipped step as an approval, and starting a step twice
 * for two readers. Now the read REPORTS, and a person presses Resume or
 * Cancel.
 *
 * A run stalls when the worker dies between recording a decision and starting
 * the next step. RESUMABLE means the evidence says exactly one thing:
 *
 *   - the run has no step run at all and points at its first step: that step
 *     was never started -> start it;
 *   - the NEWEST step run of the whole run is on the step the run points at,
 *     and it is approved / rejected / completed: the move did not happen ->
 *     move by that step's own approve / reject target;
 *   - the newest step run is on ANOTHER step, it is approved / rejected /
 *     completed, and its target IS the step the run points at: the move
 *     happened and the step never began -> start it.
 *
 * "Newest" is insertion order (rowid), which is what tells a LOOP's current
 * visit from an earlier one without a migration: a step visited before has an
 * older step run, but the newest row of the run is always the visit the run
 * is actually on or has just left. Anything else is NOT resumable and says
 * why: a newest step run that is `skipped` (a cancel or a failure that died
 * half way -- A SKIPPED STEP IS NEVER AN APPROVAL), a pointer at a step the
 * workflow no longer has, a newest decision that does not lead to where the
 * run points.
 */
export async function readRunStall(
  db: D1Database,
  run: { id: string; status: string; current_step_id: string | null; started_at: string | null; created_at: string | null },
  steps: RecordWorkflowStep[],
): Promise<RunStall | null> {
  if (run.status !== 'in_progress') return null;
  const res = await db
    .prepare(
      `SELECT id, step_id, status, COALESCE(completed_at, started_at) AS at
         FROM records_workflow_step_runs WHERE run_id = ? ORDER BY rowid DESC`,
    )
    .bind(run.id)
    .all<{ id: string; step_id: string; status: string; at: string | null }>();
  const stepRuns = res.results ?? [];
  if (stepRuns.some((s) => s.status === 'pending' || s.status === 'awaiting_response')) return null;

  // The last thing that happened: the newest step-run time when there is
  // one, otherwise when the run started (else when its row was made).
  const stepTimes = stepRuns.map((s) => parseDbTime(s.at)).filter((t) => Number.isFinite(t));
  const began = Number.isFinite(parseDbTime(run.started_at)) ? parseDbTime(run.started_at) : parseDbTime(run.created_at);
  const lastActivity = stepTimes.length ? Math.max(...stepTimes) : began;
  // No readable time at all is not evidence of anything recent.
  if (Number.isFinite(lastActivity) && Date.now() - lastActivity < STALLED_AFTER_MINUTES * 60_000) return null;

  const newest = stepRuns[0] ?? null;
  const pointer = run.current_step_id;
  const pointerIdx = pointer ? indexOfStep(steps, pointer) : -1;
  const stateKey = `${run.id}:${pointer ?? 'none'}:${newest?.id ?? 'none'}`;
  const nameOf = (idx: number) => `"${steps[idx]?.name ?? 'a step'}"`;
  const decided = (status: string) => status === 'approved' || status === 'rejected' || status === 'completed';
  const cannot = (reason: string): RunStall => ({
    reason: `${reason} It cannot be resumed safely; cancel it and start the workflow again.`,
    resumable: false,
    plan: null,
    stateKey,
  });

  if (pointerIdx < 0) return cannot('This run is on a step the workflow no longer has.');

  if (!newest) {
    if (pointerIdx !== 0) return cannot(`This run points at ${nameOf(pointerIdx)} with no record of any step before it.`);
    return { reason: `The first step, ${nameOf(0)}, was never started.`, resumable: true, plan: { kind: 'start', stepIndex: 0 }, stateKey };
  }

  const newestIdx = indexOfStep(steps, newest.step_id);
  if (newest.step_id === pointer) {
    if (newest.status === 'skipped') {
      return cannot(`${nameOf(pointerIdx)} was skipped, not decided, and the run was left in progress. A skipped step is never treated as an approval.`);
    }
    if (!decided(newest.status)) return cannot(`${nameOf(pointerIdx)} is in a state this run cannot continue from.`);
    const outcome = newest.status === 'rejected' ? 'reject' : 'approve';
    const verb = newest.status === 'approved' ? 'approved' : newest.status === 'rejected' ? 'rejected' : 'finished';
    return {
      reason: `${nameOf(pointerIdx)} was ${verb}, and the workflow did not move on.`,
      resumable: true,
      plan: { kind: 'move', fromStepIndex: pointerIdx, outcome },
      stateKey,
    };
  }

  // The run points somewhere other than its newest step run.
  if (newestIdx < 0 || !decided(newest.status)) {
    return cannot(`This run points at ${nameOf(pointerIdx)}, but the last step recorded before it was not decided.`);
  }
  const leadsTo = targetStepIndex(steps, newestIdx, newest.status === 'rejected' ? 'reject' : 'approve');
  if (leadsTo !== pointerIdx) {
    return cannot(`This run points at ${nameOf(pointerIdx)}, which is not where its last decision leads.`);
  }
  return {
    reason: `The workflow moved on to ${nameOf(pointerIdx)}, and that step was never started.`,
    resumable: true,
    plan: { kind: 'start', stepIndex: pointerIdx },
    stateKey,
  };
}

/** The two fields a run carries for the signed-in view; absent when it is not stalled. */
export function stallForView(stall: RunStall | null): { stalled: true; stalled_reason: string; resumable: boolean } | Record<string, never> {
  return stall ? { stalled: true, stalled_reason: stall.reason, resumable: stall.resumable } : {};
}

export type ResumeOutcome =
  | { ok: true; action: 'started' | 'moved' }
  | { ok: false; code: 'not_stalled' | 'not_resumable' | 'already_resuming' | 'step_failed'; reason: string };

/**
 * RESUME a stalled run, because a signed-in person asked (C-151).
 *
 * One claim, then one action. The claim is an atomic counter keyed on the
 * EXACT state the judgement was made on (run, the step it points at, its
 * newest step run): of any number of resumes pressed together, one gets the
 * count 1 and acts; the rest are told one is already under way. Once the
 * step starts the state is a different one, so the key can never be claimed
 * for it again. The run is then checked once more, in one statement, to be
 * still in progress and still on that step -- a cancel that landed in between
 * wins -- and the step is started, or the run moved by `advanceWorkflow`'s
 * own compare-and-swap.
 */
export async function resumeStalledRun(env: EngineEnv, runId: string): Promise<ResumeOutcome> {
  const run = await env.DB
    .prepare('SELECT id, workflow_id, row_id, status, current_step_id, started_at, created_at FROM records_workflow_runs WHERE id = ?')
    .bind(runId)
    .first<{ id: string; workflow_id: string; row_id: string; status: string; current_step_id: string | null; started_at: string | null; created_at: string | null }>();
  const wfRow = run
    ? await env.DB.prepare('SELECT * FROM records_workflows WHERE id = ?').bind(run.workflow_id).first<WorkflowDbRow>()
    : null;
  if (!run || !wfRow) return { ok: false, code: 'not_stalled', reason: 'This run is not stalled.' };
  const workflow = hydrateWorkflow(wfRow);

  const stall = await readRunStall(env.DB, run, workflow.steps);
  if (!stall) return { ok: false, code: 'not_stalled', reason: 'This run is not stalled: it has finished, is waiting on somebody, or is being processed right now.' };
  if (!stall.resumable || !stall.plan) return { ok: false, code: 'not_resumable', reason: stall.reason };

  // The claim. `takeAttempt` increments and returns in one statement.
  const claims = await takeAttempt(env.DB, `workflow_resume:${stall.stateKey}`, RESUME_CLAIM_SECONDS);
  if (claims > 1) {
    return { ok: false, code: 'already_resuming', reason: 'Somebody is already resuming this run. Look again in a moment.' };
  }

  if (stall.plan.kind === 'move') {
    const moved = await advanceWorkflow(env, {
      workflow,
      runId,
      fromStepIndex: stall.plan.fromStepIndex,
      outcome: stall.plan.outcome,
      rowId: run.row_id,
    });
    if (!moved) return { ok: false, code: 'not_stalled', reason: 'This run changed while it was being resumed. Look again.' };
    // The move may have led to a step that could not be started, in which
    // case the run was stopped with a reason (C-135). Say that, not "moved".
    const after = await env.DB
      .prepare(
        `SELECT r.status,
                (SELECT s.response_comment FROM records_workflow_step_runs s
                  WHERE s.run_id = r.id AND s.status = 'skipped' ORDER BY s.rowid DESC LIMIT 1) AS note
           FROM records_workflow_runs r WHERE r.id = ?`,
      )
      .bind(runId)
      .first<{ status: string; note: string | null }>();
    if (after?.status === 'cancelled') {
      return { ok: false, code: 'step_failed', reason: (after.note ?? '').replace(/^Could not be started: /, '') || 'The next step could not be started.' };
    }
    return { ok: true, action: 'moved' };
  }

  // Start the step the run already points at -- only if, at this instant, it
  // still is in progress and still points there.
  const still = await env.DB
    .prepare(
      `UPDATE records_workflow_runs SET current_step_id = current_step_id
        WHERE id = ? AND status = 'in_progress' AND current_step_id = ?`,
    )
    .bind(runId, run.current_step_id)
    .run();
  if ((still.meta?.changes ?? 0) < 1) {
    return { ok: false, code: 'not_stalled', reason: 'This run changed while it was being resumed. Look again.' };
  }
  const failed = await startStep(env, { workflow, runId, stepIndex: stall.plan.stepIndex, rowId: run.row_id });
  if (failed) return { ok: false, code: 'step_failed', reason: failed };
  return { ok: true, action: 'started' };
}

/** How long one resume's claim on a stalled state holds. */
const RESUME_CLAIM_SECONDS = 10 * 60;

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
// A step that cannot be started
// ---------------------------------------------------------------------

/**
 * Start a step, and if it cannot be started, SAY SO and stop the run (C-135).
 *
 * Every path that begins a step goes through here -- the first step of a new
 * run, and the next step after a decision or an answered request. Nothing a
 * step throws while starting escapes to the caller, because the caller is
 * often the PUBLIC decision route, by which point the approver's decision is
 * already recorded: an exception there used to leave the step approved, the
 * run "in progress" with no step waiting on anybody, no record of why, and a
 * builder's validation sentence in the outsider's browser.
 */
async function startStep(
  env: EngineEnv,
  params: { workflow: RecordWorkflow; runId: string; stepIndex: number; rowId: string },
): Promise<string | null> {
  try {
    await executeStep(env, params);
    return null;
  } catch (err) {
    await failRun(env, { ...params, error: err });
    return failureReason(err);
  }
}

/**
 * The index of the step an outcome leads to from `fromIndex`, following the
 * step's own approve / reject pointer; -1 when it leads to the end of the run
 * (or to a step that no longer exists).
 */
export function targetStepIndex(
  steps: RecordWorkflowStep[],
  fromIndex: number,
  outcome: 'approve' | 'reject',
): number {
  const next = resolveNextStep(steps, fromIndex, outcome);
  return next === 'complete' || next === 'rejected' ? -1 : indexOfStep(steps, next);
}

/** What the owner is told. A validation sentence is theirs to read; anything else is not quoted. */
function failureReason(err: unknown): string {
  if (err instanceof BadRequestError && err.message) return err.message;
  return 'The step could not be started because of an unexpected error.';
}

/**
 * End a run whose step could not be started, visibly:
 *
 *   - the step's run row ends `skipped` with the reason in `response_comment`
 *     (the run view prints it) and `{ failed: true, reason }` in
 *     `response_value`. There is no `failed` status: the two status columns
 *     are CHECKed enums from migration 0045 and this change adds no migration;
 *   - the run ends `cancelled`, once (the UPDATE is conditional), so nothing
 *     later in the workflow proceeds on a step that never happened and no
 *     link of the run stays open;
 *   - the row's activity feed and the audit log say which step and why;
 *   - the workflow's owner is mailed, when mail is configured.
 *
 * Each of those is tried on its own. The owner corrects the step and starts
 * the workflow again on the record.
 */
async function failRun(
  env: EngineEnv,
  params: { workflow: RecordWorkflow; runId: string; stepIndex: number; rowId: string; error: unknown },
): Promise<void> {
  const { workflow, runId, stepIndex, rowId } = params;
  const step = workflow.steps[stepIndex];
  const reason = failureReason(params.error);
  console.error(`Workflow run ${runId}: step ${step?.id ?? stepIndex} could not be started:`, params.error);

  const note = `Could not be started: ${reason}`.slice(0, 1000);
  const marker = JSON.stringify({ failed: true, reason });
  try {
    if (step) {
      const open = await env.DB
        .prepare(
          `UPDATE records_workflow_step_runs
              SET status = 'skipped', response_comment = ?, response_value = ?, completed_at = datetime('now')
            WHERE run_id = ? AND step_id = ? AND status IN ('pending', 'awaiting_response')`,
        )
        .bind(note, marker, runId, step.id)
        .run();
      if ((open.meta?.changes ?? 0) < 1) {
        await env.DB
          .prepare(
            `INSERT INTO records_workflow_step_runs
               (id, run_id, step_id, step_index, step_type, status, response_comment, response_value, started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?, datetime('now'), datetime('now'))`,
          )
          .bind(generateId(), runId, step.id, stepIndex, step.type, note, marker)
          .run();
      }
    }
  } catch (err) {
    console.error('Recording the failed step failed:', err);
  }

  let ended = false;
  try {
    const res = await env.DB
      .prepare(
        `UPDATE records_workflow_runs
            SET status = 'cancelled', completed_at = datetime('now'), current_step_id = 'complete'
          WHERE id = ? AND status IN ('pending', 'in_progress')`,
      )
      .bind(runId)
      .run();
    ended = (res.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.error('Ending the run after a failed step failed:', err);
  }
  // Already ended by somebody else: it has been said once.
  if (!ended) return;

  // A request an earlier step of this run sent must not stay answerable,
  // and must not go on reading "Pending" in the signed-in list (C-148).
  try {
    await cancelRunUpdateRequests(env.DB, runId);
    await env.DB
      .prepare(
        `UPDATE records_workflow_step_runs
            SET status = 'skipped', completed_at = datetime('now')
          WHERE run_id = ? AND status = 'awaiting_response'`,
      )
      .bind(runId)
      .run();
  } catch (err) {
    console.error('Closing open steps of a failed run failed:', err);
  }

  await logRecordsActivity(env.DB, {
    tenantId: workflow.tenant_id,
    sheetId: workflow.sheet_id,
    rowId,
    actorId: null,
    kind: 'workflow_step_failed',
    details: {
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      run_id: runId,
      step_id: step?.id ?? null,
      step_name: step?.name ?? null,
      reason,
    },
  });

  try {
    await logAudit(
      env.DB,
      null,
      workflow.tenant_id,
      'records_workflow_run.step_failed',
      'records_workflow_run',
      runId,
      JSON.stringify({ workflow_id: workflow.id, step_id: step?.id ?? null, step_name: step?.name ?? null, reason, run_status: 'cancelled' }),
      null,
    );
  } catch (err) {
    console.error('Auditing the failed step failed:', err);
  }

  if (!env.RESEND_API_KEY) return;
  try {
    const owner = await env.DB
      .prepare('SELECT email FROM users WHERE id = ? AND tenant_id = ? AND active = 1')
      .bind(workflow.created_by_user_id, workflow.tenant_id)
      .first<{ email: string | null }>();
    if (!owner?.email) return;
    const tmpl = buildWorkflowStepFailedEmail({
      workflowName: workflow.name,
      stepName: step?.name ?? 'the next part of the workflow',
      reason,
      sheetUrl: `${env.appOrigin}/records/${workflow.sheet_id}`,
    });
    await sendEmail(env.RESEND_API_KEY, { to: owner.email, subject: tmpl.subject, html: tmpl.html });
  } catch (err) {
    console.error('Mailing the workflow owner about a failed step failed:', err);
  }
}

// ---------------------------------------------------------------------
// Response handlers (called by approval public endpoint + UR submit)
// ---------------------------------------------------------------------

/**
 * Apply an approve/reject decision to a step_run.
 *
 * ONE DECISION WINS (C-138). The step is claimed by a conditional UPDATE and
 * the count it changed is what is believed: of two decisions arriving
 * together, exactly one changes the row. The other gets `recorded: false`
 * and nothing else happens for it -- no activity entry, no second advance of
 * the run. (The UPDATE was already conditional; its result was not read, so
 * both callers went on to advance.)
 *
 * NOTHING THROWN WHILE ADVANCING ESCAPES (C-135): once `recorded` is true the
 * decision stands and the run is either moved on or stopped with a reason.
 */
export async function handleApprovalResponse(
  env: EngineEnv,
  params: {
    stepRunId: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    responder: { kind: 'user'; id: string } | { kind: 'email'; email: string };
  },
): Promise<{ recorded: boolean; advanced: boolean }> {
  const { stepRunId, decision, comment, responder } = params;
  const sr = await env.DB
    .prepare(`SELECT * FROM records_workflow_step_runs WHERE id = ?`)
    .bind(stepRunId)
    .first<WorkflowStepRunDbRow>();
  if (!sr) return { recorded: false, advanced: false };
  if (sr.status !== 'awaiting_response') return { recorded: false, advanced: false };

  const nextStatus: WorkflowStepRunStatus = decision === 'approve' ? 'approved' : 'rejected';
  const responderKey =
    responder.kind === 'user' ? responder.id : responder.email;

  const claim = await env.DB
    .prepare(
      `UPDATE records_workflow_step_runs
         SET status = ?, response_comment = ?, responded_at = datetime('now'),
             responded_by_email_or_user_id = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'awaiting_response'`,
    )
    .bind(nextStatus, comment, responderKey, stepRunId)
    .run();
  // Somebody else decided this step between the read above and this write.
  if ((claim.meta?.changes ?? 0) < 1) return { recorded: false, advanced: false };

  // Reload the run + workflow snapshot so we can advance.
  const run = await env.DB
    .prepare(`SELECT * FROM records_workflow_runs WHERE id = ?`)
    .bind(sr.run_id)
    .first<{ id: string; tenant_id: string; workflow_id: string; sheet_id: string; row_id: string; status: string }>();
  if (!run) return { recorded: true, advanced: false };

  const wfRow = await env.DB
    .prepare(`SELECT * FROM records_workflows WHERE id = ?`)
    .bind(run.workflow_id)
    .first<WorkflowDbRow>();
  if (!wfRow) return { recorded: true, advanced: false };
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

  try {
    await advanceWorkflow(env, {
      workflow,
      runId: sr.run_id,
      fromStepIndex: sr.step_index,
      outcome: decision,
      rowId: run.row_id,
    });
  } catch (err) {
    // Starting the next step cannot throw (`startStep`); this is the engine
    // itself failing to move the run. The decision stands; the run is stopped
    // with a reason rather than left in progress with nobody to wait for. The
    // step named is the one the decision actually leads to (its approve or
    // reject target), not "the one after" -- a branching workflow is not a
    // list (C-149).
    await failRun(env, {
      workflow,
      runId: sr.run_id,
      stepIndex: targetStepIndex(workflow.steps, sr.step_index, decision),
      rowId: run.row_id,
      error: err,
    });
    return { recorded: true, advanced: false };
  }
  return { recorded: true, advanced: true };
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
  const claim = await env.DB
    .prepare(
      `UPDATE records_workflow_step_runs
         SET status = 'completed', responded_at = datetime('now'), completed_at = datetime('now')
       WHERE id = ? AND status = 'awaiting_response'`,
    )
    .bind(sr.id)
    .run();
  // Two answers arriving together: one of them moves the run on (C-138).
  if ((claim.meta?.changes ?? 0) < 1) return;

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

  try {
    await advanceWorkflow(env, {
      workflow,
      runId: sr.run_id,
      fromStepIndex: sr.step_index,
      outcome: 'approve',
      rowId: run.row_id,
    });
  } catch (err) {
    await failRun(env, {
      workflow,
      runId: sr.run_id,
      stepIndex: targetStepIndex(workflow.steps, sr.step_index, 'approve'),
      rowId: run.row_id,
      error: err,
    });
  }
}

// ---------------------------------------------------------------------
// Public-approval projection -- shipped to /a/:token form.
// ---------------------------------------------------------------------

const APPROVAL_VISIBLE_FIELDS_MAX = 30;

/**
 * The column keys an approval step shows on its sign-off page (C-122): the
 * step's `visible_fields`, as strings, without repeats, capped. Absent or
 * malformed is the empty list -- the approver then sees the row's title and
 * nothing else, which is what every step made before this field existed says.
 */
export function approvalVisibleFields(config: ApprovalStepConfig | null | undefined): string[] {
  const raw = config?.visible_fields;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !key || out.includes(key)) continue;
    out.push(key);
    if (out.length >= APPROVAL_VISIBLE_FIELDS_MAX) break;
  }
  return out;
}

/** Everything a sign-off link resolves to, when it resolves at all. */
export interface PublicApprovalContext {
  stepRun: WorkflowStepRunDbRow;
  /** The run's tenant, which the workflow, sheet and row were all checked against. */
  tenantId: string;
  sheetId: string;
  rowId: string;
  workflowName: string;
  step: RecordWorkflowStep;
  sheetName: string;
  rowData: RecordRowData;
  /** The workflow creator's NAME (a user of this tenant), or null. Never an email. */
  senderName: string | null;
}

/**
 * The ONE gate of the public sign-off link, for the page (GET) and for the
 * decision (POST) alike (C-128). Null -- which both answer with the same 404
 * -- unless ALL hold:
 *
 *   - the token names an approval step that is still awaiting a response and
 *     has not expired;
 *   - its run is in progress;
 *   - the workflow is active and not archived;
 *   - the sheet and the row are not archived;
 *   - the workflow, the sheet and the row all belong to THE RUN'S TENANT, and
 *     the row is on the run's sheet (C-127): a run that names another
 *     tenant's row resolves to nothing;
 *   - the organisation is active and has Records switched on (C-129).
 *
 * The decision used to check only the first of these, so a link went on
 * accepting an approval for a row that had been archived.
 */
export async function loadPublicApprovalContext(
  db: D1Database,
  token: string,
): Promise<PublicApprovalContext | null> {
  if (!token) return null;
  const found = await db
    .prepare(
      `SELECT sr.id, sr.run_id, sr.step_id, sr.step_index, sr.step_type, sr.status,
              sr.assignee_email, sr.assignee_user_id, sr.approver_token, sr.token_expires_at,
              sr.response_value, sr.response_comment, sr.responded_at,
              sr.responded_by_email_or_user_id, sr.update_request_id, sr.started_at, sr.completed_at,
              run.tenant_id AS run_tenant_id, run.sheet_id AS run_sheet_id, run.row_id AS run_row_id,
              wf.name AS workflow_name, wf.steps AS workflow_steps,
              s.name AS sheet_name,
              rr.data AS row_data,
              u.name AS sender_name
         FROM records_workflow_step_runs sr
         JOIN records_workflow_runs run
           ON run.id = sr.run_id AND run.status = 'in_progress'
         JOIN records_workflows wf
           ON wf.id = run.workflow_id AND wf.tenant_id = run.tenant_id AND wf.sheet_id = run.sheet_id
          AND wf.archived = 0 AND wf.status = 'active'
         JOIN records_sheets s
           ON s.id = run.sheet_id AND s.tenant_id = run.tenant_id AND s.archived = 0
         JOIN records_rows rr
           ON rr.id = run.row_id AND rr.sheet_id = run.sheet_id AND rr.tenant_id = run.tenant_id
          AND rr.archived = 0
         LEFT JOIN users u
           ON u.id = wf.created_by_user_id AND u.tenant_id = run.tenant_id
        WHERE sr.approver_token = ? AND sr.step_type = 'approval'`,
    )
    .bind(token)
    .first<
      WorkflowStepRunDbRow & {
        run_tenant_id: string;
        run_sheet_id: string;
        run_row_id: string;
        workflow_name: string;
        workflow_steps: string | null;
        sheet_name: string;
        row_data: string | null;
        sender_name: string | null;
      }
    >();
  if (!found) return null;
  if (!isApprovalAcceptable(found)) return null;

  const step = parseWorkflowSteps(found.workflow_steps).find((s) => s.id === found.step_id);
  if (!step || step.type !== 'approval') return null;

  if (!(await recordsPublicAvailable(db, found.run_tenant_id))) return null;

  return {
    stepRun: {
      id: found.id,
      run_id: found.run_id,
      step_id: found.step_id,
      step_index: found.step_index,
      step_type: found.step_type,
      status: found.status,
      assignee_email: found.assignee_email,
      assignee_user_id: found.assignee_user_id,
      approver_token: found.approver_token,
      token_expires_at: found.token_expires_at,
      response_value: found.response_value,
      response_comment: found.response_comment,
      responded_at: found.responded_at,
      responded_by_email_or_user_id: found.responded_by_email_or_user_id,
      update_request_id: found.update_request_id,
      started_at: found.started_at,
      completed_at: found.completed_at,
    },
    tenantId: found.run_tenant_id,
    sheetId: found.run_sheet_id,
    rowId: found.run_row_id,
    workflowName: found.workflow_name,
    step,
    sheetName: found.sheet_name,
    rowData: parseRowData(found.row_data),
    senderName: found.sender_name,
  };
}

/**
 * Build the view sent to the approver at /a/:token, field by field (C-122).
 *
 * The approver is shown the row's TITLE and ONLY the columns the step's
 * config names (`visible_fields`); with none named, no cell of the row is
 * read into the response at all. It used to send the first thirty columns
 * raw -- ids, contacts, everything.
 *
 * Each value goes through `publicCellValue`: a reference is the name of the
 * tenant's own record and never an id; a contact, an email or a phone number
 * leaves only because its column was named. A file column is never shown.
 */
export async function buildPublicApprovalView(
  db: D1Database,
  ctx: PublicApprovalContext,
): Promise<PublicApprovalView> {
  const cfg = ctx.step.config as ApprovalStepConfig;
  const columns = await loadColumns(db, ctx.sheetId, ctx.tenantId);
  const colsByKey = new Map(columns.map((c) => [c.key, c]));

  const fields: PublicApprovalView['row']['fields'] = [];
  for (const key of approvalVisibleFields(cfg)) {
    const col = colsByKey.get(key);
    // A step saved before computed columns were refused may still name one.
    if (!col || col.type === 'attachment' || col.type === 'formula' || col.type === 'rollup') continue;
    fields.push({
      label: col.label,
      type: col.type,
      value: await publicCellValue(db, ctx.tenantId, col, ctx.rowData[key]),
    });
  }

  return {
    step: {
      name: ctx.step.name,
      message: typeof cfg.message === 'string' ? cfg.message : null,
      workflow_name: ctx.workflowName,
      // A name, or the organisation's. Never an address.
      sender_name: await publicSenderName(db, ctx.tenantId, ctx.senderName),
      expires_at: ctx.stepRun.token_expires_at,
    },
    row: {
      sheet_name: ctx.sheetName,
      // The title cell through the public projection -- never the stored
      // display_title, which for a reference title is the cell's JSON (C-133).
      title: await publicRowTitle(db, ctx.tenantId, columns, ctx.rowData),
      fields,
    },
  };
}

/**
 * True if a step_run is still awaiting a decision and its token has not
 * expired. This is the STEP's own state only: the public link asks
 * `loadPublicApprovalContext`, which also requires a live run, workflow,
 * sheet, row and organisation.
 */
export function isApprovalAcceptable(stepRun: Pick<WorkflowStepRunDbRow, 'status' | 'token_expires_at'>): boolean {
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
