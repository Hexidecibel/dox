/**
 * Customer > COA requirements by item (migration 0135, decision C-004).
 *
 * One row per item this customer buys: whether a COA is required (yes, no, on
 * request), what it must show, when, and which contact it goes to. Thin on
 * purpose -- more columns arrive with the client's own list.
 *
 * A requirement decides nothing. It is printed beside the item when an order
 * is reviewed before sending, and a required item with no certificate on the
 * order gets a warning there. The send is never stopped by it.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import { CUSTOMER_COA_REQUIRED_LABELS, CUSTOMER_COA_REQUIRED_VALUES } from '../../shared/itemApproval';
import type {
  CustomerCoaRequired,
  CustomerContact,
  CustomerItemRequirement,
  CustomerItemRequirementsResponse,
} from '../../shared/types';

interface Props {
  customerId: string;
  customerName: string;
  tenantId: string;
  canEdit: boolean;
}

interface ProductOption {
  id: string;
  name: string;
}

interface Draft {
  id: string | null;
  product: ProductOption | null;
  coaRequired: CustomerCoaRequired;
  mustShow: string;
  timing: string;
  deliveryContactId: string;
  notes: string;
}

const CHIP_COLOR: Record<CustomerCoaRequired, 'primary' | 'default' | 'info'> = {
  yes: 'primary',
  no: 'default',
  on_request: 'info',
};

export default function CustomerItemRequirementsPanel({ customerId, customerName, tenantId, canEdit }: Props) {
  const [data, setData] = useState<CustomerItemRequirementsResponse | null>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.customers.itemRequirements.list(customerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requirements');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // What the dialog picks from. Read once it is first opened, not on every
  // visit to the tab.
  const loadChoices = useCallback(async () => {
    try {
      const [contactRes, productRes] = await Promise.all([
        api.customers.contacts.list(customerId),
        api.products.list({ tenant_id: tenantId, limit: 200 }),
      ]);
      setContacts(contactRes.contacts);
      setProducts(productRes.products.map((p) => ({ id: p.id, name: p.name })));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not load items and contacts');
    }
  }, [customerId, tenantId]);

  const requirements = data?.requirements ?? [];
  const taken = new Set(requirements.map((r) => r.product_id));

  const openAdd = () => {
    setDialogError('');
    setDraft({ id: null, product: null, coaRequired: 'yes', mustShow: '', timing: '', deliveryContactId: '', notes: '' });
    void loadChoices();
  };

  const openEdit = (r: CustomerItemRequirement) => {
    setDialogError('');
    setDraft({
      id: r.id,
      product: { id: r.product_id, name: r.product_name },
      coaRequired: r.coa_required,
      mustShow: r.must_show ?? '',
      timing: r.timing ?? '',
      deliveryContactId: r.delivery_contact_id ?? '',
      notes: r.notes ?? '',
    });
    void loadChoices();
  };

  const save = async () => {
    if (!draft || !draft.product) return;
    setSaving(true);
    setDialogError('');
    try {
      const body = {
        coa_required: draft.coaRequired,
        must_show: draft.mustShow.trim() || null,
        timing: draft.timing.trim() || null,
        delivery_contact_id: draft.deliveryContactId || null,
        notes: draft.notes.trim() || null,
      };
      const next = draft.id
        ? await api.customers.itemRequirements.update(customerId, draft.id, body)
        : await api.customers.itemRequirements.create(customerId, { ...body, product_id: draft.product.id });
      setData(next);
      setDraft(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save requirement');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: CustomerItemRequirement) => {
    if (!window.confirm(`Remove the COA requirement for ${r.product_name}?`)) return;
    try {
      setData(await api.customers.itemRequirements.remove(customerId, r.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove requirement');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">COA requirements by item</Typography>
          <Typography variant="body2" color="text.secondary">
            What {customerName} needs for each item. Shown beside the item when an order is reviewed
            before sending; a required item with no certificate on the order gets a warning there.
            Nothing is stopped by it.
          </Typography>
        </Box>
        {canEdit && (
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openAdd}>
            Add requirement
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {requirements.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="no-item-requirements">
          No requirements recorded. An order for this customer is reviewed with no per-item note.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell>COA</TableCell>
                <TableCell>Must show</TableCell>
                <TableCell>Timing</TableCell>
                <TableCell>Deliver to</TableCell>
                {canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {requirements.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell>
                    {r.product_name}
                    {!r.product_active && <Chip size="small" variant="outlined" label="Inactive product" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={CHIP_COLOR[r.coa_required]}
                      variant={r.coa_required === 'yes' ? 'filled' : 'outlined'}
                      label={CUSTOMER_COA_REQUIRED_LABELS[r.coa_required]}
                    />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 280 }}>{r.must_show || '—'}</TableCell>
                  <TableCell>{r.timing || '—'}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all' }}>
                    {r.delivery_contact ? r.delivery_contact.name || r.delivery_contact.email : '—'}
                  </TableCell>
                  {canEdit && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <IconButton size="small" aria-label={`Edit requirement for ${r.product_name}`} onClick={() => openEdit(r)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" aria-label={`Remove requirement for ${r.product_name}`} onClick={() => void remove(r)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={!!draft} onClose={() => !saving && setDraft(null)} fullWidth maxWidth="sm">
        <DialogTitle>{draft?.id ? 'Edit COA requirement' : 'Add COA requirement'}</DialogTitle>
        {draft && (
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
              {draft.id ? (
                <Typography variant="body2">
                  Item: <strong>{draft.product?.name}</strong>
                </Typography>
              ) : (
                <Autocomplete
                  size="small"
                  options={products.filter((p) => !taken.has(p.id))}
                  getOptionLabel={(o) => o.name}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  value={draft.product}
                  onChange={(_, v) => setDraft({ ...draft, product: v })}
                  renderInput={(params) => (
                    <TextField {...params} label="Item" required helperText="One requirement per item. Items that already have one are not listed." />
                  )}
                />
              )}
              <FormControl size="small" fullWidth>
                <InputLabel id="coa-required-label">COA</InputLabel>
                <Select
                  labelId="coa-required-label"
                  label="COA"
                  value={draft.coaRequired}
                  onChange={(e) => setDraft({ ...draft, coaRequired: e.target.value as CustomerCoaRequired })}
                >
                  {CUSTOMER_COA_REQUIRED_VALUES.map((v) => (
                    <MenuItem key={v} value={v}>{CUSTOMER_COA_REQUIRED_LABELS[v]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Must show"
                value={draft.mustShow}
                onChange={(e) => setDraft({ ...draft, mustShow: e.target.value })}
                helperText="What the certificate has to state, in your words: lot number, best-by date, micro results."
                multiline
                minRows={2}
                fullWidth
                size="small"
              />
              <TextField
                label="Timing"
                value={draft.timing}
                onChange={(e) => setDraft({ ...draft, timing: e.target.value })}
                helperText="When it is due: with the shipment, before it ships, monthly."
                fullWidth
                size="small"
              />
              <FormControl size="small" fullWidth>
                <InputLabel id="delivery-contact-label">Deliver to</InputLabel>
                <Select
                  labelId="delivery-contact-label"
                  label="Deliver to"
                  value={draft.deliveryContactId}
                  onChange={(e) => setDraft({ ...draft, deliveryContactId: String(e.target.value) })}
                >
                  <MenuItem value="">The customer's COA contacts</MenuItem>
                  {contacts.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {c.name ? `${c.name} (${c.email})` : c.email}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Notes"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                multiline
                minRows={2}
                fullWidth
                size="small"
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !draft?.product}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
