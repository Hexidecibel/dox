import { useMemo, useState } from 'react';
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
  Tooltip,
  Divider,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ProcessingQueueItem } from '../lib/types';
import type { ParsedCustomer, ParsedOrder, ParsedOrderItem } from '../../shared/connectorOutput';

/**
 * Review Queue v2 — editable review tile for output_kind === 'order' items.
 *
 * Order items carry their extracted data in `item.ai_records` (JSON), NOT in
 * `ai_fields`. We parse `{ customers, orders }`, let the reviewer edit order
 * headers + line-item rows, then approve. On approve the backend re-runs the
 * order producer (ingestOrders) over the edited records.
 *
 * Anything the producer would stage instead of commit (_confidence < 0.7) is
 * flagged with a "Low confidence" chip so the reviewer knows what to fix.
 */

const STAGE_THRESHOLD = 0.7;

interface OrderRecords {
  customers: ParsedCustomer[];
  orders: ParsedOrder[];
}

function parseRecords(raw: string | null): OrderRecords {
  if (!raw) return { customers: [], orders: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      customers: Array.isArray(parsed?.customers) ? parsed.customers : [],
      orders: Array.isArray(parsed?.orders) ? parsed.orders : [],
    };
  } catch {
    return { customers: [], orders: [] };
  }
}

function emptyItem(): ParsedOrderItem {
  return { product_name: '', product_code: '', lot_number: '', quantity: undefined };
}

export default function OrderReviewTile({
  item,
  onApproved,
}: {
  item: ProcessingQueueItem;
  onApproved: () => void;
}) {
  const initial = useMemo(() => parseRecords(item.ai_records), [item.ai_records]);
  const [orders, setOrders] = useState<ParsedOrder[]>(() =>
    initial.orders.map((o) => ({ ...o, items: (o.items || []).map((it) => ({ ...it })) })),
  );
  // Customers are not directly editable in this tile (they ride along on the
  // order via customer_number/customer_name), but we preserve them verbatim so
  // the producer can upsert them on approve.
  const [customers] = useState<ParsedCustomer[]>(initial.customers);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const readOnly = item.status !== 'pending';

  const updateOrderField = (idx: number, key: keyof ParsedOrder, value: string) => {
    setOrders((prev) => prev.map((o, i) => (i === idx ? { ...o, [key]: value } : o)));
  };

  const updateItemField = (
    orderIdx: number,
    itemIdx: number,
    key: keyof ParsedOrderItem,
    value: string,
  ) => {
    setOrders((prev) =>
      prev.map((o, i) => {
        if (i !== orderIdx) return o;
        const items = o.items.map((it, j) => {
          if (j !== itemIdx) return it;
          if (key === 'quantity') {
            const num = value.trim() === '' ? undefined : Number(value);
            return { ...it, quantity: Number.isFinite(num as number) ? (num as number) : undefined };
          }
          return { ...it, [key]: value };
        });
        return { ...o, items };
      }),
    );
  };

  const addRow = (orderIdx: number) => {
    setOrders((prev) =>
      prev.map((o, i) => (i === orderIdx ? { ...o, items: [...o.items, emptyItem()] } : o)),
    );
  };

  const removeRow = (orderIdx: number, itemIdx: number) => {
    setOrders((prev) =>
      prev.map((o, i) =>
        i === orderIdx ? { ...o, items: o.items.filter((_, j) => j !== itemIdx) } : o,
      ),
    );
  };

  const handleApprove = async () => {
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.queue.approve(item.id, {
        records: { customers, orders },
      });
      setSuccess(res.summary || 'Order approved and produced');
      onApproved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setSubmitting(false);
    }
  };

  const isLowConf = (conf: number | undefined): boolean =>
    conf != null && conf < STAGE_THRESHOLD;

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Order records ({orders.length})
        {customers.length > 0 && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            · {customers.length} customer{customers.length === 1 ? '' : 's'} attached
          </Typography>
        )}
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

      {orders.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No order records were extracted from this document.
        </Alert>
      )}

      {orders.map((order, orderIdx) => {
        const orderLowConf = isLowConf(order._confidence);
        return (
          <Paper key={orderIdx} variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
              <Typography variant="subtitle2">Order {orderIdx + 1}</Typography>
              {orderLowConf && (
                <Tooltip title={`LLM confidence ${Math.round((order._confidence ?? 0) * 100)}% — below the ${Math.round(STAGE_THRESHOLD * 100)}% commit threshold; would be staged.`} arrow>
                  <Chip label="Low confidence" size="small" color="warning" variant="outlined" />
                </Tooltip>
              )}
            </Box>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1.5,
                mb: 2,
              }}
            >
              <TextField
                label="Order Number"
                value={order.order_number ?? ''}
                onChange={(e) => updateOrderField(orderIdx, 'order_number', e.target.value)}
                size="small"
                fullWidth
                disabled={readOnly || submitting}
              />
              <TextField
                label="PO Number"
                value={order.po_number ?? ''}
                onChange={(e) => updateOrderField(orderIdx, 'po_number', e.target.value)}
                size="small"
                fullWidth
                disabled={readOnly || submitting}
              />
              <TextField
                label="Customer Number"
                value={order.customer_number ?? ''}
                onChange={(e) => updateOrderField(orderIdx, 'customer_number', e.target.value)}
                size="small"
                fullWidth
                disabled={readOnly || submitting}
              />
              <TextField
                label="Customer Name"
                value={order.customer_name ?? ''}
                onChange={(e) => updateOrderField(orderIdx, 'customer_name', e.target.value)}
                size="small"
                fullWidth
                disabled={readOnly || submitting}
              />
            </Box>

            <Divider sx={{ mb: 1.5 }} />

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Line items ({order.items.length})
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>Product Name</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Product Code</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Lot Number</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: 100 }}>Qty</TableCell>
                    <TableCell sx={{ width: 80 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {order.items.map((it, itemIdx) => {
                    const itemLowConf = isLowConf(it._confidence);
                    return (
                      <TableRow key={itemIdx} sx={itemLowConf ? { bgcolor: 'warning.50' } : undefined}>
                        <TableCell>
                          <TextField
                            value={it.product_name ?? ''}
                            onChange={(e) => updateItemField(orderIdx, itemIdx, 'product_name', e.target.value)}
                            size="small"
                            variant="standard"
                            fullWidth
                            disabled={readOnly || submitting}
                            InputProps={{ disableUnderline: readOnly }}
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            value={it.product_code ?? ''}
                            onChange={(e) => updateItemField(orderIdx, itemIdx, 'product_code', e.target.value)}
                            size="small"
                            variant="standard"
                            fullWidth
                            disabled={readOnly || submitting}
                            InputProps={{ disableUnderline: readOnly }}
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            value={it.lot_number ?? ''}
                            onChange={(e) => updateItemField(orderIdx, itemIdx, 'lot_number', e.target.value)}
                            size="small"
                            variant="standard"
                            fullWidth
                            disabled={readOnly || submitting}
                            InputProps={{ disableUnderline: readOnly }}
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            value={it.quantity ?? ''}
                            onChange={(e) => updateItemField(orderIdx, itemIdx, 'quantity', e.target.value)}
                            size="small"
                            variant="standard"
                            type="number"
                            fullWidth
                            disabled={readOnly || submitting}
                            InputProps={{ disableUnderline: readOnly }}
                          />
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {itemLowConf && (
                              <Tooltip title="Low confidence line — would be staged for review." arrow>
                                <Chip label="!" size="small" color="warning" sx={{ minWidth: 28 }} />
                              </Tooltip>
                            )}
                            {!readOnly && (
                              <IconButton
                                size="small"
                                onClick={() => removeRow(orderIdx, itemIdx)}
                                disabled={submitting}
                                title="Remove line"
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            )}
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            {!readOnly && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => addRow(orderIdx)}
                disabled={submitting}
                sx={{ mt: 1 }}
              >
                Add Line
              </Button>
            )}
          </Paper>
        );
      })}

      {!readOnly && (
        <Button
          variant="contained"
          color="success"
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
          onClick={handleApprove}
          disabled={submitting || orders.length === 0}
        >
          Approve
        </Button>
      )}
    </Box>
  );
}
