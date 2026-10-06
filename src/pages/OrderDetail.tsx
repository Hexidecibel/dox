import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import { formatDateTime } from '../utils/format';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Paper,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Collapse,
  useMediaQuery,
  useTheme,
  Link,
  Snackbar,
  Stack,
  TextField,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  History as HistoryIcon,
  PlaylistAdd as AddDocsIcon,
  Add as AddIcon,
  Send as SendIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { EmptyState } from '../components/EmptyState';
import { helpContent } from '../lib/helpContent';
import { useTenant } from '../contexts/TenantContext';
import { OrderLines, type OrderLineSuggestion } from '../components/orders/OrderLines';
import { AddDocumentsDialog } from '../components/orders/AddDocumentsDialog';
import { SendOrderDialog } from '../components/orders/SendOrderDialog';
import { OrderSendHistory } from '../components/orders/OrderSendHistory';
import type { ApiOrderItem, OrderSendSummary } from '../../shared/types';

const ORDER_STATUSES = ['pending', 'enriched', 'matched', 'fulfilled', 'delivered', 'error'] as const;

type OrderStatus = (typeof ORDER_STATUSES)[number];

const statusChipProps: Record<OrderStatus, { color: 'default' | 'info' | 'warning' | 'success' | 'error'; variant?: 'filled' | 'outlined' }> = {
  pending: { color: 'default' },
  enriched: { color: 'info' },
  matched: { color: 'warning' },
  fulfilled: { color: 'success' },
  delivered: { color: 'success', variant: 'outlined' },
  error: { color: 'error' },
};

interface Order {
  id: string;
  order_number: string;
  po_number: string | null;
  customer_name: string | null;
  customer_number: string | null;
  customer_id: string | null;
  status: OrderStatus;
  item_count: number;
  matched_count: number;
  connector_id: string | null;
  connector_run_id: string | null;
  connector_name: string | null;
  source_data: string | null;
  staged_at?: string | null;
  ship_date?: string | null;
  created_by?: string | null;
  created_by_name?: string | null;
  customer_email?: string | null;
  created_at: string;
  updated_at: string;
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { isAdmin, isSuperAdmin, isReader } = useAuth();
  const { selectedTenantId } = useTenant();

  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<ApiOrderItem[]>([]);
  // What has already left on this order, newest first (migration 0134).
  const [sends, setSends] = useState<OrderSendSummary[]>([]);
  // Pending lot-match suggestions, by order line. The matcher never links on
  // its own; a person confirms each one here.
  const [suggestions, setSuggestions] = useState<OrderLineSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Status change
  const [newStatus, setNewStatus] = useState('');
  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  // Delete
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Source data collapse
  const [sourceDataOpen, setSourceDataOpen] = useState(false);

  // Building the order by hand (migration 0134): pick certificates, type a
  // line, review and send.
  const [addDocsOpen, setAddDocsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineProduct, setLineProduct] = useState('');
  const [lineCode, setLineCode] = useState('');
  const [lineLotNumber, setLineLotNumber] = useState('');
  const [lineQuantity, setLineQuantity] = useState('');
  const [lineSaving, setLineSaving] = useState(false);
  const [lineError, setLineError] = useState('');
  const [notice, setNotice] = useState('');

  // `quiet` reloads in place: after a pick or a send the page must not blank
  // to a spinner and lose the person's place in the lines.
  const loadOrder = async (quiet = false) => {
    if (!id) return;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const result = await api.orders.get(id) as any;
      setOrder(result.order);
      setItems(result.items || []);
      setSuggestions(result.suggestions || []);
      setSends(result.sends || []);
      setNewStatus(result.order.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrder();
  }, [id]);

  const reload = () => {
    void loadOrder(true);
  };

  const handleAddLine = async () => {
    if (!id) return;
    setLineSaving(true);
    setLineError('');
    try {
      await api.orders.addItems(id, {
        item: {
          product_name: lineProduct.trim() || null,
          product_code: lineCode.trim() || null,
          lot_number: lineLotNumber.trim() || null,
          quantity: lineQuantity.trim() === '' ? null : Number(lineQuantity),
        },
      });
      setLineOpen(false);
      setLineProduct('');
      setLineCode('');
      setLineLotNumber('');
      setLineQuantity('');
      reload();
    } catch (err) {
      setLineError(err instanceof Error ? err.message : 'Could not add the line');
    } finally {
      setLineSaving(false);
    }
  };

  const handleStatusChange = async () => {
    if (!id || !newStatus || newStatus === order?.status) return;
    setStatusSaving(true);
    try {
      await api.orders.update(id, { status: newStatus });
      setStatusConfirmOpen(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setStatusSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api.orders.delete(id);
      navigate('/orders');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete order');
    } finally {
      setDeleting(false);
    }
  };

  const getStatusChip = (status: string) => {
    const props = statusChipProps[status as OrderStatus] || { color: 'default' as const };
    return (
      <Chip
        label={status}
        size="small"
        color={props.color}
        variant={props.variant || 'filled'}
        sx={{ textTransform: 'capitalize' }}
      />
    );
  };

  const formatSourceData = (raw: string | null): string => {
    if (!raw) return '';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !order) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/orders')} sx={{ mb: 2 }}>
          Back to Orders
        </Button>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!order) return null;

  // A staged order is still being reviewed for what the connector read; its
  // lines are edited there, not here.
  const canEdit = !isReader && !order.staged_at;
  const sendable = items.some((i) => i.coa_document_id && (i.coa_document_status ?? 'active') === 'active');

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: { xs: 1, sm: 2 }, mb: 3 }}>
        <IconButton onClick={() => navigate('/orders')} sx={{ mt: 0.5 }} size={isMobile ? 'small' : 'medium'}>
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant={isMobile ? 'h5' : 'h4'} fontWeight={700} sx={{ wordBreak: 'break-word' }}>
              Order {order.order_number}
            </Typography>
            {getStatusChip(order.status)}
            {order.connector_name && (
              <Chip label={order.connector_name} size="small" variant="outlined" color="info" />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Created {formatDateTime(order.created_at)} · Updated {formatDateTime(order.updated_at)}
          </Typography>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <HelpWell id="orders.detail" title={helpContent.orders.detail?.headline ?? 'Order detail'}>
        {helpContent.orders.detail?.well ?? helpContent.orders.well}
      </HelpWell>

      {/* Order Info */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          <Box sx={{ flex: '1 1 200px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                PO Number
              </Typography>
              <InfoTooltip text={helpContent.orders.list?.columnTooltips?.poNumber} />
            </Box>
            <Typography variant="body1">{order.po_number || '-'}</Typography>
          </Box>
          <Box sx={{ flex: '1 1 200px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Customer
              </Typography>
              <InfoTooltip text={helpContent.orders.list?.columnTooltips?.customer} />
            </Box>
            {order.customer_id ? (
              <Link component={RouterLink} to={`/customers/${order.customer_id}`} underline="hover">
                {order.customer_name || order.customer_number || order.customer_id}
              </Link>
            ) : (
              <Typography variant="body1">
                {order.customer_name || order.customer_number || '-'}
              </Typography>
            )}
          </Box>
          {order.customer_number && order.customer_name && (
            <Box sx={{ flex: '1 1 200px' }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Customer #
              </Typography>
              <Typography variant="body1">{order.customer_number}</Typography>
            </Box>
          )}
          <Box sx={{ flex: '1 1 200px' }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Ship date
            </Typography>
            <Typography variant="body1">{order.ship_date || '-'}</Typography>
          </Box>
          <Box sx={{ flex: '1 1 200px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Source
              </Typography>
              <InfoTooltip text={helpContent.orders.list?.columnTooltips?.source} />
            </Box>
            <Typography variant="body1">
              {order.connector_name || (order.created_by ? `Built by ${order.created_by_name ?? 'a former user'}` : 'Manual')}
            </Typography>
          </Box>
        </Box>
      </Paper>

      {/* Source / Connector run back-link */}
      {(order.connector_run_id || order.connector_id) && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3, bgcolor: 'action.hover' }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Source
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Created by{' '}
            {order.connector_name && (
              <strong>{order.connector_name}</strong>
            )}
            {' '}on {formatDateTime(order.created_at)}
          </Typography>
          {(() => {
            if (!order.source_data) return null;
            try {
              const parsed = typeof order.source_data === 'string' ? JSON.parse(order.source_data) : order.source_data;
              const sender = parsed?._email_sender || parsed?.sender || parsed?.from;
              const subject = parsed?._email_subject || parsed?.subject;
              if (!sender && !subject) return null;
              return (
                <Typography variant="body2" color="text.secondary">
                  {sender && <>From <strong>{sender}</strong></>}
                  {sender && subject && ' — '}
                  {subject && <em>{subject}</em>}
                </Typography>
              );
            } catch {
              return null;
            }
          })()}
          <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
            {order.connector_run_id && order.connector_id && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<HistoryIcon />}
                component={RouterLink}
                to={`/activity?connector_id=${order.connector_id}`}
              >
                View the run
              </Button>
            )}
            {order.connector_id && (
              <Button
                size="small"
                variant="outlined"
                component={RouterLink}
                to={`/admin/sources/${order.connector_id}`}
              >
                View connector
              </Button>
            )}
          </Box>
        </Paper>
      )}

      {/* Status Change + Delete */}
      <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Change Status</InputLabel>
          <Select
            value={newStatus}
            onChange={(e) => {
              setNewStatus(e.target.value);
              if (e.target.value !== order.status) {
                setStatusConfirmOpen(true);
              }
            }}
            label="Change Status"
          >
            {ORDER_STATUSES.map((s) => (
              <MenuItem key={s} value={s} sx={{ textTransform: 'capitalize' }}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Box sx={{ flex: 1 }} />

        {(isAdmin || isSuperAdmin) && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            Delete Order
          </Button>
        )}
      </Box>

      {/* Lines */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" fontWeight={600} sx={{ flex: '1 1 auto' }}>
          Lines ({items.length})
        </Typography>
        {canEdit && (
          <>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => { setLineError(''); setLineOpen(true); }}
              sx={{ textTransform: 'none' }}
              data-testid="order-add-line"
            >
              Add a line
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddDocsIcon />}
              onClick={() => setAddDocsOpen(true)}
              sx={{ textTransform: 'none' }}
              data-testid="order-add-coas"
            >
              Add COAs
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<SendIcon />}
              onClick={() => setSendOpen(true)}
              disabled={!sendable}
              sx={{ textTransform: 'none' }}
              data-testid="order-review-send"
            >
              Review and send
            </Button>
          </>
        )}
      </Box>

      {items.length === 0 ? (
        <Box sx={{ mb: 3 }}>
          <EmptyState
            title="No lines on this order yet"
            description={
              order.connector_id
                ? 'The connector ingested the order header but no line items came through. Check the source data below for the raw payload, or open the connector run to see how the parser handled this file.'
                : 'Add the certificates this order needs with Add COAs: each one becomes a line for every lot it certifies. Or add a line by hand and attach its certificate later.'
            }
          />
        </Box>
      ) : (
        <OrderLines
          orderId={order.id}
          items={items}
          suggestions={suggestions}
          canEdit={canEdit}
          compact={isMobile}
          onChanged={reload}
          onOpenDocument={(docId) => navigate(`/documents/${docId}`)}
        />
      )}

      {/* What has already left */}
      {sends.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            Sent ({sends.length})
          </Typography>
          <OrderSendHistory sends={sends} onChanged={reload} />
        </Box>
      )}

      {/* Source Data */}
      {order.source_data && (
        <Box sx={{ mb: 3 }}>
          <Button
            size="small"
            onClick={() => setSourceDataOpen(!sourceDataOpen)}
            endIcon={sourceDataOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            sx={{ mb: 0.5, textTransform: 'none', color: 'text.secondary', px: 0, minWidth: 0 }}
          >
            <Typography variant="subtitle2" color="text.secondary">
              Source Data
            </Typography>
          </Button>
          <Collapse in={sourceDataOpen}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography
                component="pre"
                variant="body2"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  m: 0,
                }}
              >
                {formatSourceData(order.source_data)}
              </Typography>
            </Paper>
          </Collapse>
        </Box>
      )}

      <AddDocumentsDialog
        open={addDocsOpen}
        orderId={order.id}
        orderNumber={order.order_number}
        tenantId={selectedTenantId || undefined}
        onClose={() => setAddDocsOpen(false)}
        onAdded={reload}
      />

      <SendOrderDialog
        open={sendOpen}
        orderId={order.id}
        onClose={() => setSendOpen(false)}
        onFailed={reload}
        onSent={(result) => {
          setSendOpen(false);
          setNotice(
            result.sent
              ? `Sent to ${result.send.recipients.join(', ')}.`
              : 'Some of the emails did not go. See Sent below to resend them.',
          );
          reload();
        }}
      />

      {/* A line typed by hand */}
      <Dialog open={lineOpen} onClose={() => !lineSaving && setLineOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add a line</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {lineError && <Alert severity="error">{lineError}</Alert>}
            <Typography variant="body2" color="text.secondary">
              For a product whose certificate is not on the order yet. A lot number is checked against the
              certificates on file, and any that fit are offered on the line for you to confirm.
            </Typography>
            <TextField label="Product" value={lineProduct} onChange={(e) => setLineProduct(e.target.value)} fullWidth size="small" autoFocus inputProps={{ 'data-testid': 'line-product' }} />
            <TextField label="Product code" value={lineCode} onChange={(e) => setLineCode(e.target.value)} fullWidth size="small" />
            <TextField label="Lot number" value={lineLotNumber} onChange={(e) => setLineLotNumber(e.target.value)} fullWidth size="small" inputProps={{ 'data-testid': 'line-lot' }} />
            <TextField label="Quantity" type="number" value={lineQuantity} onChange={(e) => setLineQuantity(e.target.value)} fullWidth size="small" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLineOpen(false)} disabled={lineSaving} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleAddLine}
            disabled={lineSaving || (!lineProduct.trim() && !lineCode.trim() && !lineLotNumber.trim())}
            sx={{ textTransform: 'none' }}
            data-testid="line-save"
          >
            {lineSaving ? 'Adding…' : 'Add line'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!notice}
        autoHideDuration={6000}
        onClose={() => setNotice('')}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />

      {/* Status Change Confirmation */}
      <Dialog open={statusConfirmOpen} onClose={() => { setStatusConfirmOpen(false); setNewStatus(order.status); }}>
        <DialogTitle>Change Order Status</DialogTitle>
        <DialogContent>
          <Typography>
            Change status from <strong>{order.status}</strong> to <strong>{newStatus}</strong>?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setStatusConfirmOpen(false); setNewStatus(order.status); }} disabled={statusSaving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleStatusChange} disabled={statusSaving}>
            {statusSaving ? 'Updating...' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)}>
        <DialogTitle>Delete Order</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete order <strong>{order.order_number}</strong>? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
