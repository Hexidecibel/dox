import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  CircularProgress,
  Alert,
  Tooltip,
  Pagination,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';

const ITEMS_PER_PAGE = 20;

const DELIVERY_METHODS = ['email', 'portal', 'none'] as const;
type DeliveryMethod = typeof DELIVERY_METHODS[number];

interface Customer {
  id: string;
  customer_number: string;
  name: string;
  email: string | null;
  coa_delivery_method: DeliveryMethod;
  active: boolean;
  created_at: string;
  updated_at: string;
  tenant_id: string;
}

function deliveryMethodColor(method: DeliveryMethod): 'primary' | 'info' | 'default' {
  switch (method) {
    case 'email': return 'primary';
    case 'portal': return 'info';
    case 'none': return 'default';
  }
}

export function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formName, setFormName] = useState('');
  const [formCustomerNumber, setFormCustomerNumber] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formDeliveryMethod, setFormDeliveryMethod] = useState<DeliveryMethod>('email');
  const [saving, setSaving] = useState(false);

  const tenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : user?.tenant_id || undefined;

  const loadCustomers = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.customers.list({
        search: search || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: tenantId,
      }) as any;
      setCustomers(result.customers);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCustomers();
  }, [page, selectedTenantId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadCustomers();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const openCreate = () => {
    setEditingCustomer(null);
    setFormName('');
    setFormCustomerNumber('');
    setFormEmail('');
    setFormDeliveryMethod('email');
    setDialogOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormName(customer.name);
    setFormCustomerNumber(customer.customer_number);
    setFormEmail(customer.email || '');
    setFormDeliveryMethod(customer.coa_delivery_method);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const data = {
        name: formName.trim(),
        customer_number: formCustomerNumber.trim(),
        email: formEmail.trim() || undefined,
        coa_delivery_method: formDeliveryMethod,
      };

      if (editingCustomer) {
        await api.customers.update(editingCustomer.id, data);
      } else {
        const createTenantId = tenantId || user?.tenant_id;
        if (!createTenantId) {
          setError('No tenant selected. Please select a tenant before creating a customer.');
          setSaving(false);
          return;
        }
        await api.customers.create({ ...data, tenant_id: createTenantId });
      }
      setDialogOpen(false);
      loadCustomers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save customer');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (customer: Customer) => {
    if (!confirm(`Delete customer "${customer.name}"?`)) return;
    try {
      await api.customers.delete(customer.id);
      loadCustomers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete customer');
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  if (loading && customers.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Customers
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Customer
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        placeholder="Search by name or customer number..."
        fullWidth
        size="small"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 2 }}
      />

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {customers.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No customers found</Typography>
              </CardContent>
            </Card>
          ) : (
            customers.map((customer) => (
              <Card
                key={customer.id}
                variant="outlined"
                sx={{ cursor: 'pointer' }}
                onClick={() => navigate(`/admin/customers/${customer.id}`)}
              >
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {customer.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        #{customer.customer_number}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                      <IconButton size="small" onClick={() => openEdit(customer)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => handleDelete(customer)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
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
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Customer #</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>COA Delivery</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {customers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No customers found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                customers.map((customer) => (
                  <TableRow
                    key={customer.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/admin/customers/${customer.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} sx={{ fontFamily: 'monospace' }}>
                        {customer.customer_number}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} color="primary">
                        {customer.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {customer.email || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={customer.coa_delivery_method}
                        size="small"
                        color={deliveryMethodColor(customer.coa_delivery_method)}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={customer.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={customer.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(customer)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" onClick={() => handleDelete(customer)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
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

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingCustomer ? 'Edit Customer' : 'Add Customer'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Customer Number"
            fullWidth
            required
            value={formCustomerNumber}
            onChange={(e) => setFormCustomerNumber(e.target.value)}
            disabled={saving}
            autoFocus
            sx={{ mt: 1, mb: 2 }}
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
          <FormControl fullWidth>
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
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || !formCustomerNumber.trim() || saving}
          >
            {saving ? 'Saving...' : editingCustomer ? 'Save Changes' : 'Add Customer'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
