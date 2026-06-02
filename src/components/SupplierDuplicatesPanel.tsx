import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Chip,
  Collapse,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Radio,
  RadioGroup,
  FormControlLabel,
  CircularProgress,
  Alert,
  Snackbar,
  Divider,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Close as CloseIcon,
  MergeType as MergeIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  SupplierDuplicateCluster,
  SupplierDuplicateMember,
} from '../lib/types';

interface SupplierDuplicatesPanelProps {
  /** Whether the current user may perform merges (org_admin / super_admin). */
  canMerge: boolean;
  /** Called after a successful merge so the parent can refresh its list. */
  onMerged?: () => void;
}

function reasonLabel(reason: SupplierDuplicateCluster['reason']): string {
  return reason === 'normalized' ? 'Same name' : 'Similar';
}

/** Default the survivor to the member with the most documents. */
function pickDefaultWinner(members: SupplierDuplicateMember[]): string {
  if (members.length === 0) return '';
  return members.reduce((best, m) => (m.doc_count > best.doc_count ? m : best), members[0]).id;
}

export function SupplierDuplicatesPanel({ canMerge, onMerged }: SupplierDuplicatesPanelProps) {
  const [clusters, setClusters] = useState<SupplierDuplicateCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);

  // Merge dialog state
  const [mergeCluster, setMergeCluster] = useState<SupplierDuplicateCluster | null>(null);
  const [winnerId, setWinnerId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');

  const [snackbar, setSnackbar] = useState('');

  const loadDuplicates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.suppliers.duplicates();
      setClusters(result.clusters || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load duplicate suppliers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  const openMerge = (cluster: SupplierDuplicateCluster) => {
    setMergeCluster(cluster);
    setWinnerId(pickDefaultWinner(cluster.suppliers));
    setMergeError('');
    setMerging(false);
  };

  const closeMerge = () => {
    if (merging) return;
    setMergeCluster(null);
  };

  const handleMerge = async () => {
    if (!mergeCluster || !winnerId) return;
    const loserIds = mergeCluster.suppliers.filter((s) => s.id !== winnerId).map((s) => s.id);
    if (loserIds.length === 0) return;

    setMerging(true);
    setMergeError('');
    try {
      const result = await api.suppliers.merge(winnerId, loserIds);
      const totalReassigned = Object.values(result.reassigned || {}).reduce(
        (sum, n) => sum + (n || 0),
        0
      );
      const winnerName =
        mergeCluster.suppliers.find((s) => s.id === winnerId)?.name ?? 'supplier';
      setSnackbar(
        `Merged ${loserIds.length} supplier${loserIds.length === 1 ? '' : 's'} into "${winnerName}". ` +
          `Reassigned ${totalReassigned} document${totalReassigned === 1 ? '' : 's'}.`
      );
      setMergeCluster(null);
      await loadDuplicates();
      onMerged?.();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Failed to merge suppliers');
    } finally {
      setMerging(false);
    }
  };

  // Nothing to show while loading the first time, or when there are no clusters.
  if (loading) {
    return (
      <Paper variant="outlined" sx={{ p: 2, mb: 3, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          Checking for duplicate suppliers…
        </Typography>
      </Paper>
    );
  }

  if (error) {
    return (
      <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setError('')}>
        {error}
      </Alert>
    );
  }

  if (clusters.length === 0) return null;

  const winner = mergeCluster?.suppliers.find((s) => s.id === winnerId) ?? null;
  const losers = mergeCluster?.suppliers.filter((s) => s.id !== winnerId) ?? [];

  return (
    <>
      <Paper variant="outlined" sx={{ mb: 3, borderColor: 'warning.light' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 1.5,
            cursor: 'pointer',
          }}
          onClick={() => setExpanded((e) => !e)}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <MergeIcon fontSize="small" color="warning" />
            <Typography variant="subtitle1" fontWeight={600}>
              Possible duplicate suppliers ({clusters.length})
            </Typography>
          </Box>
          <IconButton size="small">
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Box>
        <Collapse in={expanded}>
          <Divider />
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {clusters.map((cluster, idx) => (
              <Paper
                key={idx}
                variant="outlined"
                sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 1,
                    flexWrap: 'wrap',
                  }}
                >
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
                    {cluster.suppliers.map((s) => (
                      <Box
                        key={s.id}
                        sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
                      >
                        <Typography variant="body2" fontWeight={500}>
                          {s.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace' }}
                        >
                          {s.slug || '—'}
                        </Typography>
                        <Chip
                          label={`${s.doc_count} doc${s.doc_count === 1 ? '' : 's'}`}
                          size="small"
                          variant="outlined"
                        />
                      </Box>
                    ))}
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Chip
                      label={reasonLabel(cluster.reason)}
                      size="small"
                      color={cluster.reason === 'normalized' ? 'warning' : 'default'}
                      variant="outlined"
                    />
                    {canMerge && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<MergeIcon />}
                        onClick={() => openMerge(cluster)}
                        disabled={cluster.suppliers.length < 2}
                      >
                        Merge…
                      </Button>
                    )}
                  </Box>
                </Box>
              </Paper>
            ))}
          </Box>
        </Collapse>
      </Paper>

      {/* Merge dialog */}
      <Dialog open={!!mergeCluster} onClose={closeMerge} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Merge duplicate suppliers
          <IconButton onClick={closeMerge} size="small" disabled={merging}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {mergeError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setMergeError('')}>
              {mergeError}
            </Alert>
          )}
          <DialogContentText sx={{ mb: 2 }}>
            Pick the supplier to keep (the survivor). The others will be merged into it.
          </DialogContentText>
          <RadioGroup value={winnerId} onChange={(e) => setWinnerId(e.target.value)}>
            {mergeCluster?.suppliers.map((s) => (
              <FormControlLabel
                key={s.id}
                value={s.id}
                disabled={merging}
                control={<Radio />}
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" fontWeight={500}>
                      {s.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'monospace' }}
                    >
                      {s.slug || '—'}
                    </Typography>
                    <Chip
                      label={`${s.doc_count} doc${s.doc_count === 1 ? '' : 's'}`}
                      size="small"
                      variant="outlined"
                    />
                  </Box>
                }
              />
            ))}
          </RadioGroup>
          {winner && losers.length > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }} icon={false}>
              <Typography variant="body2">
                Keep <strong>{winner.name}</strong>. Merge{' '}
                <strong>{losers.map((l) => l.name).join(', ')}</strong> into it. This reassigns all
                their documents, products, lots, templates, and instructions to{' '}
                <strong>{winner.name}</strong>, then deletes them.{' '}
                <strong>This cannot be undone.</strong>
              </Typography>
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeMerge} disabled={merging}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={handleMerge}
            disabled={merging || !winnerId || losers.length === 0}
            startIcon={merging ? <CircularProgress size={16} color="inherit" /> : <MergeIcon />}
          >
            {merging ? 'Merging…' : 'Merge suppliers'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snackbar}
        autoHideDuration={6000}
        onClose={() => setSnackbar('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setSnackbar('')}>
          {snackbar}
        </Alert>
      </Snackbar>
    </>
  );
}
