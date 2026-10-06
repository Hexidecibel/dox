/**
 * Supplier > Contacts (migration 0133): who at this supplier receives document
 * requests.
 *
 * The one thing this screen has to make unmistakable is WHICH address a
 * renewal request will go to. A supplier has at most one document contact;
 * every other row is a name on file. With none, the portal drafts no renewal
 * request for this supplier at all, and the panel says so rather than leaving
 * an empty table to be read as "fine".
 *
 * Adding a contact sends nothing. A request reaches a supplier only after a
 * person approves it on Renewals.
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
  Tooltip,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { SupplierContact, SupplierContactsResponse } from '../../shared/types';

interface Props {
  supplierId: string;
  supplierName: string;
  canEdit: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  email: string;
  role: string;
  isDocumentContact: boolean;
  active: boolean;
}

const EMPTY: Draft = { id: null, name: '', email: '', role: '', isDocumentContact: false, active: true };

export default function SupplierContactsPanel({ supplierId, supplierName, canEdit }: Props) {
  const [data, setData] = useState<SupplierContactsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.suppliers.contacts.list(supplierId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setDialogError('');
    // The first contact is the document contact unless somebody says otherwise.
    setDraft({ ...EMPTY, isDocumentContact: !data?.document_contact });
  };

  const openEdit = (c: SupplierContact) => {
    setDialogError('');
    setDraft({
      id: c.id,
      name: c.name ?? '',
      email: c.email,
      role: c.role ?? '',
      isDocumentContact: c.is_document_contact,
      active: c.active,
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
        is_document_contact: draft.isDocumentContact && draft.active,
        ...(draft.id ? { active: draft.active } : {}),
      };
      const next = draft.id
        ? await api.suppliers.contacts.update(supplierId, draft.id, body)
        : await api.suppliers.contacts.create(supplierId, body);
      setData(next);
      setDraft(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: SupplierContact) => {
    const warning = c.is_document_contact
      ? `Remove ${c.email}? This is the document contact: renewal requests to ${supplierName} will stop being drafted until another one is chosen.`
      : `Remove ${c.email}?`;
    if (!window.confirm(warning)) return;
    try {
      setData(await api.suppliers.contacts.remove(supplierId, c.id));
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

  const contacts = data?.contacts ?? [];
  const documentContact = data?.document_contact ?? null;
  const replacing =
    draft && draft.isDocumentContact && draft.active && documentContact && documentContact.id !== draft.id
      ? documentContact
      : null;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">Contacts</Typography>
          <Typography variant="body2" color="text.secondary">
            The document contact is the one address renewal requests to {supplierName} are sent to.
            Nothing is sent from this screen: a request is drafted when a document nears its
            renewal date and goes out only after a person approves it on Renewals.
          </Typography>
        </Box>
        {canEdit && (
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openAdd}>
            Add contact
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {!documentContact && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="no-document-contact">
          No document contact on file. Renewal requests for this supplier's documents are not
          drafted until one is chosen{contacts.length > 0 ? ' — edit a contact below and mark it as the document contact.' : '.'}
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
                <TableCell>Receives</TableCell>
                {canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id} hover sx={c.active ? undefined : { opacity: 0.55 }}>
                  <TableCell>{c.name || '—'}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all' }}>{c.email}</TableCell>
                  <TableCell>{c.role || '—'}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {c.is_document_contact && <Chip size="small" color="primary" label="Document requests" />}
                      {!c.active && <Chip size="small" variant="outlined" label="Inactive" />}
                      {c.source === 'import' && (
                        <Tooltip title="Added from the verified supplier list">
                          <Chip size="small" variant="outlined" label="From supplier list" />
                        </Tooltip>
                      )}
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
                helperText="Used in the greeting of a request: “Hello Dana,”"
                fullWidth
                size="small"
              />
              <TextField
                label="Role"
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                helperText="Optional, for your reference (QA, sales, regulatory)."
                fullWidth
                size="small"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.isDocumentContact && draft.active}
                    disabled={!draft.active}
                    onChange={(e) => setDraft({ ...draft, isDocumentContact: e.target.checked })}
                  />
                }
                label="Document contact — renewal requests go to this address"
              />
              {draft.id && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={draft.active}
                      onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                    />
                  }
                  label="Active"
                />
              )}
              {replacing && (
                <Alert severity="info">
                  This replaces {replacing.email} as the document contact.
                </Alert>
              )}
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
