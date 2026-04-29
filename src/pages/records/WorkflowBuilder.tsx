/**
 * /records/:sheetId/workflows/:workflowId — workflow builder.
 *
 * Layout mirrors FormBuilder:
 *   - Desktop: split pane. Left ~50% configuration (name, trigger, steps).
 *     Right ~50% live preview (WorkflowRunVisualization in preview mode).
 *   - Mobile: stacked.
 *
 * Auto-save: state is debounced 600ms after the last edit, then PUT to
 * the server. Same posture as the FormBuilder so users don't have to
 * think about a Save button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  CheckCircleOutline as CheckIcon,
  KeyboardArrowDown as DownIcon,
  KeyboardArrowUp as UpIcon,
  DeleteOutline as DeleteIcon,
  ExpandMoreOutlined as ExpandIcon,
  PersonOutline as PersonIcon,
  SendOutlined as UpdateIcon,
  EditOutlined as SetCellIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { api } from '../../lib/api';
import { WorkflowRunVisualization } from '../../components/records/WorkflowRunVisualization';
import type {
  ApiRecordColumn,
  ApprovalStepConfig,
  RecordWorkflow,
  RecordWorkflowStep,
  RecordWorkflowStepRun,
  SetCellStepConfig,
  UpdateRequestStepConfig,
  WorkflowStepType,
} from '../../../shared/types';
import type { User } from '../../lib/types';

const AUTOSAVE_DEBOUNCE_MS = 600;

const NON_FILLABLE_TYPES = new Set<ApiRecordColumn['type']>([
  'formula',
  'rollup',
  'attachment',
]);

interface UserOption {
  id: string;
  email: string;
  name: string | null;
}

function genStepId(): string {
  // Stable client-side id; backend trusts as long as it's unique.
  return `step_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultConfig(type: WorkflowStepType): RecordWorkflowStep['config'] {
  switch (type) {
    case 'approval':
      return { assignee_email: null, assignee_user_id: null, message: null };
    case 'update_request':
      return { recipient_email: '', fields_requested: [], message: null };
    case 'set_cell':
      return { column_key: '', value: '' };
  }
}

function defaultStepName(type: WorkflowStepType): string {
  switch (type) {
    case 'approval':
      return 'Approval';
    case 'update_request':
      return 'Update request';
    case 'set_cell':
      return 'Set cell';
  }
}

export function WorkflowBuilder() {
  const navigate = useNavigate();
  const { sheetId, workflowId } = useParams<{ sheetId: string; workflowId: string }>();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [workflow, setWorkflow] = useState<RecordWorkflow | null>(null);
  const [columns, setColumns] = useState<ApiRecordColumn[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<'config' | 'preview'>('config');

  // Track whether we're hydrating to suppress autosave fire on initial load.
  const hydrated = useRef(false);

  // Initial load
  useEffect(() => {
    if (!sheetId || !workflowId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [wfRes, sheetRes, usersRes] = await Promise.all([
          recordsApi.workflows.get(sheetId, workflowId),
          recordsApi.sheets.get(sheetId),
          api.users.list().catch(() => [] as User[]),
        ]);
        if (cancelled) return;
        setWorkflow(wfRes.workflow);
        setColumns(sheetRes.columns);
        setUsers(
          (usersRes as User[])
            .filter((u) => u.active)
            .map((u) => ({ id: u.id, email: u.email, name: u.name })),
        );
        hydrated.current = true;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load workflow');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sheetId, workflowId]);

  // Autosave. We deliberately do NOT replace `workflow` state with the
  // server response — local state is already the source of truth for
  // anything the user is editing, and a setWorkflow on every save would
  // cascade re-renders into the preview pane, unmounting things like the
  // step-detail Popover the user just opened in WorkflowRunVisualization.
  // Read latest workflow via a ref so the timer always sends fresh data
  // without recreating the callback (and thus the whole render tree's
  // closures) on every keystroke.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workflowRef = useRef<RecordWorkflow | null>(null);
  workflowRef.current = workflow;
  const scheduleSave = useCallback(() => {
    if (!hydrated.current || !workflowRef.current || !sheetId || !workflowId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const wf = workflowRef.current;
      if (!wf) return;
      setSaving(true);
      try {
        await recordsApi.workflows.update(sheetId, workflowId, {
          name: wf.name,
          description: wf.description,
          trigger_type: wf.trigger_type,
          steps: wf.steps,
          status: wf.status,
        });
        setSavedAt(Date.now());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save');
      } finally {
        setSaving(false);
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [sheetId, workflowId]);

  const updateWorkflow = (patch: Partial<RecordWorkflow>) => {
    setWorkflow((prev) => (prev ? { ...prev, ...patch } : prev));
    scheduleSave();
  };

  const addStep = (type: WorkflowStepType) => {
    if (!workflow) return;
    const newStep: RecordWorkflowStep = {
      id: genStepId(),
      type,
      name: defaultStepName(type),
      config: defaultConfig(type),
    };
    updateWorkflow({ steps: [...workflow.steps, newStep] });
  };

  const updateStep = (stepId: string, patch: Partial<RecordWorkflowStep>) => {
    if (!workflow) return;
    updateWorkflow({
      steps: workflow.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    });
  };

  const removeStep = (stepId: string) => {
    if (!workflow) return;
    updateWorkflow({ steps: workflow.steps.filter((s) => s.id !== stepId) });
  };

  const moveStep = (stepId: string, direction: -1 | 1) => {
    if (!workflow) return;
    const idx = workflow.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    const next = idx + direction;
    if (next < 0 || next >= workflow.steps.length) return;
    const arr = [...workflow.steps];
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    updateWorkflow({ steps: arr });
  };

  const handleArchive = async () => {
    if (!sheetId || !workflowId) return;
    await recordsApi.workflows.archive(sheetId, workflowId);
    navigate(`/records/${sheetId}?tab=workflows`);
  };

  // Build a fake "preview run" for the visualization. Memoized on the
  // narrow slice we actually depend on so that incidental re-renders of
  // WorkflowBuilder (e.g. the autosave success path) don't push a fresh
  // `run` reference into WorkflowRunVisualization and disrupt the
  // child's local Popover state when a user is inspecting a step.
  // NOTE: must be declared *before* any early return below so hook order
  // stays stable between the loading and loaded renders (Rules of Hooks).
  const previewRun = useMemo(() => {
    if (!workflow) return null;
    return {
      id: 'preview',
      tenant_id: workflow.tenant_id,
      workflow_id: workflow.id,
      sheet_id: workflow.sheet_id,
      row_id: 'preview',
      status: 'in_progress' as const,
      current_step_id: workflow.steps[0]?.id ?? null,
      triggered_by_user_id: null,
      started_at: null,
      completed_at: null,
      created_at: '',
      workflow_name: workflow.name,
      workflow_steps: workflow.steps,
      triggered_by_name: null,
      step_runs: workflow.steps.map<RecordWorkflowStepRun>((s, idx) => ({
        id: `preview-${s.id}`,
        run_id: 'preview',
        step_id: s.id,
        step_index: idx,
        step_type: s.type,
        status: idx === 0 ? 'awaiting_response' : 'pending',
        assignee_email: (s.config as ApprovalStepConfig).assignee_email ?? null,
        assignee_user_id: (s.config as ApprovalStepConfig).assignee_user_id ?? null,
        token_expires_at: null,
        response_value: null,
        response_comment: null,
        responded_at: null,
        responded_by_email_or_user_id: null,
        update_request_id: null,
        started_at: null,
        completed_at: null,
      })),
    };
  }, [
    workflow,
  ]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 320 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !workflow) {
    return <Alert severity="error" sx={{ m: 3 }}>{error}</Alert>;
  }

  if (!workflow || !previewRun) return null;

  const config = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton
          size="small"
          onClick={() => navigate(`/records/${sheetId}?tab=workflows`)}
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Workflow
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            {workflow.name || 'Untitled workflow'}
          </Typography>
        </Box>
        <SaveIndicator saving={saving} savedAt={savedAt} />
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      <TextField
        label="Name"
        value={workflow.name}
        onChange={(e) => updateWorkflow({ name: e.target.value })}
        fullWidth
      />
      <TextField
        label="Description (optional)"
        value={workflow.description ?? ''}
        onChange={(e) => updateWorkflow({ description: e.target.value || null })}
        fullWidth
        multiline
        minRows={2}
      />

      <Box>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4, mb: 0.5 }}>
          STATUS
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={workflow.status}
          onChange={(_, v) => v && updateWorkflow({ status: v })}
        >
          <ToggleButton value="draft">Draft</ToggleButton>
          <ToggleButton value="active">Active</ToggleButton>
          <ToggleButton value="archived">Archived</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box>
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4, mb: 0.5 }}>
          TRIGGER
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={workflow.trigger_type}
          onChange={(_, v) => v && updateWorkflow({ trigger_type: v })}
        >
          <ToggleButton value="manual">Manual</ToggleButton>
          <ToggleButton value="on_row_create">On row create</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Divider />

      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Steps</Typography>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<PersonIcon />} size="small" onClick={() => addStep('approval')}>
          Approval
        </Button>
        <Button startIcon={<UpdateIcon />} size="small" onClick={() => addStep('update_request')}>
          Update request
        </Button>
        <Button startIcon={<SetCellIcon />} size="small" onClick={() => addStep('set_cell')}>
          Set cell
        </Button>
      </Stack>

      {workflow.steps.length === 0 ? (
        <Paper
          variant="outlined"
          sx={{ p: 3, textAlign: 'center', borderStyle: 'dashed', borderColor: 'divider' }}
        >
          <Typography variant="body2" color="text.secondary">
            No steps yet. Add an Approval, Update request, or Set cell step.
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={1.5}>
          {workflow.steps.map((step, idx) => (
            <StepEditor
              key={step.id}
              step={step}
              stepIndex={idx}
              isFirst={idx === 0}
              isLast={idx === workflow.steps.length - 1}
              columns={columns}
              users={users}
              onChange={(patch) => updateStep(step.id, patch)}
              onMoveUp={() => moveStep(step.id, -1)}
              onMoveDown={() => moveStep(step.id, 1)}
              onRemove={() => removeStep(step.id)}
            />
          ))}
        </Stack>
      )}

      <Divider />

      <Box>
        <Button color="error" onClick={() => setArchiveOpen(true)}>
          Archive workflow
        </Button>
      </Box>

      <Dialog open={archiveOpen} onClose={() => setArchiveOpen(false)}>
        <DialogTitle>Archive workflow?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Archived workflows can't be triggered. In-progress runs continue.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setArchiveOpen(false)}>Cancel</Button>
          <Button color="error" variant="contained" disableElevation onClick={handleArchive}>
            Archive
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );

  const preview = (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4, mb: 1 }}>
        PREVIEW
      </Typography>
      <WorkflowRunVisualization run={previewRun} />
    </Box>
  );

  if (isMobile) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box sx={{ p: 1, display: 'flex', justifyContent: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mobilePane}
            onChange={(_, v) => v && setMobilePane(v)}
          >
            <ToggleButton value="config">Configure</ToggleButton>
            <ToggleButton value="preview">Preview</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {mobilePane === 'config' ? config : preview}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'row', minHeight: 0, height: '100%' }}>
      <Box sx={{ flex: '1 1 50%', overflow: 'auto', borderRight: 1, borderColor: 'divider' }}>
        {config}
      </Box>
      <Box sx={{ flex: '1 1 50%', overflow: 'auto', bgcolor: 'background.default' }}>
        {preview}
      </Box>
    </Box>
  );
}

// Stack helper used inline above (avoid extra import).
function Stack({ direction = 'column', spacing = 0, alignItems, children, sx }: {
  direction?: 'row' | 'column';
  spacing?: number;
  alignItems?: string;
  children: React.ReactNode;
  sx?: object;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: direction,
        alignItems,
        gap: spacing,
        ...(sx ?? {}),
      }}
    >
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------

function SaveIndicator({ saving, savedAt }: { saving: boolean; savedAt: number | null }) {
  if (saving) {
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <CircularProgress size={12} />
        <Typography variant="caption" color="text.secondary">Saving…</Typography>
      </Stack>
    );
  }
  if (savedAt) {
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <CheckIcon fontSize="small" color="success" />
        <Typography variant="caption" color="text.secondary">Saved</Typography>
      </Stack>
    );
  }
  return null;
}

// ---------------------------------------------------------------------

interface StepEditorProps {
  step: RecordWorkflowStep;
  stepIndex: number;
  isFirst: boolean;
  isLast: boolean;
  columns: ApiRecordColumn[];
  users: UserOption[];
  onChange: (patch: Partial<RecordWorkflowStep>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function StepEditor({
  step,
  stepIndex,
  isFirst,
  isLast,
  columns,
  users,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: StepEditorProps) {
  const [expanded, setExpanded] = useState(true);
  const Icon = stepTypeIcon(step.type);

  return (
    <Paper variant="outlined" sx={{ borderColor: 'divider' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          p: 1.5,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        <Icon sx={{ color: 'text.secondary' }} />
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
          STEP {stepIndex + 1}
        </Typography>
        <Typography sx={{ flex: 1, fontWeight: 600 }}>{step.name}</Typography>
        <Tooltip title="Move up">
          <span>
            <IconButton
              size="small"
              disabled={isFirst}
              onClick={(e) => {
                e.stopPropagation();
                onMoveUp();
              }}
            >
              <UpIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Move down">
          <span>
            <IconButton
              size="small"
              disabled={isLast}
              onClick={(e) => {
                e.stopPropagation();
                onMoveDown();
              }}
            >
              <DownIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Remove step">
          <IconButton
            size="small"
            color="error"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <ExpandIcon
          fontSize="small"
          sx={{
            transition: 'transform 200ms',
            transform: expanded ? 'rotate(180deg)' : 'none',
            color: 'text.disabled',
          }}
        />
      </Box>
      {expanded && (
        <Box sx={{ p: 2, pt: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Divider />
          <TextField
            label="Step name"
            size="small"
            value={step.name}
            onChange={(e) => onChange({ name: e.target.value })}
            fullWidth
          />
          {step.type === 'approval' && (
            <ApprovalConfigEditor
              config={step.config as ApprovalStepConfig}
              users={users}
              onChange={(patch) => onChange({ config: { ...step.config, ...patch } })}
            />
          )}
          {step.type === 'update_request' && (
            <UpdateRequestConfigEditor
              config={step.config as UpdateRequestStepConfig}
              columns={columns}
              onChange={(patch) => onChange({ config: { ...step.config, ...patch } })}
            />
          )}
          {step.type === 'set_cell' && (
            <SetCellConfigEditor
              config={step.config as SetCellStepConfig}
              columns={columns}
              onChange={(patch) => onChange({ config: { ...step.config, ...patch } })}
            />
          )}
        </Box>
      )}
    </Paper>
  );
}

function stepTypeIcon(type: WorkflowStepType) {
  switch (type) {
    case 'approval':
      return PersonIcon;
    case 'update_request':
      return UpdateIcon;
    case 'set_cell':
      return SetCellIcon;
  }
}

function ApprovalConfigEditor({
  config,
  users,
  onChange,
}: {
  config: ApprovalStepConfig;
  users: UserOption[];
  onChange: (patch: Partial<ApprovalStepConfig>) => void;
}) {
  // Resolve current user pick.
  const value = config.assignee_user_id
    ? users.find((u) => u.id === config.assignee_user_id) ?? null
    : null;
  return (
    <>
      <Autocomplete<UserOption, false, false, true>
        freeSolo
        options={users}
        value={value}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.email)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        onChange={(_, v) => {
          if (typeof v === 'string') {
            onChange({ assignee_user_id: null, assignee_email: v });
          } else if (v) {
            onChange({ assignee_user_id: v.id, assignee_email: v.email });
          } else {
            onChange({ assignee_user_id: null, assignee_email: null });
          }
        }}
        inputValue={config.assignee_email ?? ''}
        onInputChange={(_, v, reason) => {
          if (reason === 'input') {
            onChange({ assignee_email: v, assignee_user_id: null });
          }
        }}
        renderOption={(props, opt) => (
          <Box component="li" {...props} key={opt.id} sx={{ display: 'block !important', py: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{opt.name || opt.email}</Typography>
            {opt.name && (
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                {opt.email}
              </Typography>
            )}
          </Box>
        )}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Approver"
            placeholder="Pick a teammate or type any email"
            size="small"
            helperText="Internal users get an in-app inbox item; external emails get a magic link."
          />
        )}
      />
      <TextField
        label="Message (optional)"
        size="small"
        value={config.message ?? ''}
        onChange={(e) => onChange({ message: e.target.value || null })}
        multiline
        minRows={2}
      />
      <TextField
        label="Due in days (optional)"
        size="small"
        type="number"
        value={config.due_days ?? ''}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          onChange({ due_days: Number.isFinite(v) ? v : null });
        }}
        sx={{ maxWidth: 200 }}
      />
    </>
  );
}

function UpdateRequestConfigEditor({
  config,
  columns,
  onChange,
}: {
  config: UpdateRequestStepConfig;
  columns: ApiRecordColumn[];
  onChange: (patch: Partial<UpdateRequestStepConfig>) => void;
}) {
  const fillable = useMemo(
    () => columns.filter((c) => c.archived === 0 && !NON_FILLABLE_TYPES.has(c.type)),
    [columns],
  );
  const selected = config.fields_requested ?? [];
  const toggle = (key: string) => {
    onChange({
      fields_requested: selected.includes(key)
        ? selected.filter((k) => k !== key)
        : [...selected, key],
    });
  };
  return (
    <>
      <TextField
        label="Recipient email"
        size="small"
        type="email"
        value={config.recipient_email ?? ''}
        onChange={(e) => onChange({ recipient_email: e.target.value })}
        placeholder="vendor@example.com"
        required
      />
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
          Fields to fill ({selected.length} selected)
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {fillable.map((c) => {
            const checked = selected.includes(c.key);
            return (
              <Chip
                key={c.id}
                label={c.label}
                onClick={() => toggle(c.key)}
                variant={checked ? 'filled' : 'outlined'}
                color={checked ? 'primary' : 'default'}
                size="small"
              />
            );
          })}
        </Box>
      </Box>
      <TextField
        label="Message (optional)"
        size="small"
        value={config.message ?? ''}
        onChange={(e) => onChange({ message: e.target.value || null })}
        multiline
        minRows={2}
      />
      <TextField
        label="Due in days (optional)"
        size="small"
        type="number"
        value={config.due_days ?? ''}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          onChange({ due_days: Number.isFinite(v) ? v : null });
        }}
        sx={{ maxWidth: 200 }}
      />
    </>
  );
}

function SetCellConfigEditor({
  config,
  columns,
  onChange,
}: {
  config: SetCellStepConfig;
  columns: ApiRecordColumn[];
  onChange: (patch: Partial<SetCellStepConfig>) => void;
}) {
  const fillable = columns.filter((c) => c.archived === 0 && !NON_FILLABLE_TYPES.has(c.type));
  const col = fillable.find((c) => c.key === config.column_key);
  return (
    <>
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
          Column
        </Typography>
        <Select
          fullWidth
          size="small"
          value={config.column_key ?? ''}
          onChange={(e) => onChange({ column_key: e.target.value as string, value: '' })}
        >
          <MenuItem value="" disabled>
            Pick a column
          </MenuItem>
          {fillable.map((c) => (
            <MenuItem key={c.id} value={c.key}>
              {c.label} <Typography component="span" sx={{ ml: 1, color: 'text.disabled', fontSize: 12 }}>{c.type}</Typography>
            </MenuItem>
          ))}
        </Select>
      </Box>
      <TextField
        label="Value"
        size="small"
        type={col?.type === 'number' || col?.type === 'currency' || col?.type === 'percent' ? 'number' : 'text'}
        value={String(config.value ?? '')}
        onChange={(e) => {
          const raw = e.target.value;
          let v: unknown = raw;
          if (col?.type === 'number' || col?.type === 'currency' || col?.type === 'percent') {
            const n = parseFloat(raw);
            v = Number.isFinite(n) ? n : raw;
          }
          if (col?.type === 'checkbox') {
            v = raw === 'true' || raw === '1';
          }
          onChange({ value: v });
        }}
        helperText={col ? `Will overwrite the ${col.label} cell when this step runs.` : 'Pick a column first.'}
      />
    </>
  );
}
