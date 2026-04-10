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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Collapse,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  Link,
  Tooltip,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Check as CheckIcon,
  Remove as DashIcon,
  Description as DocIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

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

interface OrderItem {
  id: string;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  lot_matched: boolean;
  coa_document_id: string | null;
  coa_document_title: string | null;
}

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
  connector_name: string | null;
  source_data: string | null;
  created_at: string;
  updated_at: string;
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { isAdmin, isSuperAdmin } = useAuth();

  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
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

  const loadOrder = async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.orders.get(id) as any;
      setOrder(result.order);
      setItems(result.items || []);
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

  const handleStatusChange = async () => {
    if (!id || !newStatus || newStatus === order?.status) return;
    setStatusSaving(true);
    try {
      await api.orders.update(id, { status: newStatus });
      setStatusConfirmOpen(false);
      loadOrder();
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

      {/* Order Info */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          <Box sx={{ flex: '1 1 200px' }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              PO Number
            </Typography>
            <Typography variant="body1">{order.po_number || '-'}</Typography>
          </Box>
          <Box sx={{ flex: '1 1 200px' }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Customer
            </Typography>
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
              Source
            </Typography>
            <Typography variant="body1">{order.connector_name || 'Manual'}</Typography>
          </Box>
        </Box>
      </Paper>

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

      {/* Items Table */}
      <Typography variant="h6" fontWeight={600} gutterBottom>
        Items ({items.length})
      </Typography>

      {items.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', mb: 3 }}>
          <Typography color="text.secondary">No items in this order.</Typography>
        </Paper>
      ) : isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 3 }}>
          {items.map((item) => (
            <Card key={item.id} variant="outlined">
              <CardContent sx={{ pb: '12px !important' }}>
                <Typography variant="subtitle2" fontWeight={600}>
                  {item.product_name || item.product_code || 'Unknown Product'}
                </Typography>
                {item.product_code && item.product_name && (
                  <Typography variant="caption" color="text.secondary">
                    {item.product_code}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
                  {item.quantity != null && (
                    <Typography variant="body2">Qty: {item.quantity}</Typography>
                  )}
                  {item.lot_number && (
                    <Typography variant="body2">Lot: {item.lot_number}</Typography>
                  )}
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {item.lot_matched ? (
                      <Chip label="Matched" size="small" color="success" icon={<CheckIcon />} />
                    ) : (
                      <Chip label="Unmatched" size="small" variant="outlined" />
                    )}
                  </Box>
                  {item.coa_document_id && (
                    <Button
                      size="small"
                      startIcon={<DocIcon />}
                      onClick={() => navigate(`/documents/${item.coa_document_id}`)}
                    >
                      {item.coa_document_title || 'COA'}
                    </Button>
                  )}
                </Box>
              </CardContent>
            </Card>
          ))}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell>Code</TableCell>
                <TableCell align="right">Quantity</TableCell>
                <TableCell>Lot #</TableCell>
                <TableCell align="center">Matched</TableCell>
                <TableCell>COA Document</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.product_name || '-'}</TableCell>
                  <TableCell>{item.product_code || '-'}</TableCell>
                  <TableCell align="right">{item.quantity != null ? item.quantity : '-'}</TableCell>
                  <TableCell>{item.lot_number || '-'}</TableCell>
                  <TableCell align="center">
                    {item.lot_matched ? (
                      <Tooltip title="Lot matched">
                        <CheckIcon color="success" fontSize="small" />
                      </Tooltip>
                    ) : (
                      <DashIcon color="disabled" fontSize="small" />
                    )}
                  </TableCell>
                  <TableCell>
                    {item.coa_document_id ? (
                      <Button
                        size="small"
                        startIcon={<DocIcon />}
                        onClick={() => navigate(`/documents/${item.coa_document_id}`)}
                        sx={{ textTransform: 'none' }}
                      >
                        {item.coa_document_title || 'View COA'}
                      </Button>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
