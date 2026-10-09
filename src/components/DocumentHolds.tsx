/**
 * Holds on one certificate (decision C-005, migration 0139).
 *
 * A banner when the certificate is on hold, a chip per lot row that is held,
 * "Place hold" for anybody who may edit, "Release hold" for QA and
 * administrators, and the history of every hold there has been.
 *
 * A REASON IS REQUIRED BOTH WAYS. The server decides who may do what
 * (`can_place`, `can_release`) and decides again when the change is saved.
 *
 * A hold is in the portal only. It stops the certificate being sent; it does
 * not stop a signed-in person opening it, and nothing reaches a warehouse
 * system.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { announceHoldsChanged } from '../lib/holds';
import { formatDateTime } from '../utils/format';
import { HOLD_REASON_MAX, HOLD_SOURCE_HELP, HOLD_SOURCE_LABELS } from '../../shared/holds';
import type { DocumentHoldBrief, DocumentHoldsResponse } from '../../shared/types';

/** The Select's value for "the whole certificate". */
const WHOLE = 'whole';

export function holdWhere(hold: { lot_label: string | null }): string {
  return hold.lot_label ? `Lot ${hold.lot_label}` : 'Whole certificate';
}

/** One dialog for both acts: the same box, the same rule. */
export function HoldReasonDialog({
  open,
  title,
  intro,
  confirmLabel,
  busy,
  error,
  children,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  intro: string;
  confirmLabel: string;
  busy: boolean;
  error: string;
  children?: React.ReactNode;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog open={open} onClose={() => !busy && onCancel()} fullWidth maxWidth="sm" data-testid="hold-reason-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} data-testid="hold-dialog-error">
            {error}
          </Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {intro}
        </Typography>
        {children}
        <TextField
          label="Why"
          fullWidth
          required
          multiline
          minRows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          helperText="Recorded with the hold. Whoever reads the audit trail will see it."
          inputProps={{ maxLength: HOLD_REASON_MAX, 'data-testid': 'hold-reason' }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || reason.trim().length === 0}
          data-testid="hold-confirm"
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface Props {
  documentId: string;
  /** Called after a hold is placed or released, so the page can reload. */
  onChanged?: () => void;
}

export function DocumentHolds({ documentId, onChanged }: Props) {
  const [data, setData] = useState<DocumentHoldsResponse | null>(null);
  const [placing, setPlacing] = useState(false);
  const [lotChoice, setLotChoice] = useState<string>(WHOLE);
  const [releasing, setReleasing] = useState<DocumentHoldBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [retryError, setRetryError] = useState('');

  const load = useCallback(() => {
    api.holds
      .forDocument(documentId)
      .then(setData)
      // An older server, or a document the caller may not see: say nothing
      // rather than guess. The exits enforce the hold either way.
      .catch(() => setData(null));
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const { active, history, lots } = data;
  // Holds placed on ANOTHER certificate that stop this one too: a hold on a lot
  // this certificate carries (a lot hold covers every certificate of the lot),
  // or on a neighbour lot whose page this file prints.
  const carried = data.also_held_by ?? [];
  const ownLots = new Set(lots.map((l) => l.lot_id));
  const failures = data.failures ?? [];
  if (active.length === 0 && carried.length === 0 && history.length === 0 && failures.length === 0 && !data.can_place) return null;

  const retry = async (failureId: string) => {
    setBusy(true);
    setRetryError('');
    try {
      await api.holds.retryFailure(failureId);
      done();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'The hold could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    load();
    announceHoldsChanged();
    onChanged?.();
  };

  const place = async (reason: string) => {
    setBusy(true);
    setError('');
    try {
      await api.holds.place(documentId, { reason, lot_id: lotChoice === WHOLE ? null : lotChoice });
      setPlacing(false);
      done();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The hold could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  const release = async (reason: string) => {
    if (!releasing) return;
    setBusy(true);
    setError('');
    try {
      await api.holds.release(releasing.id, reason);
      setReleasing(null);
      done();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The hold could not be released.');
    } finally {
      setBusy(false);
    }
  };

  const heldLots = lots.filter((l) => l.hold);

  return (
    <Box sx={{ mb: 2 }} data-testid="document-holds">
      {failures.length > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }} data-testid="hold-failure">
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            A hold should have been placed on this certificate and was not.
          </Typography>
          <Typography variant="caption" component="div" sx={{ mb: 0.5 }}>
            It was approved with a result that places a hold, and the hold could not be written. It is NOT on hold and
            can be sent until somebody retries.
          </Typography>
          {failures.map((f) => (
            <Box key={f.id} sx={{ mt: 0.5 }} data-testid="hold-failure-row">
              {f.holds.map((h, i) => (
                <Typography key={i} variant="body2">
                  {h.reason}
                </Typography>
              ))}
              {data.can_place && (
                <Button
                  size="small"
                  color="inherit"
                  variant="outlined"
                  sx={{ mt: 0.5, textTransform: 'none' }}
                  disabled={busy}
                  onClick={() => retry(f.id)}
                  data-testid="hold-failure-retry"
                >
                  Retry: place the hold
                </Button>
              )}
            </Box>
          ))}
          {retryError && (
            <Typography variant="caption" color="error" component="div" data-testid="hold-failure-error">
              {retryError}
            </Typography>
          )}
        </Alert>
      )}
      {active.length === 0 && carried.length > 0 && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="hold-carried-banner">
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            On hold. This certificate cannot be sent: a hold placed on another certificate covers it.
          </Typography>
          <Typography variant="caption" component="div">
            A hold on a lot covers every certificate of that lot, and every file that prints it. It goes once that hold
            is released.
          </Typography>
        </Alert>
      )}
      {carried.length > 0 && (
        <Box sx={{ mb: 1 }} data-testid="hold-carried">
          {carried.map((h) => (
            <Box key={h.id} sx={{ mb: 0.5 }} data-testid="hold-carried-row">
              <Typography variant="body2">
                <strong>{holdWhere(h)}:</strong> {h.reason}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {h.lot_id && ownLots.has(h.lot_id)
                  ? 'This lot is on hold. Held from '
                  : "This file also prints that lot's results. Held from "}
                <Link component={RouterLink} to={`/documents/${h.document_id}`} underline="hover">
                  {h.document_title || 'another certificate'}
                </Link>
                .
              </Typography>
              {data.can_release && (
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  sx={{ mt: 0.5, textTransform: 'none' }}
                  onClick={() => {
                    setError('');
                    setReleasing(h);
                  }}
                  data-testid="hold-carried-release"
                >
                  Release hold
                </Button>
              )}
            </Box>
          ))}
        </Box>
      )}
      {active.length > 0 && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="hold-banner">
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            On hold. This certificate cannot be sent until the hold is released.
          </Typography>
          <Typography variant="caption" component="div" sx={{ mb: 0.5 }}>
            It stays out of orders, ZIPs, links, bundles and API key reads. It can still be opened here. The hold is in
            the portal only.
          </Typography>
          {active.map((h) => (
            <Box key={h.id} sx={{ mt: 0.75 }} data-testid="hold-active">
              <Typography variant="body2">
                <strong>{holdWhere(h)}:</strong> {h.reason}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {HOLD_SOURCE_LABELS[h.source]}
                {h.placed_by_name ? ` by ${h.placed_by_name}` : ''} on {formatDateTime(h.placed_at)}
                {h.detail?.location ? ` · ${h.detail.location}` : ''}
              </Typography>
              {data.can_release && (
                <Button
                  size="small"
                  color="inherit"
                  variant="outlined"
                  sx={{ mt: 0.5, textTransform: 'none' }}
                  onClick={() => {
                    setError('');
                    setReleasing(h);
                  }}
                  data-testid="hold-release"
                >
                  Release hold
                </Button>
              )}
            </Box>
          ))}
          {!data.can_release && (
            <Typography variant="caption" component="div" sx={{ mt: 0.75 }} data-testid="hold-who-releases">
              QA or an administrator releases a hold.
            </Typography>
          )}
        </Alert>
      )}

      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        Holds
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {active.length === 0 && carried.length === 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="hold-none">
            Not on hold.
          </Typography>
        )}
        {heldLots.map((l) => (
          <Chip
            key={l.lot_id}
            size="small"
            color="error"
            label={`Lot ${l.lot_label} on hold`}
            title={l.hold && l.hold.document_id !== documentId ? `Held from ${l.hold.document_title || 'another certificate'}` : undefined}
            data-testid="hold-lot-chip"
          />
        ))}
        {active.some((h) => !h.lot_id) && <Chip size="small" color="error" label="Whole certificate on hold" data-testid="hold-whole-chip" />}
        {data.can_place && (
          <Button
            size="small"
            sx={{ textTransform: 'none' }}
            onClick={() => {
              setError('');
              setLotChoice(WHOLE);
              setPlacing(true);
            }}
            data-testid="hold-place"
          >
            Place hold
          </Button>
        )}
        {history.length > 0 && (
          <Button size="small" sx={{ textTransform: 'none' }} onClick={() => setShowHistory((v) => !v)} data-testid="hold-history-toggle">
            {showHistory ? 'Hide history' : `History (${history.length})`}
          </Button>
        )}
      </Box>

      {showHistory && (
        <Box sx={{ mt: 1 }} data-testid="hold-history">
          {history.map((h) => (
            <Box key={h.id} sx={{ mb: 1 }} data-testid="hold-history-row">
              <Typography variant="body2">
                <strong>{holdWhere(h)}:</strong> {h.reason}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {HOLD_SOURCE_LABELS[h.source]}
                {h.placed_by_name ? ` by ${h.placed_by_name}` : ''} on {formatDateTime(h.placed_at)}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                Released{h.released_by_name ? ` by ${h.released_by_name}` : ''}
                {h.released_at ? ` on ${formatDateTime(h.released_at)}` : ''}: {h.release_reason}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      <HoldReasonDialog
        open={placing}
        title="Place a hold"
        intro="A hold stops this certificate being sent on an order, in a ZIP, by link, in a bundle or read with an API key, until QA or an administrator releases it. It can still be opened in the portal."
        confirmLabel="Place hold"
        busy={busy}
        error={error}
        onCancel={() => setPlacing(false)}
        onConfirm={place}
      >
        {lots.length > 0 && (
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="hold-lot-label">What is on hold</InputLabel>
            <Select
              labelId="hold-lot-label"
              label="What is on hold"
              value={lotChoice}
              onChange={(e) => setLotChoice(e.target.value)}
              disabled={busy}
              inputProps={{ 'data-testid': 'hold-lot-select' }}
            >
              <MenuItem value={WHOLE}>The whole certificate</MenuItem>
              {lots.map((l) => (
                <MenuItem key={l.lot_id} value={l.lot_id} disabled={Boolean(l.hold)}>
                  Lot {l.lot_label}
                  {l.hold ? ' (already on hold)' : ''}
                </MenuItem>
              ))}
            </Select>
            {lots.length > 1 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                This file covers {lots.length} lots. A hold on one lot stops the whole file, because the file prints every lot.
              </Typography>
            )}
          </FormControl>
        )}
      </HoldReasonDialog>

      <HoldReasonDialog
        open={Boolean(releasing)}
        title="Release this hold"
        intro={
          releasing
            ? `${holdWhere(releasing)}: ${releasing.reason} (${HOLD_SOURCE_HELP[releasing.source]}) Releasing it lets the certificate be sent again.`
            : ''
        }
        confirmLabel="Release hold"
        busy={busy}
        error={error}
        onCancel={() => setReleasing(null)}
        onConfirm={release}
      />
    </Box>
  );
}
