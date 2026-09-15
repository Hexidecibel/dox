/**
 * Supplier › Product identifiers — the SUPPLIER-SIDE view of the product
 * identifier graph (migrations 0107 / 0113).
 *
 * Replaces the old Product Mapping panel (supplier_product_map, retired in
 * 0113). One store, two views: the Product page lists what ONE product goes by;
 * this lists every item number and product name ONE supplier's paperwork uses,
 * and which product of ours each names. Add / confirm / remove go through the
 * same endpoints as the Product page (POST /api/products/:id/identifiers,
 * PUT / DELETE /api/product-identifiers/:id), with the same permissions and the
 * same audit rows.
 *
 * The useful part of the old panel is kept: "Certificate products not yet
 * identified" lists the names / item numbers this supplier's certificates have
 * actually carried that do not resolve to one confirmed product, each with the
 * reason (an ambiguous name says which products it could be), and maps one in a
 * click.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Link,
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
import type { ApiProduct } from '../lib/types';
import type {
  ProductIdentifierSource,
  SupplierProductIdentifierRow,
  SupplierProductIdentifiersResponse,
  SupplierUnidentifiedProduct,
} from '../../shared/types';

interface Props {
  tenantId: string;
  supplierId: string;
  supplierName: string;
  canEdit: boolean;
}

const SOURCE_LABEL: Record<ProductIdentifierSource, string> = {
  seed: 'seed',
  reviewer: 'reviewer',
  extracted: 'extracted',
  import: 'import',
  migrated_product_map: 'old product mapping',
};

type SupplierKind = 'supplier_item' | 'supplier_name';

/** Search our products (any, active or not) for a mapping target. */
function ProductPicker({
  tenantId,
  value,
  onChange,
  disabled,
  label = 'Our product',
}: {
  tenantId: string;
  value: ApiProduct | null;
  onChange: (p: ApiProduct | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [options, setOptions] = useState<ApiProduct[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (disabled) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.products.list({ search: query || undefined, limit: 20, tenant_id: tenantId, active: 'all' });
        setOptions(res.products);
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, tenantId, disabled]);

  return (
    <Autocomplete
      size="small"
      sx={{ minWidth: 240, flexGrow: 1 }}
      options={value && !options.some((o) => o.id === value.id) ? [value, ...options] : options}
      value={value}
      getOptionLabel={(o) => o.name}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(_, v) => onChange(v)}
      onInputChange={(_, v, reason) => {
        if (reason === 'input') setQuery(v);
      }}
      loading={loading}
      disabled={disabled}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

function UnidentifiedRow({
  row,
  tenantId,
  supplierId,
  canEdit,
  onMapped,
  onError,
}: {
  row: SupplierUnidentifiedProduct;
  tenantId: string;
  supplierId: string;
  canEdit: boolean;
  onMapped: () => void;
  onError: (msg: string) => void;
}) {
  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [busy, setBusy] = useState(false);

  const map = async () => {
    if (!product) return;
    setBusy(true);
    try {
      const note = `Mapped on Supplier › Product identifiers from ${row.document_count} certificate(s) this supplier sent.`;
      if (row.supplier_item) {
        await api.products.identifiers.add(product.id, { kind: 'supplier_item', value: row.supplier_item, supplier_id: supplierId, note });
      }
      if (row.product_name) {
        await api.products.identifiers.add(product.id, { kind: 'supplier_name', value: row.product_name, supplier_id: supplierId, note });
      }
      onMapped();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to map');
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell sx={{ verticalAlign: 'top' }}>
        <Typography variant="body2" fontWeight={500}>{row.product_name ?? '—'}</Typography>
        {row.supplier_item && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ fontFamily: 'monospace' }}>
            item {row.supplier_item}
          </Typography>
        )}
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>{row.document_count}</TableCell>
      <TableCell sx={{ verticalAlign: 'top', maxWidth: 360 }}>
        <Typography variant="caption" color="text.secondary">
          {row.resolution.note ?? 'No identifier names this yet.'}
        </Typography>
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {canEdit ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ProductPicker tenantId={tenantId} value={product} onChange={setProduct} disabled={busy} label="Map to our product" />
            <Button size="small" variant="contained" onClick={map} disabled={!product || busy}>
              {busy ? <CircularProgress size={14} color="inherit" /> : 'Map'}
            </Button>
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">An admin can map this.</Typography>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function SupplierProductIdentifiersPanel({ tenantId, supplierId, supplierName, canEdit }: Props) {
  const [data, setData] = useState<SupplierProductIdentifiersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [kind, setKind] = useState<SupplierKind>('supplier_item');
  const [value, setValue] = useState('');
  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [former, setFormer] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.suppliers.productIdentifiers.list(supplierId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load product identifiers');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update identifier');
    }
  };

  const add = async () => {
    if (!product) return;
    setBusy(true);
    setError('');
    try {
      await api.products.identifiers.add(product.id, {
        kind,
        value: value.trim(),
        supplier_id: supplierId,
        superseded: kind === 'supplier_item' && former,
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

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  const identifiers: SupplierProductIdentifierRow[] = data?.identifiers ?? [];
  const unidentified = data?.unidentified ?? [];

  return (
    <Box data-testid="supplier-product-identifiers">
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
        Product identifiers
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        How {supplierName}'s paperwork names our products. Lot matching and search both read these: the item number
        decides first, then the product name with its pack, and a name that fits several of our products picks none.
        The same identifiers appear on each product's page.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{supplierName} calls it</TableCell>
                <TableCell>Our product</TableCell>
                <TableCell>Our SKU</TableCell>
                <TableCell>Pack</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {identifiers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Typography variant="body2" color="text.secondary">No identifiers for this supplier yet.</Typography>
                  </TableCell>
                </TableRow>
              )}
              {identifiers.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Chip size="small" variant="outlined" label={r.kind === 'supplier_item' ? 'Item #' : 'Name'} />
                      <Box component="span" sx={{ fontFamily: r.kind === 'supplier_item' ? 'monospace' : undefined }}>{r.value}</Box>
                    </Stack>
                    {r.note && <Typography variant="caption" color="text.secondary" component="div">{r.note}</Typography>}
                  </TableCell>
                  <TableCell>
                    <Link component={RouterLink} to={`/admin/products/${r.product_id}`}>{r.product_name}</Link>
                    {r.product_active === 0 && <Chip size="small" label="Inactive" sx={{ ml: 1 }} variant="outlined" />}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{r.product_our_skus.join(' / ') || '—'}</TableCell>
                  <TableCell>{r.product_pack ?? '—'}</TableCell>
                  <TableCell>{SOURCE_LABEL[r.source] ?? r.source}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Chip size="small" label={r.confirmed ? 'Confirmed' : 'Unconfirmed'} color={r.confirmed ? 'success' : 'warning'} variant="outlined" />
                      {r.superseded === 1 && <Chip size="small" label="Former" variant="outlined" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {canEdit && !r.confirmed && (
                      <Tooltip title="Confirm — you stand behind this identifier">
                        <IconButton size="small" onClick={() => act(() => api.products.identifiers.update(r.id, { confirmed: true }))}>
                          <VerifiedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {canEdit && (
                      <Tooltip title="Remove">
                        <IconButton size="small" onClick={() => act(() => api.products.identifiers.remove(r.id))}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>

        {canEdit && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ p: 2, flexWrap: 'wrap', alignItems: { sm: 'center' }, borderTop: 1, borderColor: 'divider' }}>
            <TextField select size="small" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as SupplierKind)} sx={{ minWidth: 170 }}>
              <MenuItem value="supplier_item">Their item #</MenuItem>
              <MenuItem value="supplier_name">Their product name</MenuItem>
            </TextField>
            <TextField size="small" label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
            <ProductPicker tenantId={tenantId} value={product} onChange={setProduct} disabled={busy} />
            <TextField size="small" label="Evidence / note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ minWidth: 160 }} />
            {kind === 'supplier_item' && (
              <FormControlLabel control={<Checkbox size="small" checked={former} onChange={(e) => setFormer(e.target.checked)} />} label="Former number" />
            )}
            <FormControlLabel control={<Checkbox size="small" checked={unconfirmed} onChange={(e) => setUnconfirmed(e.target.checked)} />} label="Not confirmed yet" />
            <Button variant="contained" size="small" onClick={add} disabled={busy || !value.trim() || !product}>
              Add
            </Button>
          </Stack>
        )}
      </Paper>

      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 0.5 }}>
        Certificate products not yet identified
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Product names and item numbers {supplierName}'s certificates have carried that do not name exactly one confirmed
        product of ours. Mapping one adds its item number and name as confirmed identifiers.
      </Typography>
      {unidentified.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          Every certificate product from this supplier is identified.
        </Typography>
      ) : (
        <Paper variant="outlined">
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>On the certificate</TableCell>
                  <TableCell>Certificates</TableCell>
                  <TableCell>Why it is not identified</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {unidentified.map((row) => (
                  <UnidentifiedRow
                    key={`${row.product_name ?? ''}::${row.supplier_item ?? ''}`}
                    row={row}
                    tenantId={tenantId}
                    supplierId={supplierId}
                    canEdit={canEdit}
                    onMapped={load}
                    onError={setError}
                  />
                ))}
              </TableBody>
            </Table>
          </Box>
        </Paper>
      )}
    </Box>
  );
}
