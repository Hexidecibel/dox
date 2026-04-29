/**
 * WorkflowRunVisualization — the demo artifact.
 *
 * Renders a single workflow run as a horizontal flow chart: pill per step,
 * connector arrows, status colors, animated pulse on the active step.
 * Click a pill to open a popover with step_run details (who/when/comment).
 *
 * Visual rules:
 *   - color encodes status: pending muted, awaiting yellow pulsing,
 *     approved green, rejected red, completed grey, skipped faded
 *   - the connector line picks up the next step's color so the path
 *     reads from left to right
 *   - the active (awaiting_response) step pulses subtly via CSS keyframes
 */

import { useState } from 'react';
import {
  Box,
  Chip,
  Popover,
  Stack,
  Tooltip,
  Typography,
  alpha,
  keyframes,
  useTheme,
  type Theme,
} from '@mui/material';
import {
  CheckCircle as ApprovedIcon,
  Cancel as RejectedIcon,
  Schedule as PendingIcon,
  HourglassTop as AwaitingIcon,
  Send as UpdateIcon,
  Edit as SetCellIcon,
  PersonOutline as PersonIcon,
  CheckOutlined as CheckIcon,
} from '@mui/icons-material';
import type {
  RecordWorkflowRun,
  RecordWorkflowStep,
  RecordWorkflowStepRun,
  WorkflowStepRunStatus,
  WorkflowStepType,
} from '../../../shared/types';

const pulse = keyframes`
  0%   { box-shadow: 0 0 0 0 rgba(255,193,7,0.6); }
  70%  { box-shadow: 0 0 0 10px rgba(255,193,7,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,193,7,0); }
`;

interface Props {
  run: RecordWorkflowRun;
  /** Compact mode shrinks margins; used when stacked under the drawer header. */
  compact?: boolean;
}

export function WorkflowRunVisualization({ run, compact = false }: Props) {
  const steps = run.workflow_steps ?? [];
  const stepRuns = run.step_runs ?? [];
  const stepRunByStepId = new Map<string, RecordWorkflowStepRun>();
  for (const sr of stepRuns) {
    // Latest by step_id (workflows could in theory loop in future).
    stepRunByStepId.set(sr.step_id, sr);
  }

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [activeStep, setActiveStep] = useState<{
    step: RecordWorkflowStep;
    stepRun: RecordWorkflowStepRun | null;
  } | null>(null);

  if (steps.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
        Workflow has no steps.
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0.75 : 1.5,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
          {run.workflow_name?.toUpperCase() ?? 'WORKFLOW'}
        </Typography>
        <RunStatusChip status={run.status} />
        {run.triggered_by_name && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            started by {run.triggered_by_name}
          </Typography>
        )}
      </Stack>

      {/* Flow chart */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          flexWrap: 'wrap',
          rowGap: 1.5,
        }}
      >
        {steps.map((step, idx) => {
          const stepRun = stepRunByStepId.get(step.id) ?? null;
          const status: WorkflowStepRunStatus = stepRun?.status ?? 'pending';
          const isActive = status === 'awaiting_response';
          const isLast = idx === steps.length - 1;
          return (
            <Box key={step.id} sx={{ display: 'flex', alignItems: 'center' }}>
              <StepNode
                step={step}
                status={status}
                pulsing={isActive}
                stepRun={stepRun}
                onClick={(el) => {
                  setAnchorEl(el);
                  setActiveStep({ step, stepRun });
                }}
              />
              {!isLast && <Connector status={status} />}
            </Box>
          );
        })}
      </Box>

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => {
          setAnchorEl(null);
          setActiveStep(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        {activeStep && (
          <StepDetailCard step={activeStep.step} stepRun={activeStep.stepRun} />
        )}
      </Popover>
    </Box>
  );
}

// ---------------------------------------------------------------------

function StepNode({
  step,
  status,
  pulsing,
  stepRun,
  onClick,
}: {
  step: RecordWorkflowStep;
  status: WorkflowStepRunStatus;
  pulsing: boolean;
  stepRun: RecordWorkflowStepRun | null;
  onClick: (el: HTMLElement) => void;
}) {
  const theme = useTheme();
  const palette = statusPalette(status, theme);
  const Icon = stepIcon(step.type, status);

  const tooltipText = (() => {
    const parts: string[] = [];
    parts.push(step.name);
    parts.push(`Status: ${humanStatus(status)}`);
    if (stepRun?.assignee_email) parts.push(`Assignee: ${stepRun.assignee_email}`);
    if (stepRun?.assignee_user_name) parts.push(`Assignee: ${stepRun.assignee_user_name}`);
    return parts.join(' • ');
  })();

  return (
    <Tooltip title={tooltipText}>
      <Box
        onClick={(e) => onClick(e.currentTarget as HTMLElement)}
        role="button"
        tabIndex={0}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          py: 0.75,
          borderRadius: 999,
          border: 1,
          borderColor: palette.border,
          bgcolor: palette.bg,
          color: palette.text,
          cursor: 'pointer',
          minWidth: 140,
          maxWidth: 220,
          minHeight: 36,
          transition: 'transform 120ms',
          '&:hover': { transform: 'translateY(-1px)' },
          ...(pulsing && {
            animation: `${pulse} 1.6s infinite`,
          }),
        }}
      >
        <Icon sx={{ fontSize: 18, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              fontWeight: 600,
              lineHeight: 1.1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {step.name}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              fontSize: 10,
              opacity: 0.85,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {humanStatus(status)}
          </Typography>
        </Box>
      </Box>
    </Tooltip>
  );
}

function Connector({ status }: { status: WorkflowStepRunStatus }) {
  const theme = useTheme();
  const palette = statusPalette(status, theme);
  return (
    <Box
      aria-hidden
      sx={{
        height: 2,
        width: 24,
        bgcolor: palette.border,
        position: 'relative',
        '&::after': {
          content: '""',
          position: 'absolute',
          right: -1,
          top: -3,
          width: 0,
          height: 0,
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          borderLeft: `6px solid ${palette.border}`,
        },
      }}
    />
  );
}

function StepDetailCard({
  step,
  stepRun,
}: {
  step: RecordWorkflowStep;
  stepRun: RecordWorkflowStepRun | null;
}) {
  return (
    <Box sx={{ p: 2, minWidth: 280, maxWidth: 360 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {step.name}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
        {humanStepType(step.type)} step
      </Typography>
      {stepRun ? (
        <Stack spacing={0.5}>
          <DetailRow label="Status" value={humanStatus(stepRun.status)} />
          {stepRun.assignee_user_name && <DetailRow label="Assignee" value={stepRun.assignee_user_name} />}
          {stepRun.assignee_email && <DetailRow label="Email" value={stepRun.assignee_email} />}
          {stepRun.started_at && <DetailRow label="Started" value={stepRun.started_at} />}
          {stepRun.completed_at && <DetailRow label="Completed" value={stepRun.completed_at} />}
          {stepRun.responded_by_email_or_user_id && (
            <DetailRow label="Responded by" value={stepRun.responded_by_email_or_user_id} />
          )}
          {stepRun.response_comment && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Comment
              </Typography>
              <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
                "{stepRun.response_comment}"
              </Typography>
            </Box>
          )}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          Not yet started.
        </Typography>
      )}
    </Box>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 90 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function RunStatusChip({ status }: { status: RecordWorkflowRun['status'] }) {
  const theme = useTheme();
  const labelMap: Record<RecordWorkflowRun['status'], { label: string; color: string }> = {
    pending: { label: 'Pending', color: theme.palette.text.secondary },
    in_progress: { label: 'In progress', color: theme.palette.warning.main },
    completed: { label: 'Completed', color: theme.palette.success.main },
    rejected: { label: 'Rejected', color: theme.palette.error.main },
    cancelled: { label: 'Cancelled', color: theme.palette.text.disabled },
  };
  const m = labelMap[status];
  return (
    <Chip
      size="small"
      label={m.label}
      sx={{
        bgcolor: alpha(m.color, 0.12),
        color: m.color,
        fontWeight: 600,
        height: 20,
        fontSize: 11,
      }}
    />
  );
}

// ---------------------------------------------------------------------
// helpers

function statusPalette(status: WorkflowStepRunStatus, theme: Theme) {
  switch (status) {
    case 'approved':
    case 'completed':
      return {
        bg: alpha(theme.palette.success.main, 0.12),
        border: theme.palette.success.main,
        text: theme.palette.success.dark,
      };
    case 'rejected':
      return {
        bg: alpha(theme.palette.error.main, 0.12),
        border: theme.palette.error.main,
        text: theme.palette.error.dark,
      };
    case 'awaiting_response':
      return {
        bg: alpha(theme.palette.warning.main, 0.16),
        border: theme.palette.warning.main,
        text: theme.palette.warning.dark,
      };
    case 'skipped':
      return {
        bg: alpha(theme.palette.text.disabled, 0.08),
        border: theme.palette.divider,
        text: theme.palette.text.disabled,
      };
    default:
      return {
        bg: theme.palette.background.default,
        border: theme.palette.divider,
        text: theme.palette.text.secondary,
      };
  }
}

function stepIcon(type: WorkflowStepType, status: WorkflowStepRunStatus) {
  if (status === 'approved' || status === 'completed') return ApprovedIcon;
  if (status === 'rejected') return RejectedIcon;
  if (status === 'awaiting_response') {
    if (type === 'update_request') return UpdateIcon;
    return AwaitingIcon;
  }
  if (status === 'skipped') return CheckIcon;
  switch (type) {
    case 'approval':
      return PersonIcon;
    case 'update_request':
      return UpdateIcon;
    case 'set_cell':
      return SetCellIcon;
    default:
      return PendingIcon;
  }
}

function humanStatus(s: WorkflowStepRunStatus): string {
  switch (s) {
    case 'awaiting_response':
      return 'Waiting';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'completed':
      return 'Completed';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Pending';
  }
}

function humanStepType(t: WorkflowStepType): string {
  switch (t) {
    case 'approval':
      return 'Approval';
    case 'update_request':
      return 'Update request';
    case 'set_cell':
      return 'Set cell';
  }
}
