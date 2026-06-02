import { useMemo, useState, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Alert,
  CircularProgress,
  Divider,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ProcessingQueueItem, LotMatchSuggestion } from '../lib/types';
import type { ParsedShipment } from '../../shared/connectorOutput';

/**
 * Review Queue v2 — editable review tile for output_kind === 'shipment' items.
 *
 * Shipment items carry their extracted data in `item.ai_records` (JSON) as
 * `{ shipments }`. Each shipment binds an order line to the physical lot that
 * shipped against it. The reviewer edits the rows, then "Accept & produce"
 * re-runs the shipment producer (produceShipment) over the edited records.
 *
 * Producing a shipment can emit WEAK COA→lot match suggestions (the engine
 * found a plausible-but-not-certain COA for a shipped lot). Those only exist
 * AFTER the producer runs, so we fetch + render them in a second section once
 * accept succeeds, with Confirm / Reject controls.
 */

interface ShipmentRecords {
  shipments: ParsedShipment[];
}

function parseRecords(raw: string | null): ShipmentRecords {
  if (!raw) return { shipments: [] };
  try {
    const parsed = JSON.parse(raw);
    return { shipments: Array.isArray(parsed?.shipments) ? parsed.shipments : [] };
  } catch {
    return { shipments: [] };
  }
}

function emptyShipment(): ParsedShipment {
  return { order_number: '', lot_number: '', product_code: '', product_name: '' };
}

export default function ShipmentReviewTile({
  item,
  onApproved,
}: {
  item: ProcessingQueueItem;
  onApproved: () => void;
}) {
  const initial = useMemo(() => parseRecords(item.ai_records), [item.ai_records]);
  const [rows, setRows] = useState<ParsedShipment[]>(() => initial.shipments.map((s) => ({ ...s })));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [accepted, setAccepted] = useState(item.status === 'approved');

  const [suggestions, setSuggestions] = useState<LotMatchSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});

  const readOnly = item.status !== 'pending';

  const updateField = (idx: number, key: keyof ParsedShipment, value: string) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  };

  const addRow = () => setRows((prev) => [...prev, emptyShipment()]);
  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

  const fetchSuggestions = useCallback(async (shipments: ParsedShipment[]) => {
    const orderNumbers = Array.from(
      new Set(shipments.map((s) => (s.order_number || '').trim()).filter(Boolean)),
    );
    if (orderNumbers.length === 0) {
      setSuggestions([]);
      return;
    }
    setSuggestionsLoading(true);
    try {
      const res = await api.lotMatches.list({ status: 'pending', order_number: orderNumbers });
      setSuggestions(res.suggestions || []);
    } catch {
      // Non-fatal: the accept already succeeded; just couldn't load matches.
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  const handleAccept = async () => {
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.queue.approve(item.id, {
        records: { shipments: rows },
      });
      setSuccess(res.summary || 'Shipment accepted and produced');
      setAccepted(true);
      onApproved();
      // Weak match suggestions are produced BY the accept above, so fetch now.
      await fetchSuggestions(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (id: string, action: 'accept' | 'reject') => {
    setResolving((prev) => ({ ...prev, [id]: true }));
    try {
      await api.lotMatches.resolve(id, action);
      // Re-fetch so the resolved row drops out of the pending list.
      await fetchSuggestions(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve match');
    } finally {
      setResolving((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Shipment lines ({rows.length})
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {rows.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No shipment lines were extracted from this document.
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Order Number</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Product Code</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Product Name</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Lot Number</TableCell>
              <TableCell sx={{ width: 56 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, idx) => (
              <TableRow key={idx}>
                <TableCell>
                  <TextField
                    value={r.order_number ?? ''}
                    onChange={(e) => updateField(idx, 'order_number', e.target.value)}
                    size="small"
                    variant="standard"
                    fullWidth
                    disabled={readOnly || submitting}
                    InputProps={{ disableUnderline: readOnly }}
                  />
                </TableCell>
                <TableCell>
                  <TextField
                    value={r.product_code ?? ''}
                    onChange={(e) => updateField(idx, 'product_code', e.target.value)}
                    size="small"
                    variant="standard"
                    fullWidth
                    disabled={readOnly || submitting}
                    InputProps={{ disableUnderline: readOnly }}
                  />
                </TableCell>
                <TableCell>
                  <TextField
                    value={r.product_name ?? ''}
                    onChange={(e) => updateField(idx, 'product_name', e.target.value)}
                    size="small"
                    variant="standard"
                    fullWidth
                    disabled={readOnly || submitting}
                    InputProps={{ disableUnderline: readOnly }}
                  />
                </TableCell>
                <TableCell>
                  <TextField
                    value={r.lot_number ?? ''}
                    onChange={(e) => updateField(idx, 'lot_number', e.target.value)}
                    size="small"
                    variant="standard"
                    fullWidth
                    disabled={readOnly || submitting}
                    InputProps={{ disableUnderline: readOnly }}
                  />
                </TableCell>
                <TableCell>
                  {!readOnly && (
                    <IconButton
                      size="small"
                      onClick={() => removeRow(idx)}
                      disabled={submitting}
                      title="Remove line"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {!readOnly && (
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addRow} disabled={submitting}>
            Add Line
          </Button>
          <Button
            variant="contained"
            color="success"
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
            onClick={handleAccept}
            disabled={submitting || rows.length === 0}
          >
            Accept &amp; produce
          </Button>
        </Box>
      )}

      {/* COA → lot match suggestions. These are produced by the accept above,
          so they only appear once the shipment has been accepted. */}
      {(accepted || suggestions.length > 0) && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            COA → lot match suggestions
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            These weak matches are produced by accepting the shipment — the engine found
            candidate COAs for the shipped lots but isn&apos;t certain. Confirm the correct
            ones to bind the COA to the order line.
          </Typography>

          {suggestionsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={20} />
            </Box>
          ) : suggestions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No pending match suggestions.
            </Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>COA Document</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Lot</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Product</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Basis</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Confidence</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: 160 }} align="right">
                      Resolve
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {suggestions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.document_title || s.document_id}</TableCell>
                      <TableCell>{s.lot_number || '—'}</TableCell>
                      <TableCell>{s.product_name || '—'}</TableCell>
                      <TableCell>
                        {s.match_basis ? (
                          <Chip label={s.match_basis} size="small" variant="outlined" />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {s.match_confidence != null
                          ? `${Math.round(s.match_confidence * 100)}%`
                          : '—'}
                      </TableCell>
                      <TableCell align="right">
                        <Box sx={{ display: 'inline-flex', gap: 0.5 }}>
                          <Button
                            size="small"
                            variant="contained"
                            color="success"
                            startIcon={
                              resolving[s.id] ? (
                                <CircularProgress size={14} color="inherit" />
                              ) : (
                                <CheckIcon fontSize="small" />
                              )
                            }
                            disabled={!!resolving[s.id]}
                            onClick={() => handleResolve(s.id, 'accept')}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            startIcon={<CloseIcon fontSize="small" />}
                            disabled={!!resolving[s.id]}
                            onClick={() => handleResolve(s.id, 'reject')}
                          >
                            Reject
                          </Button>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </Box>
  );
}
