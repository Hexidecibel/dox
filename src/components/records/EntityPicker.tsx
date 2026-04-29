/**
 * EntityPicker — search-and-select modal used by entity-ref columns
 * (supplier_ref, product_ref). The supplier and product backends already
 * expose tenant-scoped list+search endpoints; this component wraps them
 * in a uniform picker dialog.
 *
 * Phase 1 scope: read-only selection of an existing entity. Inline
 * "create new" is a follow-up — both backends already support
 * lookup-or-create, but the UX needs more thought (the chip expects
 * `{ id, name }` so we'd need to round-trip the new entity through the
 * picker before committing the cell).
 *
 * For document_ref and record_ref we render a "coming soon" empty state
 * — the cross-sheet lookup needs a target_sheet_id config and the row
 * search endpoint isn't built yet.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
  CircularProgress,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type { RecordColumnType } from '../../../shared/types';

export interface EntityOption {
  id: string;
  name: string;
  /** Optional secondary line shown under the primary label in the picker. */
  secondary?: string;
}

interface EntityPickerProps {
  open: boolean;
  type: RecordColumnType;
  tenantId: string | null;
  /** When set, the picker submits with this single entity selected. */
  initialValue?: EntityOption | null;
  onClose: () => void;
  /** null = clear; EntityOption = pick this. */
  onSelect: (value: EntityOption | null) => void;
  /** Flow control for full-screen mobile mode. */
  fullScreen?: boolean;
}

export function EntityPicker({ open, type, tenantId, initialValue, onClose, onSelect, fullScreen }: EntityPickerProps) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const supported =
    type === 'supplier_ref' || type === 'product_ref' || type === 'customer_ref';

  useEffect(() => {
    if (!open) {
      setSearch('');
      setError('');
      setResults([]);
      return;
    }
    if (!supported) return;

    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError('');
        try {
          if (type === 'supplier_ref') {
            const res = await api.suppliers.list({
              search: search || undefined,
              tenant_id: tenantId ?? undefined,
              limit: 25,
            });
            if (!cancelled) {
              setResults(res.suppliers.map((s) => ({ id: s.id, name: s.name })));
            }
          } else if (type === 'product_ref') {
            const res = await api.products.list({
              search: search || undefined,
              tenant_id: tenantId ?? undefined,
              limit: 25,
            });
            if (!cancelled) {
              setResults(res.products.map((p) => ({ id: p.id, name: p.name })));
            }
          } else if (type === 'customer_ref') {
            // The customers list endpoint takes `search` and only returns
            // active customers by default — exactly what the picker wants.
            const res = (await api.customers.list({
              search: search || undefined,
              tenant_id: tenantId ?? undefined,
              limit: 25,
            })) as { customers: { id: string; name: string; customer_number?: string | null; email?: string | null }[] };
            if (!cancelled) {
              setResults(
                res.customers.map((c) => ({
                  id: c.id,
                  name: c.name,
                  secondary: [c.customer_number, c.email].filter(Boolean).join(' · ') || undefined,
                })),
              );
            }
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Search failed');
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 200); // small debounce so typing isn't a request storm

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, search, type, tenantId, supported]);

  const title = type === 'supplier_ref' ? 'Pick a supplier'
    : type === 'product_ref' ? 'Pick a product'
    : type === 'customer_ref' ? 'Pick a customer'
    : type === 'document_ref' ? 'Pick a document'
    : type === 'record_ref' ? 'Pick a record'
    : type === 'contact' ? 'Pick a contact'
    : 'Pick';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={fullScreen}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {title}
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 380 }}>
        {!supported ? (
          <Box sx={{ textAlign: 'center', py: 6 }}>
            <Typography variant="body2" color="text.secondary">
              {title} is coming in a follow-up. Phase 1 supports supplier, product, and customer references.
            </Typography>
          </Box>
        ) : (
          <>
            <TextField
              autoFocus
              fullWidth
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="medium"
              sx={{ mb: 2 }}
              InputProps={{
                sx: { minHeight: 48 },
              }}
            />
            {error && (
              <Typography variant="body2" color="error" sx={{ mb: 2 }}>
                {error}
              </Typography>
            )}
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={20} />
              </Box>
            ) : results.length === 0 ? (
              <Box sx={{ textAlign: 'center', py: 6 }}>
                <Typography variant="body2" color="text.secondary">
                  {search ? 'No matches' : 'Start typing to search'}
                </Typography>
              </Box>
            ) : (
              <List dense disablePadding>
                {results.map((opt) => (
                  <ListItemButton
                    key={opt.id}
                    selected={initialValue?.id === opt.id}
                    onClick={() => onSelect(opt)}
                    sx={{ minHeight: 48, borderRadius: 1, mb: 0.5 }}
                  >
                    <ListItemText primary={opt.name} secondary={opt.secondary} />
                  </ListItemButton>
                ))}
              </List>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {initialValue && (
          <Button color="error" onClick={() => onSelect(null)}>
            Clear
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
