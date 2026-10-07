/**
 * Customer > Contacts (migration 0135): the people at a customer, and which of
 * them receive COAs.
 *
 * The contacts marked "Receives COAs" are the addresses an order's review
 * screen is pre-filled with. They are a starting point, not a commitment: the
 * sender sees the list and can change it before anything leaves. With no
 * contact here at all, the customer's own email address is used, as it always
 * was. Adding a contact sends nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
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
import type { CustomerContact, CustomerContactsResponse } from '../../shared/types';

interface Props {
  customerId: string;
  customerName: string;
  canEdit: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  email: string;
  role: string;
  isPrimary: boolean;
  coaRecipient: boolean;
}

export default function CustomerContactsPanel({ customerId, customerName, canEdit }: Props) {
  const [data, setData] = useState<CustomerContactsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.customers.contacts.list(customerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const contacts = data?.contacts ?? [];

  const openAdd = () => {
    setDialogError('');
    // The first contact is the primary unless somebody says otherwise.
    setDraft({ id: null, name: '', email: '', role: '', isPrimary: contacts.length === 0, coaRecipient: true });
  };

  const openEdit = (c: CustomerContact) => {
    setDialogError('');
    setDraft({
      id: c.id,
      name: c.name ?? '',
      email: c.email,
      role: c.role ?? '',
      isPrimary: c.is_primary,
      coaRecipient: c.coa_recipient,
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setDialogError('');
    try {
      const body = {
        name: draft.name.trim() || null,
        email: draft.email.trim(),
        role: draft.role.trim() || null,
        is_primary: draft.isPrimary,
        coa_recipient: draft.coaRecipient,
      };
      const next = draft.id
        ? await api.customers.contacts.update(customerId, draft.id, body)
        : await api.customers.contacts.create(customerId, body);
      setData(next);
      setDraft(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: CustomerContact) => {
    if (!window.confirm(`Remove ${c.email}? A COA requirement that names this contact will keep its other details and have no delivery contact.`)) return;
    try {
      setData(await api.customers.contacts.remove(customerId, c.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove contact');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  const recipients = contacts.filter((c) => c.coa_recipient);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">Contacts</Typography>
          <Typography variant="body2" color="text.secondary">
            When an order for {customerName} is reviewed before sending, the address box starts with the
            contacts marked as receiving COAs. You can still change the addresses on that screen.
            Nothing is sent from here.
          </Typography>
        </Box>
        {canEdit && (
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openAdd}>
            Add contact
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {recipients.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="no-coa-recipients">
          {data?.customer.email
            ? `No contact is marked as receiving COAs, so an order send starts with the customer's own address, ${data.customer.email}.`
            : 'No contact is marked as receiving COAs and the customer has no email address on file, so an order send starts with an empty address box.'}
        </Alert>
      )}

      {contacts.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No contacts yet.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell />
                {canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id} hover>
                  <TableCell>{c.name || '—'}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all' }}>{c.email}</TableCell>
                  <TableCell>{c.role || '—'}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {c.is_primary && <Chip size="small" variant="outlined" label="Primary" />}
                      {c.coa_recipient && <Chip size="small" color="primary" label="Receives COAs" />}
                    </Stack>
                  </TableCell>
                  {canEdit && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <IconButton size="small" aria-label={`Edit ${c.email}`} onClick={() => openEdit(c)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" aria-label={`Remove ${c.email}`} onClick={() => void remove(c)}>
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
        <DialogTitle>{draft?.id ? 'Edit contact' : 'Add contact'}</DialogTitle>
        {draft && (
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
              <TextField
                label="Email"
                type="email"
                required
                autoFocus={!draft.id}
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                fullWidth
                size="small"
              />
              <TextField
                label="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                fullWidth
                size="small"
              />
              <TextField
                label="Role"
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                helperText="Optional, for your reference (QA, purchasing, receiving)."
                fullWidth
                size="small"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.coaRecipient}
                    onChange={(e) => setDraft({ ...draft, coaRecipient: e.target.checked })}
                  />
                }
                label="Receives COAs — pre-filled when an order is sent"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.isPrimary}
                    onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })}
                  />
                }
                label="Primary contact"
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !draft?.email.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
