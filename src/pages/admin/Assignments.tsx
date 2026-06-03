import { useState, useEffect, useCallback } from 'react';
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
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  CircularProgress,
  Alert,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { Assignment, User, ApiDocumentType } from '../../lib/types';
import SupplierAutocomplete, { type SupplierValue } from '../../components/SupplierAutocomplete';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { EmptyState } from '../../components/EmptyState';

/**
 * Assignments — ownership of (supplier × document_type) review combos.
 * One owner per combo. Owner is a tenant user today; a "Groups — coming soon"
 * affordance reserves the forward-compatible owner_group_id slot.
 */
export function Assignments() {
  const { isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  // super_admin scopes to the selected tenant; everyone else to their own
  // (which TenantContext locks selectedTenantId to). Either way: this value.
  const effectiveTenantId = selectedTenantId || undefined;

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Assign dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [supplier, setSupplier] = useState<SupplierValue>({ supplierName: '', verified: false });
  const [docTypes, setDocTypes] = useState<ApiDocumentType[]>([]);
  const [docTypesLoading, setDocTypesLoading] = useState(false);
  const [docTypeId, setDocTypeId] = useState('');
  const [ownerKind, setOwnerKind] = useState<'user' | 'group'>('user');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [assignRes, userList] = await Promise.all([
        api.assignments.list({ tenant_id: effectiveTenantId }),
        api.users.list(),
      ]);
      setAssignments(assignRes.assignments || []);
      // Owner picker only offers tenant users (drop globals/super_admins with
      // no tenant). super_admin scoped to a tenant filters to that tenant.
      setUsers(
        userList.filter((u) =>
          effectiveTenantId ? u.tenant_id === effectiveTenantId : !!u.tenant_id,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, [effectiveTenantId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Supplier-scoped doctypes: refetch whenever the dialog's chosen supplier
  // (an existing one with an id) changes. Reset the selected doctype.
  useEffect(() => {
    if (!dialogOpen) return;
    const supplierId = supplier.supplierId;
    if (!supplierId) {
      setDocTypes([]);
      setDocTypeId('');
      return;
    }
    let cancelled = false;
    setDocTypesLoading(true);
    api.documentTypes
      .list({ supplier_id: supplierId, tenant_id: effectiveTenantId, active: 1 })
      .then((res) => {
        if (cancelled) return;
        setDocTypes(res.documentTypes || []);
      })
      .catch(() => {
        if (!cancelled) setDocTypes([]);
      })
      .finally(() => {
        if (!cancelled) setDocTypesLoading(false);
      });
    setDocTypeId('');
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, supplier.supplierId, effectiveTenantId]);

  const openAssign = () => {
    setSupplier({ supplierName: '', verified: false });
    setDocTypes([]);
    setDocTypeId('');
    setOwnerKind('user');
    setOwnerUserId('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!supplier.supplierId || !docTypeId) return;
    setSaving(true);
    setError('');
    try {
      await api.assignments.set({
        supplier_id: supplier.supplierId,
        document_type_id: docTypeId,
        owner_user_id: ownerUserId || null,
        tenant_id: effectiveTenantId,
      });
      setDialogOpen(false);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save assignment');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (a: Assignment) => {
    setError('');
    try {
      await api.assignments.remove(a.id, effectiveTenantId);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove assignment');
    }
  };

  const ownerLabel = (a: Assignment): string => {
    if (a.owner_user_name) return a.owner_user_name;
    if (a.owner_user_email) return a.owner_user_email;
    if (a.owner_group_id) return 'Group';
    return 'Unassigned';
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            Assignments
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Route review of a supplier&apos;s document type to an owner. One owner per supplier × document type.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAssign}>
          Assign
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isSuperAdmin && !effectiveTenantId && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Select a tenant from the top bar to scope assignments.
        </Alert>
      )}

      {assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          description="Assign a supplier's document type to an owner so its review items route to them."
          actionLabel="Assign"
          onAction={openAssign}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Supplier</TableCell>
                <TableCell>Document Type</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {assignments.map((a) => (
                <TableRow key={a.id} hover>
                  <TableCell>{a.supplier_name || a.supplier_id}</TableCell>
                  <TableCell>{a.document_type_name || a.document_type_id}</TableCell>
                  <TableCell>{ownerLabel(a)}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Remove assignment">
                      <IconButton size="small" onClick={() => handleRemove(a)}>
                        <DeleteIcon fontSize="small" color="error" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Assign dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Assign Owner
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, mb: 0.5 }}>
            Supplier
          </Typography>
          <SupplierAutocomplete
            tenantId={effectiveTenantId || ''}
            value={supplier}
            onChange={setSupplier}
            disabled={saving}
            showStatus={false}
          />

          <FormControl fullWidth sx={{ mt: 2 }} disabled={!supplier.supplierId || saving}>
            <InputLabel>Document Type</InputLabel>
            <Select
              value={docTypeId}
              onChange={(e) => setDocTypeId(e.target.value)}
              label="Document Type"
            >
              {docTypesLoading ? (
                <MenuItem value="" disabled>
                  Loading…
                </MenuItem>
              ) : docTypes.length === 0 ? (
                <MenuItem value="" disabled>
                  {supplier.supplierId ? 'No document types for this supplier' : 'Select a supplier first'}
                </MenuItem>
              ) : (
                docTypes.map((dt) => (
                  <MenuItem key={dt.id} value={dt.id}>
                    {dt.name}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, mb: 0.5 }}>
            Owner
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={ownerKind}
            onChange={(_e, v) => v && setOwnerKind(v)}
            sx={{ mb: 1.5 }}
          >
            <ToggleButton value="user">User</ToggleButton>
            <Tooltip title="Group ownership is coming soon">
              <span>
                <ToggleButton value="group" disabled>
                  Groups — coming soon
                </ToggleButton>
              </span>
            </Tooltip>
          </ToggleButtonGroup>

          <FormControl fullWidth disabled={ownerKind !== 'user' || saving}>
            <InputLabel>User</InputLabel>
            <Select
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              label="User"
            >
              <MenuItem value="">Unassigned</MenuItem>
              {users.map((u) => (
                <MenuItem key={u.id} value={u.id}>
                  {u.name} ({u.email})
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
            disabled={!supplier.supplierId || !docTypeId || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
