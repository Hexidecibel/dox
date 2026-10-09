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
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { EmptyState } from '../components/EmptyState';
import { helpContent } from '../lib/helpContent';
import { NewOrderDialog } from '../components/orders/NewOrderDialog';


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

  // Create dialog. Offered to every login since migration 0138: a read-only
  // account opens an order to build a document order on it.
  const [createOpen, setCreateOpen] = useState(false);

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
        {/* Any login opens an order (migration 0138): a read-only account
            builds a document order, and somebody else sends it. */}
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
          data-testid="orders-new"
        >
          New Order
        </Button>
      </Box>

      <HelpWell id="orders.list" title={helpContent.orders.list?.headline ?? 'Orders'}>
        {helpContent.orders.list?.well ?? helpContent.orders.well}
      </HelpWell>

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
        search || statusFilter || connectorIdFilter ? (
          <EmptyState
            title="No orders match your filters"
            description="Clear the search box or status filter to see every order. Filters narrow to a single slice; remove them to widen the view."
          />
        ) : (
          <EmptyState
            title={helpContent.orders.list?.emptyTitle ?? 'No orders yet'}
            description={helpContent.orders.list?.emptyDescription}
            actionLabel="New order"
            onAction={() => setCreateOpen(true)}
          />
        )
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
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Order #
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.orderNumber} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Customer
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.customer} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    PO #
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.poNumber} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell align="center">
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Items
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.items} />
                  </Box>
                </TableCell>
                <TableCell align="center">
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Matched
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.matched} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Source
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.source} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created
                    <InfoTooltip text={helpContent.orders.list?.columnTooltips?.created} />
                  </Box>
                </TableCell>
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

      {/* New order: the customer, PO and ship date; the lines are added on the order itself. */}
      <NewOrderDialog
        open={createOpen}
        tenantId={selectedTenantId || undefined}
        fullScreen={isMobile}
        onClose={() => setCreateOpen(false)}
        onCreated={(order) => {
          setCreateOpen(false);
          navigate(`/orders/${order.id}`);
        }}
      />
    </Box>
  );
}
