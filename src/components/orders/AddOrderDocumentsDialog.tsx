import { useEffect, useMemo, useState } from 'react';
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
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../../lib/api';
import { SHARING_RULE_LABELS } from '../../../shared/sharingRule';
import { sharingRuleColor } from './OrderDocumentLines';
import type { ApprovedItem, OrderDocumentProposal, OrderDocumentsAddResponse } from '../../../shared/types';

/**
 * "Add documents for items" (migration 0138): pick items from the approved
 * list, pick the document types the customer wants, see what the portal finds,
 * then add.
 *
 * ONE ROW PER ITEM AND SUPPLIER, exactly as the approved list has it. An item
 * two suppliers are approved for is two rows, and ticking both puts both
 * suppliers' documents on the order: the portal does not choose a supplier.
 *
 * THE PREVIEW IS THE SERVER'S OWN ANSWER (`dry_run`), so what the person sees
 * before adding is what will be on the order: found, missing or expired, and
 * the rule each document leaves under.
 */
export interface AddOrderDocumentsDialogProps {
  open: boolean;
  orderId: string;
  tenantId?: string;
  onClose: () => void;
  onAdded: (result: OrderDocumentsAddResponse) => void;
}

interface TypeOption {
  id: string;
  name: string;
  supplier_id?: string | null;
}

const pairKey = (i: { product_id: string; supplier_id: string }) => `${i.product_id}|${i.supplier_id}`;

function resolutionChip(p: OrderDocumentProposal) {
  if (p.outcome === 'already_on_order') return <Chip size="small" variant="outlined" label="Already on the order" />;
  if (p.resolution === 'missing') return <Chip size="small" color="error" variant="outlined" label="Nothing on file" />;
  if (p.resolution === 'expired') return <Chip size="small" color="error" variant="outlined" label="Expired" />;
  return <Chip size="small" color="success" variant="outlined" label="Found" />;
}

export function AddOrderDocumentsDialog({ open, orderId, tenantId, onClose, onAdded }: AddOrderDocumentsDialogProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ApprovedItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [picked, setPicked] = useState<Map<string, ApprovedItem>>(new Map());
  const [pickedTypes, setPickedTypes] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<OrderDocumentsAddResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset whenever the dialog opens: a second order must not start with the
  // first one's ticks.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked(new Map());
    setPickedTypes(new Set());
    setPreview(null);
    setError('');
    api.documentTypes
      .list({ tenant_id: tenantId, active: 1 })
      .then((r) => setTypes((r.documentTypes ?? []) as TypeOption[]))
      .catch(() => setTypes([]));
  }, [open, tenantId]);

  // The approved list, searched on the server (item, supplier, brand owner,
  // producer, plant or any identifier). Only approved pairs are offered.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingItems(true);
    const timer = setTimeout(() => {
      api.approvedItems
        .list({ approval: 'approved', q: query.trim() || undefined, limit: 100, tenant_id: tenantId })
        .then((r) => {
          if (!cancelled) setItems(r.items);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the approved items');
        })
        .finally(() => {
          if (!cancelled) setLoadingItems(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, tenantId]);

  const toggleItem = (item: ApprovedItem) => {
    setPreview(null);
    setPicked((prev) => {
      const next = new Map(prev);
      const key = pairKey(item);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };
  const toggleType = (id: string) => {
    setPreview(null);
    setPickedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // A supplier's own type is offered only once an item of that supplier is picked.
  const pickedSuppliers = useMemo(() => new Set([...picked.values()].map((i) => i.supplier_id)), [picked]);
  const typeOptions = useMemo(
    () => types.filter((t) => !t.supplier_id || pickedSuppliers.has(t.supplier_id)),
    [types, pickedSuppliers],
  );

  const body = () => ({
    items: [...picked.values()].map((i) => ({ product_id: i.product_id, supplier_id: i.supplier_id })),
    document_type_ids: [...pickedTypes],
  });
  const ready = picked.size > 0 && pickedTypes.size > 0;

  const runPreview = async () => {
    setBusy(true);
    setError('');
    try {
      setPreview(await api.orders.addDocuments(orderId, { ...body(), dry_run: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not look the documents up');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      onAdded(await api.orders.addDocuments(orderId, body()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the documents');
    } finally {
      setBusy(false);
    }
  };

  const willAdd = preview?.lines.filter((l) => l.outcome === 'would_add').length ?? 0;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth data-testid="add-order-documents-dialog">
      <DialogTitle>Add documents for items</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2" color="text.secondary">
            Choose the items the customer is asking about and the documents they want. The portal finds each
            supplier&apos;s current approved document. An item with more than one approved supplier is listed once for
            each: tick the suppliers you want.
          </Typography>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              1. Items ({picked.size} chosen)
            </Typography>
            <TextField
              label="Search approved items"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              size="small"
              fullWidth
              placeholder="Item, supplier, SKU, plant"
              inputProps={{ 'data-testid': 'add-documents-search' }}
            />
            <Box sx={{ maxHeight: 240, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, mt: 1 }}>
              {loadingItems && items.length === 0 ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <CircularProgress size={24} />
                </Box>
              ) : items.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  No approved item matches. Only items approved from a supplier can be ordered.
                </Typography>
              ) : (
                <List dense disablePadding>
                  {items.map((item) => {
                    const key = pairKey(item);
                    return (
                      <ListItemButton key={key} onClick={() => toggleItem(item)} data-testid="add-documents-item">
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Checkbox edge="start" size="small" checked={picked.has(key)} tabIndex={-1} disableRipple />
                        </ListItemIcon>
                        <ListItemText
                          primary={`${item.product_name}${item.our_sku ? ` (${item.our_sku})` : ''}`}
                          secondary={[
                            item.supplier_name,
                            item.facility ? item.facility.name : null,
                            item.private_label ? 'Private label' : null,
                            item.supplied ? null : 'No longer supplied',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        />
                      </ListItemButton>
                    );
                  })}
                </List>
              )}
            </Box>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              2. Document types ({pickedTypes.size} chosen)
            </Typography>
            {typeOptions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No document types are set up yet.
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2 }}>
                {typeOptions.map((t) => (
                  <FormControlLabel
                    key={t.id}
                    control={
                      <Checkbox
                        size="small"
                        checked={pickedTypes.has(t.id)}
                        onChange={() => toggleType(t.id)}
                        inputProps={{ 'data-testid': 'add-documents-type' } as React.InputHTMLAttributes<HTMLInputElement>}
                      />
                    }
                    label={<Typography variant="body2">{t.name}</Typography>}
                  />
                ))}
              </Box>
            )}
          </Box>

          {preview && (
            <Box data-testid="add-documents-preview">
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                3. What the portal found
              </Typography>
              {preview.lines.map((l) => (
                <Box key={`${l.product_id}|${l.supplier_id}|${l.document_type_id}`} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }} data-testid="add-documents-preview-row">
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {l.document_type_name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {l.product_name} · {l.supplier_name}
                    </Typography>
                    {resolutionChip(l)}
                    {l.sharing_rule && (
                      <Chip size="small" variant="outlined" color={sharingRuleColor(l.sharing_rule)} label={SHARING_RULE_LABELS[l.sharing_rule]} />
                    )}
                  </Stack>
                  {l.document_title && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {l.document_title}
                    </Typography>
                  )}
                  {l.resolution_note && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }}>
                      {l.resolution_note}
                    </Typography>
                  )}
                  {l.advisory && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'info.dark' }}>
                      {l.advisory}
                    </Typography>
                  )}
                </Box>
              ))}
              {preview.refused.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }} data-testid="add-documents-refused">
                  Not added:
                  {preview.refused.map((r, i) => (
                    <Box key={i} component="span" sx={{ display: 'block' }}>
                      {[r.product_name, r.supplier_name, r.document_type_name].filter(Boolean).join(' · ') || 'An item'}: {r.reason}
                    </Box>
                  ))}
                </Alert>
              )}
              {preview.lines.some((l) => l.outcome === 'would_add' && l.resolution !== 'found') && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  A missing or expired document can still be added. It will not be sent, and QA is told when the order
                  is sent.
                </Typography>
              )}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        {!preview ? (
          <Button variant="contained" onClick={runPreview} disabled={!ready || busy} sx={{ textTransform: 'none' }} data-testid="add-documents-preview-button">
            {busy ? 'Looking…' : 'See what is on file'}
          </Button>
        ) : (
          <Button variant="contained" onClick={add} disabled={busy || willAdd === 0} sx={{ textTransform: 'none' }} data-testid="add-documents-confirm">
            {busy ? 'Adding…' : willAdd === 0 ? 'Nothing to add' : `Add ${willAdd} to the order`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
