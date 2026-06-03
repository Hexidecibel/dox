/**
 * ConnectorRunReview — R1.3 review surface.
 *
 * Lists every order that the orchestrator routed to staging on a given
 * connector run because the LLM's reported confidence on the order (or
 * one of its items) fell below the threshold. The admin can edit any
 * field inline and then either Approve (clears `staged_at`, commits the
 * row) or Reject (DELETE — cascades the items via FK).
 *
 * Visual reference: the page is a stripped-down sibling of
 * `src/pages/ReviewQueue.tsx`. We deliberately don't replicate the
 * multi-source / VLM diff machinery here — staged orders carry a single
 * extraction-pass payload and a confidence number; there's no second
 * source to diff against.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  CheckCircle as ApproveIcon,
  Cancel as RejectIcon,
} from '@mui/icons-material';
import { formatDate } from '../../utils/format';
import {
  api,
  type StagedRunResponse,
  type StagedOrder,
  type StagedOrderItem,
  type ApproveStagedBody,
  type ApproveStagedItemEdit,
} from '../../lib/api';
import { EmptyState } from '../../components/EmptyState';

/**
 * Local working copy of a staged order — same shape as the API
 * response, but every editable field becomes a draftable string. Items
 * carry a `_clientId` for stable React keys + a `_isNew` flag so we
 * know to INSERT rather than UPDATE on approve.
 */
interface DraftItem {
  _clientId: string;
  _isNew: boolean;
  id: string | null;
  product_name: string;
  product_code: string;
  quantity: string;
  lot_number: string;
  confidence: number | null;
}

interface DraftOrder {
  id: string;
  order_number: string;
  customer_number: string;
  customer_name: string;
  customer_id: string | null;
  confidence: number | null;
  staged_at: string;
  items: DraftItem[];
  // Pristine snapshot — restored on cancel and used to compute the
  // patch body so we only send fields the user actually touched.
  pristine: {
    order_number: string;
    customer_number: string;
    customer_name: string;
    items: Array<Pick<DraftItem, 'id' | 'product_name' | 'product_code' | 'quantity' | 'lot_number'>>;
  };
}

function itemToDraft(item: StagedOrderItem): DraftItem {
  return {
    _clientId: item.id,
    _isNew: false,
    id: item.id,
    product_name: item.product_name ?? '',
    product_code: item.product_code ?? '',
    quantity: item.quantity != null ? String(item.quantity) : '',
    lot_number: item.lot_number ?? '',
    confidence: item.confidence,
  };
}

function orderToDraft(order: StagedOrder): DraftOrder {
  const items = order.items.map(itemToDraft);
  return {
    id: order.id,
    order_number: order.order_number,
    customer_number: order.customer_number ?? '',
    customer_name: order.customer_name ?? '',
    customer_id: order.customer_id,
    confidence: order.confidence,
    staged_at: order.staged_at,
    items,
    pristine: {
      order_number: order.order_number,
      customer_number: order.customer_number ?? '',
      customer_name: order.customer_name ?? '',
      items: items.map((i) => ({
        id: i.id,
        product_name: i.product_name,
        product_code: i.product_code,
        quantity: i.quantity,
        lot_number: i.lot_number,
      })),
    },
  };
}

/**
 * Build the minimal approve-staged patch body for a draft order:
 *   - top-level fields only emitted when they differ from `pristine`
 *   - items array always rebuilt: existing-and-changed → {id, diff},
 *     new → {fields}, deleted → {id, _delete: true}
 *
 * This keeps audit-log payloads tight and avoids overwriting columns
 * the user didn't actually touch with potentially stale draft strings.
 */
function buildApprovePayload(draft: DraftOrder): ApproveStagedBody {
  const body: ApproveStagedBody = {};

  if (draft.order_number !== draft.pristine.order_number) {
    body.order_number = draft.order_number;
  }
  if (draft.customer_number !== draft.pristine.customer_number) {
    body.customer_number = draft.customer_number;
  }
  if (draft.customer_name !== draft.pristine.customer_name) {
    body.customer_name = draft.customer_name;
  }

  const items: ApproveStagedItemEdit[] = [];
  // INSERTs + UPDATEs from current state.
  for (const draftItem of draft.items) {
    if (draftItem._isNew) {
      items.push({
        product_name: draftItem.product_name || null,
        product_code: draftItem.product_code || null,
        quantity: draftItem.quantity ? Number(draftItem.quantity) : null,
        lot_number: draftItem.lot_number || null,
      });
      continue;
    }
    if (!draftItem.id) continue;
    const pristine = draft.pristine.items.find((p) => p.id === draftItem.id);
    if (!pristine) continue;

    const itemPatch: ApproveStagedItemEdit = { id: draftItem.id };
    let dirty = false;
    if (draftItem.product_name !== pristine.product_name) {
      itemPatch.product_name = draftItem.product_name || null;
      dirty = true;
    }
    if (draftItem.product_code !== pristine.product_code) {
      itemPatch.product_code = draftItem.product_code || null;
      dirty = true;
    }
    if (draftItem.quantity !== pristine.quantity) {
      itemPatch.quantity = draftItem.quantity ? Number(draftItem.quantity) : null;
      dirty = true;
    }
    if (draftItem.lot_number !== pristine.lot_number) {
      itemPatch.lot_number = draftItem.lot_number || null;
      dirty = true;
    }
    if (dirty) items.push(itemPatch);
  }
  // DELETEs — anything in pristine that no longer appears in draft.
  const liveIds = new Set(draft.items.map((i) => i.id).filter(Boolean));
  for (const pristine of draft.pristine.items) {
    if (pristine.id && !liveIds.has(pristine.id)) {
      items.push({ id: pristine.id, _delete: true });
    }
  }

  if (items.length > 0) body.items = items;
  return body;
}

function confidenceLabel(confidence: number | null): string {
  if (confidence == null) return 'n/a';
  return confidence.toFixed(2);
}

/**
 * Subtle muted badge that surfaces the LLM's stated confidence on a
 * staged row. Doesn't try to colour-code beyond a low/mid threshold —
 * the colour is meant to draw the eye, not classify.
 */
function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return null;
  return (
    <Tooltip title="LLM-reported extraction confidence (0.0–1.0)" arrow>
      <Chip
        label={`conf ${confidenceLabel(value)}`}
        size="small"
        variant="outlined"
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.7rem',
          height: 20,
          color: value < 0.5 ? 'error.main' : 'text.secondary',
          borderColor: value < 0.5 ? 'error.light' : 'divider',
        }}
      />
    </Tooltip>
  );
}

interface StagedOrderCardProps {
  draft: DraftOrder;
  busy: boolean;
  onChange: (next: DraftOrder) => void;
  onApprove: (draft: DraftOrder) => void;
  onReject: (draft: DraftOrder) => void;
}

function StagedOrderCard({ draft, busy, onChange, onApprove, onReject }: StagedOrderCardProps) {
  const updateItem = (clientId: string, patch: Partial<DraftItem>) => {
    onChange({
      ...draft,
      items: draft.items.map((i) =>
        i._clientId === clientId ? { ...i, ...patch } : i,
      ),
    });
  };

  const removeItem = (clientId: string) => {
    onChange({
      ...draft,
      items: draft.items.filter((i) => i._clientId !== clientId),
    });
  };

  const addItem = () => {
    onChange({
      ...draft,
      items: [
        ...draft.items,
        {
          _clientId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          _isNew: true,
          id: null,
          product_name: '',
          product_code: '',
          quantity: '',
          lot_number: '',
          confidence: null,
        },
      ],
    });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
      <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ mb: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h6" fontWeight={600}>
              Order #{draft.order_number || '(unnamed)'}
            </Typography>
            <ConfidenceBadge value={draft.confidence} />
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField
              label="Order number"
              value={draft.order_number}
              onChange={(e) => onChange({ ...draft, order_number: e.target.value })}
              size="small"
              fullWidth
              disabled={busy}
            />
            <TextField
              label="Customer number"
              value={draft.customer_number}
              onChange={(e) => onChange({ ...draft, customer_number: e.target.value })}
              size="small"
              fullWidth
              disabled={busy}
            />
            <TextField
              label="Customer name"
              value={draft.customer_name}
              onChange={(e) => onChange({ ...draft, customer_name: e.target.value })}
              size="small"
              fullWidth
              disabled={busy}
            />
          </Stack>
        </Box>
      </Stack>

      <TableContainer component={Paper} variant="outlined" sx={{ mb: 1.5 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '28%' }}>Product name</TableCell>
              <TableCell sx={{ width: '18%' }}>Product code</TableCell>
              <TableCell sx={{ width: '12%' }} align="right">Quantity</TableCell>
              <TableCell sx={{ width: '20%' }}>Lot #</TableCell>
              <TableCell sx={{ width: '12%' }} align="right">Conf.</TableCell>
              <TableCell sx={{ width: '10%' }} align="right">{/* actions */}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {draft.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography variant="caption" color="text.secondary">
                    No items. Use "Add item" below to create one.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              draft.items.map((item) => (
                <TableRow key={item._clientId} hover>
                  <TableCell>
                    <TextField
                      value={item.product_name}
                      onChange={(e) => updateItem(item._clientId, { product_name: e.target.value })}
                      size="small"
                      variant="standard"
                      fullWidth
                      disabled={busy}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      value={item.product_code}
                      onChange={(e) => updateItem(item._clientId, { product_code: e.target.value })}
                      size="small"
                      variant="standard"
                      fullWidth
                      disabled={busy}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <TextField
                      value={item.quantity}
                      onChange={(e) => updateItem(item._clientId, { quantity: e.target.value })}
                      size="small"
                      variant="standard"
                      type="number"
                      inputProps={{ style: { textAlign: 'right' } }}
                      disabled={busy}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      value={item.lot_number}
                      onChange={(e) => updateItem(item._clientId, { lot_number: e.target.value })}
                      size="small"
                      variant="standard"
                      fullWidth
                      disabled={busy}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="caption" color={item.confidence != null && item.confidence < 0.5 ? 'error' : 'text.secondary'}>
                      {confidenceLabel(item.confidence)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Remove this item" arrow>
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => removeItem(item._clientId)}
                          disabled={busy}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={addItem}
          disabled={busy}
        >
          Add item
        </Button>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={<RejectIcon />}
            onClick={() => onReject(draft)}
            disabled={busy}
          >
            Reject
          </Button>
          <Button
            size="small"
            color="primary"
            variant="contained"
            startIcon={<ApproveIcon />}
            onClick={() => onApprove(draft)}
            disabled={busy}
          >
            Approve
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

export function IntakeRunReview() {
  const { id: connectorId, runId } = useParams<{ id: string; runId: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<StagedRunResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Per-order busy lock so a single in-flight approve/reject doesn't
  // freeze the rest of the page; bulk operations set the entire list.
  const [busyOrderIds, setBusyOrderIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState<'approve' | 'reject' | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const load = useCallback(async () => {
    if (!connectorId || !runId) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.sources.runs.staged(connectorId, runId);
      setData(result);
      setDrafts(result.orders.map(orderToDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load staged orders');
    } finally {
      setLoading(false);
    }
  }, [connectorId, runId]);

  useEffect(() => { load(); }, [load]);

  const markBusy = (orderId: string, busy: boolean) => {
    setBusyOrderIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(orderId); else next.delete(orderId);
      return next;
    });
  };

  const handleChange = (next: DraftOrder) => {
    setDrafts((prev) => prev.map((d) => (d.id === next.id ? next : d)));
  };

  const handleApprove = async (draft: DraftOrder): Promise<boolean> => {
    markBusy(draft.id, true);
    try {
      await api.orders.approveStaged(draft.id, buildApprovePayload(draft));
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to approve order ${draft.order_number}`);
      return false;
    } finally {
      markBusy(draft.id, false);
    }
  };

  const handleReject = async (draft: DraftOrder, skipConfirm = false): Promise<boolean> => {
    if (!skipConfirm && !confirm(`Reject (delete) order ${draft.order_number}? This cascade-deletes its items.`)) {
      return false;
    }
    markBusy(draft.id, true);
    try {
      await api.orders.delete(draft.id);
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to reject order ${draft.order_number}`);
      return false;
    } finally {
      markBusy(draft.id, false);
    }
  };

  // Bulk operations iterate the current draft list serially. Race
  // protection: we snapshot the list at the start (so a click on a
  // per-order button mid-bulk doesn't reorder iteration), and we
  // refuse to start a second bulk while one is running.
  const runBulk = async (mode: 'approve' | 'reject') => {
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: drafts.length });
    const snapshot = [...drafts];
    let done = 0;
    for (const draft of snapshot) {
      if (mode === 'approve') {
        await handleApprove(draft);
      } else {
        await handleReject(draft, true);
      }
      done += 1;
      setBulkProgress({ done, total: snapshot.length });
    }
    setBulkRunning(false);
    setBulkOpen(null);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!data) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">{error || 'Run not found'}</Alert>
        <Button
          startIcon={<BackIcon />}
          onClick={() => navigate(`/admin/sources/${connectorId}`)}
          sx={{ mt: 2 }}
        >
          Back to source
        </Button>
      </Box>
    );
  }

  const stagedCount = drafts.length;

  return (
    <Box>
      <Button
        component={RouterLink}
        to={`/admin/sources/${connectorId}`}
        startIcon={<BackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Back to source
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Header card */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
          <Box>
            <Typography variant="h5" fontWeight={700}>
              Review staged extraction
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Run started {data.run.started_at ? formatDate(data.run.started_at) : 'unknown'}
              {data.run.completed_at && ` · completed ${formatDate(data.run.completed_at)}`}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              <Chip label={`status: ${data.run.status}`} size="small" variant="outlined" />
              <Chip label={`${stagedCount} staged`} size="small" color={stagedCount > 0 ? 'warning' : 'default'} />
              <Chip label={`${data.run.records_created} total created`} size="small" variant="outlined" />
            </Stack>
          </Box>
          {stagedCount > 0 && (
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                color="error"
                startIcon={<RejectIcon />}
                onClick={() => setBulkOpen('reject')}
                disabled={bulkRunning}
              >
                Reject all
              </Button>
              <Button
                variant="contained"
                color="primary"
                startIcon={<ApproveIcon />}
                onClick={() => setBulkOpen('approve')}
                disabled={bulkRunning}
              >
                Approve all
              </Button>
            </Stack>
          )}
        </Stack>
      </Paper>

      {stagedCount === 0 ? (
        <EmptyState
          title="No staged orders for this run"
          description="Every order from this run was either committed (LLM confidence above the threshold) or has already been reviewed. If you expected staged rows here, check the connector's recent runs list."
        />
      ) : (
        drafts.map((draft) => (
          <StagedOrderCard
            key={draft.id}
            draft={draft}
            busy={busyOrderIds.has(draft.id) || bulkRunning}
            onChange={handleChange}
            onApprove={(d) => { void handleApprove(d); }}
            onReject={(d) => { void handleReject(d); }}
          />
        ))
      )}

      {/* Bulk confirm dialog */}
      <Dialog
        open={bulkOpen !== null}
        onClose={() => !bulkRunning && setBulkOpen(null)}
      >
        <DialogTitle>
          {bulkOpen === 'approve' ? 'Approve all staged orders?' : 'Reject all staged orders?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {bulkOpen === 'approve' ? (
              <>This will promote {stagedCount} staged order{stagedCount === 1 ? '' : 's'} as-is (with any edits you've made above). Confidence values are preserved on the rows.</>
            ) : (
              <>This will <strong>permanently delete</strong> {stagedCount} order{stagedCount === 1 ? '' : 's'} and all their items. There is no undo.</>
            )}
            {bulkRunning && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="caption">
                  Processing {bulkProgress.done} / {bulkProgress.total}…
                </Typography>
              </Box>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkOpen(null)} disabled={bulkRunning}>
            Cancel
          </Button>
          <Button
            onClick={() => bulkOpen && runBulk(bulkOpen)}
            color={bulkOpen === 'approve' ? 'primary' : 'error'}
            variant="contained"
            disabled={bulkRunning}
          >
            {bulkRunning ? 'Working…' : bulkOpen === 'approve' ? 'Approve all' : 'Reject all'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default IntakeRunReview;
