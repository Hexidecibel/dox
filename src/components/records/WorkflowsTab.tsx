/**
 * WorkflowsTab — list of workflows for a sheet, embedded in SheetDetail.
 *
 * Cards show name, status (Draft/Active/Archived), step count, trigger,
 * created-by. Clicking a card opens the builder. "+ New workflow" creates
 * a draft and navigates straight into the builder.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  AccountTree as WorkflowIcon,
  Add as AddIcon,
  PlayCircleOutline as ActiveIcon,
  EditOutlined as DraftIcon,
  Archive as ArchivedIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { EmptyState } from '../EmptyState';
import type { RecordWorkflow } from '../../../shared/types';

interface Props {
  sheetId: string;
  canMutate: boolean;
}

export function WorkflowsTab({ sheetId, canMutate }: Props) {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<RecordWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await recordsApi.workflows.list(sheetId);
      setWorkflows(res.workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>;
  }

  return (
    <Box sx={{ pt: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Workflows
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Multi-step approvals, update requests, and automations on this sheet.
          </Typography>
        </Box>
        {canMutate && (
          <Button
            startIcon={<AddIcon />}
            variant="contained"
            disableElevation
            onClick={() => setCreateOpen(true)}
            sx={{ minHeight: 44 }}
          >
            New workflow
          </Button>
        )}
      </Box>

      {workflows.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon sx={{ fontSize: 32 }} />}
          title="No workflows yet"
          description="Workflows chain approvals, update requests, and cell writes into a repeatable process you can trigger on any row."
          actionLabel={canMutate ? 'Create a workflow' : undefined}
          onAction={canMutate ? () => setCreateOpen(true) : undefined}
        />
      ) : (
        <Stack spacing={1.5}>
          {workflows.map((wf) => (
            <WorkflowCard
              key={wf.id}
              wf={wf}
              onOpen={() => navigate(`/records/${sheetId}/workflows/${wf.id}`)}
            />
          ))}
        </Stack>
      )}

      <CreateWorkflowDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (name) => {
          const res = await recordsApi.workflows.create(sheetId, {
            name,
            status: 'draft',
            steps: [],
          });
          setCreateOpen(false);
          navigate(`/records/${sheetId}/workflows/${res.workflow.id}`);
        }}
      />
    </Box>
  );
}

function WorkflowCard({ wf, onOpen }: { wf: RecordWorkflow; onOpen: () => void }) {
  return (
    <Card variant="outlined" sx={{ borderColor: 'divider' }}>
      <CardActionArea onClick={onOpen} sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <WorkflowIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography sx={{ fontSize: 16, fontWeight: 600 }}>{wf.name}</Typography>
            </Stack>
            {wf.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {wf.description}
              </Typography>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <StatusChip status={wf.status} />
              <Chip
                label={`${wf.steps.length} ${wf.steps.length === 1 ? 'step' : 'steps'}`}
                size="small"
                variant="outlined"
              />
              <Chip
                label={wf.trigger_type === 'manual' ? 'Manual trigger' : 'On row create'}
                size="small"
                variant="outlined"
              />
              {wf.creator_name && (
                <Typography variant="caption" sx={{ color: 'text.secondary', alignSelf: 'center' }}>
                  by {wf.creator_name}
                </Typography>
              )}
            </Stack>
          </Box>
        </Box>
      </CardActionArea>
    </Card>
  );
}

function StatusChip({ status }: { status: RecordWorkflow['status'] }) {
  if (status === 'active') {
    return (
      <Chip
        size="small"
        icon={<ActiveIcon />}
        label="Active"
        color="success"
        variant="outlined"
      />
    );
  }
  if (status === 'archived') {
    return (
      <Chip
        size="small"
        icon={<ArchivedIcon />}
        label="Archived"
        variant="outlined"
      />
    );
  }
  return (
    <Chip
      size="small"
      icon={<DraftIcon />}
      label="Draft"
      variant="outlined"
    />
  );
}

function CreateWorkflowDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>New workflow</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          label="Workflow name"
          fullWidth
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Vendor onboarding approval"
          sx={{ mt: 1 }}
        />
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disableElevation disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
