import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../../utils/format';
import {
  Box,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
  CircularProgress,
  Alert,
  Tooltip,
  Tab,
  Tabs,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Pagination,
} from '@mui/material';
import {
  Edit as EditIcon,
  ArrowBack as BackIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';

const DELIVERY_METHODS = ['email', 'portal', 'none'] as const;
type DeliveryMethod = typeof DELIVERY_METHODS[number];

interface Customer {
  id: string;
  customer_number: string;
  name: string;
  email: string | null;
  coa_delivery_method: DeliveryMethod;
  coa_requirements: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  tenant_id: string;
}

interface Order {
  id: string;
  order_number: string;
  po_number: string | null;
  status: string;
  created_at: string;
  customer_id: string;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ pt: 2 }}>
      {value === index && children}
    </Box>
  );
}

function orderStatusColor(status: string): 'info' | 'warning' | 'success' | 'error' | 'default' {
  switch (status) {
    case 'pending': return 'warning';
    case 'processing': return 'info';
    case 'complete': return 'success';
    case 'cancelled': return 'error';
    default: return 'default';
  }
}

function deliveryMethodColor(method: DeliveryMethod): 'primary' | 'info' | 'default' {
  switch (method) {
    case 'email': return 'primary';
    case 'portal': return 'info';
    case 'none': return 'default';
  }
}

const ORDERS_PER_PAGE = 20;

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(0);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [formName, setFormName] = useState('');
  const [formCustomerNumber, setFormCustomerNumber] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formDeliveryMethod, setFormDeliveryMethod] = useState<DeliveryMethod>('email');
  const [formRequirements, setFormRequirements] = useState('');
  const [saving, setSaving] = useState(false);

  // Orders state
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const loadCustomer = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.customers.get(id) as any;
      const c = result.customer;
      setCustomer(c);
      setFormName(c.name);
      setFormCustomerNumber(c.customer_number);
      setFormEmail(c.email || '');
      setFormDeliveryMethod(c.coa_delivery_method);
      setFormRequirements(c.coa_requirements || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadOrders = useCallback(async () => {
    if (!id) return;
    setOrdersLoading(true);
    try {
      const result = await api.orders.list({
        customer_id: id,
        limit: ORDERS_PER_PAGE,
        offset: (ordersPage - 1) * ORDERS_PER_PAGE,
      }) as any;
      setOrders(result.orders);
      setOrdersTotal(result.total);
    } catch {
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, [id, ordersPage]);

  useEffect(() => {
    loadCustomer();
  }, [loadCustomer]);

  useEffect(() => {
    if (tab === 1) loadOrders();
  }, [tab, loadOrders]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.customers.update(id, {
        name: formName.trim(),
        customer_number: formCustomerNumber.trim(),
        email: formEmail.trim() || undefined,
        coa_delivery_method: formDeliveryMethod,
        coa_requirements: formRequirements.trim() || undefined,
      }) as any;
      setCustomer(result.customer);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update customer');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!confirm('Are you sure you want to delete this customer?')) return;
    try {
      await api.customers.delete(id);
      navigate('/admin/customers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete customer');
    }
  };

  const ordersTotalPages = Math.ceil(ordersTotal / ORDERS_PER_PAGE);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!customer) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">Customer not found</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/admin/customers')} sx={{ mt: 2 }}>
          Back to Customers
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Back button */}
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/customers')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Customers
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Header */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
              <Typography variant="h4" fontWeight={700}>
                {customer.name}
              </Typography>
              <Chip
                label={customer.coa_delivery_method}
                size="small"
                color={deliveryMethodColor(customer.coa_delivery_method)}
                variant="outlined"
              />
              <Chip
                label={customer.active ? 'Active' : 'Inactive'}
                size="small"
                color={customer.active ? 'success' : 'default'}
                variant="outlined"
              />
            </Box>
            <Typography variant="body2" color="text.secondary">
              Customer #{customer.customer_number}
              {customer.email && <> &middot; {customer.email}</>}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Tooltip title="Edit">
              <IconButton onClick={() => setEditing(true)}>
                <EditIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton color="error" onClick={handleDelete}>
                <DeleteIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Info" />
          <Tab label={`Orders${ordersTotal ? ` (${ordersTotal})` : ''}`} />
        </Tabs>
      </Box>

      {/* Info Tab */}
      <TabPanel value={tab} index={0}>
        {editing ? (
          <Box>
            <TextField
              label="Customer Number"
              fullWidth
              required
              value={formCustomerNumber}
              onChange={(e) => setFormCustomerNumber(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Name"
              fullWidth
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Email"
              fullWidth
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
            />
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>COA Delivery Method</InputLabel>
              <Select
                value={formDeliveryMethod}
                label="COA Delivery Method"
                onChange={(e) => setFormDeliveryMethod(e.target.value as DeliveryMethod)}
                disabled={saving}
              >
                {DELIVERY_METHODS.map((method) => (
                  <MenuItem key={method} value={method}>
                    {method.charAt(0).toUpperCase() + method.slice(1)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="COA Requirements"
              fullWidth
              multiline
              rows={3}
              value={formRequirements}
              onChange={(e) => setFormRequirements(e.target.value)}
              disabled={saving}
              helperText="Special requirements for COA delivery"
              sx={{ mb: 2 }}
            />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={!formName.trim() || !formCustomerNumber.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setEditing(false);
                  setFormName(customer.name);
                  setFormCustomerNumber(customer.customer_number);
                  setFormEmail(customer.email || '');
                  setFormDeliveryMethod(customer.coa_delivery_method);
                  setFormRequirements(customer.coa_requirements || '');
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<EditIcon />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Box>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Customer Number
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: 'monospace' }}>
                {customer.customer_number}
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Email
              </Typography>
              <Typography variant="body1">
                {customer.email || 'Not set'}
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                COA Delivery Method
              </Typography>
              <Chip
                label={customer.coa_delivery_method}
                size="small"
                color={deliveryMethodColor(customer.coa_delivery_method)}
                variant="outlined"
              />
            </Paper>

            {customer.coa_requirements && (
              <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  COA Requirements
                </Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {customer.coa_requirements}
                </Typography>
              </Paper>
            )}

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Created
              </Typography>
              <Typography variant="body2">
                {formatDate(customer.created_at)}
              </Typography>
            </Paper>
          </Box>
        )}
      </TabPanel>

      {/* Orders Tab */}
      <TabPanel value={tab} index={1}>
        {ordersLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : orders.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">No orders found for this customer</Typography>
          </Paper>
        ) : (
          <>
            <TableContainer component={Paper} variant="outlined">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Order #</TableCell>
                    <TableCell>PO #</TableCell>
                    <TableCell>Status</TableCell>
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
                        <Typography variant="body2" fontWeight={500} color="primary">
                          {order.order_number}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {order.po_number || '-'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={order.status}
                          size="small"
                          color={orderStatusColor(order.status)}
                          variant="filled"
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {formatDate(order.created_at)}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            {ordersTotalPages > 1 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
                <Pagination
                  count={ordersTotalPages}
                  page={ordersPage}
                  onChange={(_, p) => setOrdersPage(p)}
                  color="primary"
                />
              </Box>
            )}
          </>
        )}
      </TabPanel>
    </Box>
  );
}
