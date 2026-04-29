-- Migration 0045: Records workflows + step approvals (Phase 3 Slice 3)
--
-- A workflow is a definition (per sheet); a run is an instance executing
-- on a specific row. The run advances step-by-step; each step's outcome
-- (approved/rejected/responded/completed) determines the next step.
--
-- v1 step types:
--   1. approval          -- in-app or email approve/reject
--   2. update_request    -- reuses records_update_requests infra
--   3. set_cell          -- writes a cell value, no human in the loop
--
-- Approvers can be users (assignee_user_id) OR emails (assignee_email +
-- approver_token). Email approvers get a magic link at /a/<token>, same
-- pattern as /u/<token> for update requests.
--
-- Conventions: TEXT primary keys via lower(hex(randomblob(8))) at the
-- API layer, denormalized tenant_id, ON DELETE CASCADE for child rows,
-- CHECKed enums on status columns so a typo can't put a row in limbo.

CREATE TABLE IF NOT EXISTS records_workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','on_row_create')) DEFAULT 'manual',
  -- JSON: filter config for auto-trigger; null => fire on every event.
  trigger_config TEXT,
  -- JSON array of step definitions; see WorkflowStep type in shared/types.ts.
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft','active','archived')) DEFAULT 'draft',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id TEXT NOT NULL,
  FOREIGN KEY (sheet_id) REFERENCES records_sheets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS records_workflow_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','rejected','cancelled')) DEFAULT 'pending',
  -- Tracks which step the run is currently parked on. NULL when not yet
  -- started; sentinel 'complete' / 'rejected' when the run has terminated.
  current_step_id TEXT,
  triggered_by_user_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES records_workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (sheet_id) REFERENCES records_sheets(id) ON DELETE CASCADE,
  FOREIGN KEY (row_id) REFERENCES records_rows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS records_workflow_step_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  -- step_id matches step.id in workflow.steps JSON. step_index is the
  -- position at the time the run was created -- used for ordering the
  -- visualization even if the workflow def changes mid-run.
  step_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','awaiting_response','approved','rejected','completed','skipped')) DEFAULT 'pending',
  assignee_email TEXT,
  assignee_user_id TEXT,
  approver_token TEXT,
  token_expires_at TEXT,
  -- JSON; for update_request, holds the response data; for approval,
  -- holds the comment / decision metadata.
  response_value TEXT,
  response_comment TEXT,
  responded_at TEXT,
  responded_by_email_or_user_id TEXT,
  -- For update_request steps: link to the records_update_request row so
  -- the run can be advanced by the existing UR submit flow.
  update_request_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES records_workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_records_workflows_tenant_sheet
  ON records_workflows(tenant_id, sheet_id) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_records_workflow_runs_row
  ON records_workflow_runs(row_id);
CREATE INDEX IF NOT EXISTS idx_records_workflow_runs_status
  ON records_workflow_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_records_workflow_step_runs_run
  ON records_workflow_step_runs(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_records_workflow_step_runs_token
  ON records_workflow_step_runs(approver_token) WHERE approver_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_workflow_step_runs_assignee
  ON records_workflow_step_runs(assignee_user_id, status) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_workflow_step_runs_update_request
  ON records_workflow_step_runs(update_request_id) WHERE update_request_id IS NOT NULL;
