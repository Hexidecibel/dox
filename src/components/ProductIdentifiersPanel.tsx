import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Delete as DeleteIcon, Verified as VerifiedIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { ProductIdentifier, ProductIdentifierKind } from '../../shared/types';

/**
 * What a product goes by — our SKU, the supplier's item numbers and names,
 * aliases, a pack (migration 0107). Search resolves a product named any of
 * these ways, so every row shows who said so and whether a person confirmed
 * it: an unconfirmed identifier helps search FIND a certificate, and every
 * result reached through it is labelled "confirm".
 */

const KIND_LABEL: Record<ProductIdentifierKind, string> = {
  our_sku: 'Our SKU',
  supplier_item: 'Supplier item #',
  supplier_name: 'Supplier product name',
  alias: 'Alias',
  gtin: 'GTIN / UPC',
  pack: 'Pack',
};
const SUPPLIER_KINDS: ProductIdentifierKind[] = ['supplier_item', 'supplier_name'];

export function ProductIdentifiersPanel({ productId, tenantId }: { productId: string; tenantId: string }) {
  const [rows, setRows] = useState<ProductIdentifier[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<ProductIdentifierKind>('supplier_item');
  const [value, setValue] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [former, setFormer] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.products.identifiers.list(productId);
      setRows(res.identifiers);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load identifiers');
    }
  }, [productId]);

  useEffect(() => {
    load();
    api.suppliers.list({ active: 1, limit: 500, tenant_id: tenantId })
      .then((r) => setSuppliers(r.suppliers.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setSuppliers([]));
  }, [load, tenantId]);

  const needsSupplier = SUPPLIER_KINDS.includes(kind);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await api.products.identifiers.add(productId, {
        kind,
        value: value.trim(),
        supplier_id: needsSupplier ? supplierId : null,
        superseded: former,
        confirmed: !unconfirmed,
        note: note.trim() || null,
      });
      setValue('');
      setNote('');
      setFormer(false);
      setUnconfirmed(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add identifier');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update identifier');
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="product-identifiers">
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        Identifiers — what this product goes by
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
        Search finds this product by any of these. An unconfirmed identifier still helps search, but every result reached
        through it is marked “confirm”.
      </Typography>
      {error && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>{error}</Alert>}

      <Box sx={{ overflowX: 'auto', mb: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Kind</TableCell>
              <TableCell>Value</TableCell>
              <TableCell>Supplier</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography variant="body2" color="text.secondary">No identifiers yet.</Typography>
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{KIND_LABEL[r.kind]}</TableCell>
                <TableCell>
                  <Box component="span" sx={{ fontFamily: r.kind === 'supplier_name' || r.kind === 'alias' ? undefined : 'monospace' }}>{r.value}</Box>
                  {r.note && (
                    <Typography variant="caption" color="text.secondary" component="div">{r.note}</Typography>
                  )}
                </TableCell>
                <TableCell>{r.supplier_name ?? '—'}</TableCell>
                <TableCell>{r.source}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Chip size="small" label={r.confirmed ? 'Confirmed' : 'Unconfirmed'} color={r.confirmed ? 'success' : 'warning'} variant="outlined" />
                    {r.superseded === 1 && <Chip size="small" label="Former" variant="outlined" />}
                  </Stack>
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {!r.confirmed && (
                    <Tooltip title="Confirm — you stand behind this identifier">
                      <IconButton size="small" onClick={() => act(() => api.products.identifiers.update(r.id, { confirmed: true }))}>
                        <VerifiedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Remove">
                    <IconButton size="small" onClick={() => act(() => api.products.identifiers.remove(r.id))}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: { sm: 'center' } }}>
        <TextField select size="small" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as ProductIdentifierKind)} sx={{ minWidth: 180 }}>
          {(Object.keys(KIND_LABEL) as ProductIdentifierKind[]).map((k) => (
            <MenuItem key={k} value={k}>{KIND_LABEL[k]}</MenuItem>
          ))}
        </TextField>
        <TextField size="small" label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
        {needsSupplier && (
          <TextField select size="small" label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} sx={{ minWidth: 200 }}>
            {suppliers.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
          </TextField>
        )}
        <TextField size="small" label="Evidence / note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ flexGrow: 1, minWidth: 160 }} />
        {(kind === 'supplier_item' || kind === 'our_sku') && (
          <FormControlLabel control={<Checkbox size="small" checked={former} onChange={(e) => setFormer(e.target.checked)} />} label="Former number" />
        )}
        <FormControlLabel control={<Checkbox size="small" checked={unconfirmed} onChange={(e) => setUnconfirmed(e.target.checked)} />} label="Not confirmed yet" />
        <Button variant="contained" size="small" onClick={add} disabled={busy || !value.trim() || (needsSupplier && !supplierId)}>
          Add
        </Button>
      </Stack>
    </Paper>
  );
}
