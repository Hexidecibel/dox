/**
 * StartWorkflowMenu — drawer footer button that lets a user kick off a
 * manual workflow on the current row. Loads active workflows lazily on
 * open so we don't hit the API just to render the row drawer.
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import { AccountTreeOutlined as WorkflowIcon } from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import type { RecordWorkflow } from '../../../shared/types';

interface Props {
  sheetId: string;
  rowId: string;
  onStarted: () => void;
}

export function StartWorkflowMenu({ sheetId, rowId, onStarted }: Props) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [workflows, setWorkflows] = useState<RecordWorkflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = Boolean(anchorEl);

  const handleOpen = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      setAnchorEl(event.currentTarget);
      setError(null);
      if (workflows.length === 0) {
        setLoading(true);
        try {
          const res = await recordsApi.workflows.list(sheetId);
          setWorkflows(res.workflows.filter((w) => w.status === 'active' && w.trigger_type === 'manual'));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load workflows');
        } finally {
          setLoading(false);
        }
      }
    },
    [sheetId, workflows.length],
  );

  const handleStart = async (wf: RecordWorkflow) => {
    setBusyId(wf.id);
    setError(null);
    try {
      await recordsApi.workflowRuns.start(sheetId, rowId, { workflow_id: wf.id });
      onStarted();
      setAnchorEl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Button
        startIcon={<WorkflowIcon />}
        variant="outlined"
        size="small"
        onClick={handleOpen}
        sx={{ minHeight: 36 }}
      >
        Start workflow
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        {loading && (
          <MenuItem disabled sx={{ display: 'flex', justifyContent: 'center' }}>
            <CircularProgress size={16} />
          </MenuItem>
        )}
        {!loading && error && (
          <MenuItem disabled>
            <Alert severity="error" sx={{ width: '100%' }}>{error}</Alert>
          </MenuItem>
        )}
        {!loading && !error && workflows.length === 0 && (
          <MenuItem disabled>
            <Typography variant="body2" color="text.secondary">
              No active workflows. Create one in the Workflows tab.
            </Typography>
          </MenuItem>
        )}
        {!loading && workflows.map((wf) => (
          <MenuItem
            key={wf.id}
            onClick={() => handleStart(wf)}
            disabled={busyId === wf.id}
            sx={{ py: 1.25 }}
          >
            <WorkflowIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
            <div>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {wf.name}
              </Typography>
              {wf.steps.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  {wf.steps.length} {wf.steps.length === 1 ? 'step' : 'steps'}
                </Typography>
              )}
            </div>
            {busyId === wf.id && <CircularProgress size={14} sx={{ ml: 1 }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
