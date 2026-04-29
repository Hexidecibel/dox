/**
 * /approvals — in-app approvals inbox.
 *
 * Lists pending workflow approvals assigned to the current user. Each
 * card shows: row title + sheet, step name, message, due-by, sender. Tap
 * "Approve" / "Reject" to act inline (no navigation away).
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  CheckCircleOutline as ApproveIcon,
  CancelOutlined as RejectIcon,
  AccountTree as WorkflowIcon,
} from '@mui/icons-material';
import { recordsApi } from '../lib/recordsApi';
import type { WorkflowApprovalInboxItem } from '../../shared/types';

export function Approvals() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkflowApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await recordsApi.workflowApprovals.inbox();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 920, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <WorkflowIcon />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>My approvals</Typography>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {items.length === 0 ? (
        <Card variant="outlined" sx={{ p: 4, textAlign: 'center', borderStyle: 'dashed', borderColor: 'divider' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Nothing waiting on you
          </Typography>
          <Typography variant="body2" color="text.secondary">
            When a workflow assigns you an approval, it'll show up here.
          </Typography>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {items.map((item) => (
            <ApprovalCard
              key={item.step_run_id}
              item={item}
              onResolved={() => {
                setItems((prev) => prev.filter((i) => i.step_run_id !== item.step_run_id));
              }}
              onOpenRow={() => navigate(`/records/${item.sheet_id}`)}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ApprovalCard({
  item,
  onResolved,
  onOpenRow,
}: {
  item: WorkflowApprovalInboxItem;
  onResolved: () => void;
  onOpenRow: () => void;
}) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const handle = async (decision: 'approve' | 'reject') => {
    setSubmitting(true);
    setError(null);
    try {
      await recordsApi.workflowApprovals.submit(item.step_run_id, {
        decision,
        comment: comment.trim() || null,
      });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
            {item.workflow_name.toUpperCase()} · {item.step_name.toUpperCase()}
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 600, mt: 0.25 }}>
            {item.row_title || 'Untitled record'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            in {item.sheet_name}
            {item.triggered_by_name && ` · started by ${item.triggered_by_name}`}
          </Typography>
          {item.message && (
            <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic', color: 'text.secondary' }}>
              "{item.message}"
            </Typography>
          )}
        </Box>
        <Button size="small" onClick={onOpenRow}>
          Open record
        </Button>
      </Box>

      {expanded ? (
        <Box sx={{ mt: 2 }}>
          <TextField
            label="Comment (optional)"
            placeholder="Add context — especially helpful when rejecting."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            fullWidth
            multiline
            minRows={2}
            inputProps={{ maxLength: 2000 }}
          />
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button
              variant="contained"
              disableElevation
              color="success"
              startIcon={<ApproveIcon />}
              onClick={() => handle('approve')}
              disabled={submitting}
            >
              Approve
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<RejectIcon />}
              onClick={() => handle('reject')}
              disabled={submitting}
            >
              Reject
            </Button>
            <Button onClick={() => setExpanded(false)} disabled={submitting}>
              Cancel
            </Button>
          </Stack>
        </Box>
      ) : (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button variant="contained" disableElevation onClick={() => setExpanded(true)}>
            Decide
          </Button>
        </Stack>
      )}
    </Card>
  );
}
