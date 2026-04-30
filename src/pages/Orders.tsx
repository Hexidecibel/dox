import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate } from '../utils/format';
import {
  Box,
  Typography,
  TextField,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Pagination,
  Card,
  CardContent,
  CardActionArea,
  InputAdornment,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { Search as SearchIcon, Add as AddIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';


const ITEMS_PER_PAGE = 50;

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
  connector_name: string | null;
  created_at: string;
  updated_at: string;
}

export function Orders() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { selectedTenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();
  // URL-driven filter — set by deep links from the connector detail page so
  // a partner can jump from a successful run row to "the orders this run
  // created" without learning the orders search box.
  const connectorIdFilter = searchParams.get('connector_id') || '';
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createOrderNumber, setCreateOrderNumber] = useState('');
  const [createPoNumber, setCreatePoNumber] = useState('');
  const [createCustomerName, setCreateCustomerName] = useState('');
  const [createCustomerNumber, setCreateCustomerNumber] = useState('');
  const [creating, setCreating] = useState(false);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.orders.list({
        tenant_id: selectedTenantId || undefined,
        status: statusFilter || undefined,
        connector_id: connectorIdFilter || undefined,
        search: search.trim() || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
      }) as any;
      setOrders(result.orders);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [selectedTenantId, statusFilter, connectorIdFilter, search, page]);

  const clearConnectorFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('connector_id');
    setSearchParams(next);
    setPage(1);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setPage(1);
      loadOrders();
    }
  };

  const handleCreate = async () => {
    if (!createOrderNumber.trim()) return;
    setCreating(true);
    try {
      await api.orders.create({
        order_number: createOrderNumber.trim(),
        po_number: createPoNumber.trim() || undefined,
        customer_name: createCustomerName.trim() || undefined,
        customer_number: createCustomerNumber.trim() || undefined,
        tenant_id: selectedTenantId || undefined,
      });
      setCreateOpen(false);
      setCreateOrderNumber('');
      setCreatePoNumber('');
      setCreateCustomerName('');
      setCreateCustomerNumber('');
      loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

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

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="h4" fontWeight={700}>
            Orders
          </Typography>
          {!loading && (
            <Typography variant="body2" color="text.secondary">
              ({total})
            </Typography>
          )}
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
        >
          New Order
        </Button>
      </Box>

      {/* Filters */}
      <Box sx={{ mb: 3, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search order #, customer, PO..."
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          sx={{ flex: '1 1 250px' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Status</InputLabel>
          <Select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            label="Status"
          >
            <MenuItem value="">All</MenuItem>
            {ORDER_STATUSES.map((s) => (
              <MenuItem key={s} value={s} sx={{ textTransform: 'capitalize' }}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {connectorIdFilter && (
          <Chip
            label="Filtered by connector"
            size="small"
            color="primary"
            variant="outlined"
            onDelete={clearConnectorFilter}
          />
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : orders.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No orders found
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {search || statusFilter ? 'Try adjusting your filters.' : 'Create your first order to get started.'}
          </Typography>
        </Box>
      ) : isMobile ? (
        /* Mobile: card view */
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {orders.map((order) => (
            <Card key={order.id} variant="outlined">
              <CardActionArea onClick={() => navigate(`/orders/${order.id}`)}>
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      {order.order_number}
                    </Typography>
                    {getStatusChip(order.status)}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {order.customer_name || order.customer_number || 'No customer'}
                  </Typography>
                  {order.po_number && (
                    <Typography variant="body2" color="text.secondary">
                      PO: {order.po_number}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {order.matched_count}/{order.item_count} matched
                    </Typography>
                    {order.connector_name && (
                      <Chip label={order.connector_name} size="small" variant="outlined" />
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(order.created_at)}
                    </Typography>
                  </Box>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Box>
      ) : (
        /* Desktop: table view */
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Order #</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>PO #</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Items</TableCell>
                <TableCell align="center">Matched</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map((order) => (
                <TableRow
                  key={order.id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/orders/${order.id}`)}
                >
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {order.order_number}
                    </Typography>
                  </TableCell>
                  <TableCell>{order.customer_name || order.customer_number || '-'}</TableCell>
                  <TableCell>{order.po_number || '-'}</TableCell>
                  <TableCell>{getStatusChip(order.status)}</TableCell>
                  <TableCell align="center">{order.item_count}</TableCell>
                  <TableCell align="center">{order.matched_count}</TableCell>
                  <TableCell>
                    {order.connector_name ? (
                      <Chip label={order.connector_name} size="small" variant="outlined" />
                    ) : '-'}
                  </TableCell>
                  <TableCell>{formatDate(order.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {totalPages > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, p) => setPage(p)}
            color="primary"
          />
        </Box>
      )}

      {/* Create Order Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle>New Order</DialogTitle>
        <DialogContent>
          <TextField
            label="Order Number"
            fullWidth
            required
            value={createOrderNumber}
            onChange={(e) => setCreateOrderNumber(e.target.value)}
            disabled={creating}
            sx={{ mt: 1, mb: 2 }}
            autoFocus
          />
          <TextField
            label="PO Number"
            fullWidth
            value={createPoNumber}
            onChange={(e) => setCreatePoNumber(e.target.value)}
            disabled={creating}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Customer Name"
            fullWidth
            value={createCustomerName}
            onChange={(e) => setCreateCustomerName(e.target.value)}
            disabled={creating}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Customer Number"
            fullWidth
            value={createCustomerNumber}
            onChange={(e) => setCreateCustomerNumber(e.target.value)}
            disabled={creating}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={creating || !createOrderNumber.trim()}
          >
            {creating ? 'Creating...' : 'Create Order'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
