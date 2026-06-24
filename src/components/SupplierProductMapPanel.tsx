/**
 * Standalone product-map editor for the supplier admin page.
 *
 * Maps each of a supplier's COA products (manufacturer names, e.g.
 * "Milk - Whole") to a distributor order-catalog SKU (e.g. "0417 — MS WHOLE
 * 5 GL BAG"). This exists because the teach-at-review picker
 * (CoaRecordsReviewTile) only surfaces for multi-record COAs — single-product
 * COAs (e.g. Country Morning) never expose a place to teach their maps. Here an
 * admin can author/edit those maps directly.
 *
 * Each row reuses ProductBridgeControl, which self-prefills any existing
 * mapping via GET /api/product-map on mount. Unlike review (where the selection
 * is lifted and written in the approve body), this panel persists each pick
 * immediately via PUT /api/product-map.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Snackbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { CheckCircle as SavedIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiProduct } from '../lib/types';
import ProductBridgeControl, { type ProductBridgeValue } from './ProductBridgeControl';

interface Props {
  tenantId: string;
  supplierId: string;
  supplierName: string;
  canEdit: boolean;
}

/** Per-row save state for the transient "Saved ✓" affordance. */
type RowSaveState = 'idle' | 'saving' | 'saved';

export default function SupplierProductMapPanel({
  tenantId,
  supplierId,
  supplierName,
  canEdit,
}: Props) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Per-row controlled value for the bridge control (keyed by product id).
  // ProductBridgeControl is controlled, so we hold its value and update it from
  // both its prefill and the user's explicit pick.
  const [values, setValues] = useState<Record<string, ProductBridgeValue | null>>({});
  const [saveStates, setSaveStates] = useState<Record<string, RowSaveState>>({});
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        // Supplier-scoped COA products — the products whose supplier_id is this
        // supplier (created via COA review / connector ingest). Include inactive
        // ones: high-volume products can be marked inactive yet still ship and
        // need mapping (the matcher keys the map by product name, not active state).
        const res = await api.products.list({ supplier_id: supplierId, tenant_id: tenantId, active: 'all' });
        if (!cancelled) setProducts(res.products);
      } catch (err) {
        if (!cancelled) {
          setProducts([]);
          setLoadError(err instanceof Error ? err.message : 'Failed to load products');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId, tenantId]);

  const handleChange = useCallback(
    (product: ApiProduct, value: ProductBridgeValue | null) => {
      // Reflect the new selection locally (keeps the controlled input in sync,
      // and lets the prefill populate the row on mount).
      setValues((prev) => ({ ...prev, [product.id]: value }));

      // No persistence for a cleared selection or in read-only mode. (The
      // prefill also fires onChange to seed the value; persisting that would be
      // a redundant write, so we only persist a non-null, edit-enabled pick.)
      if (!value || !canEdit) return;

      setSaveStates((prev) => ({ ...prev, [product.id]: 'saving' }));
      (async () => {
        try {
          await api.productMap.put({
            supplier_id: supplierId,
            coa_product: product.name,
            order_product_id: value.order_product_id,
            distributor_sku: value.distributor_sku ?? null,
          });
          setSaveStates((prev) => ({ ...prev, [product.id]: 'saved' }));
          // Clear the "Saved ✓" badge after a beat.
          setTimeout(() => {
            setSaveStates((prev) =>
              prev[product.id] === 'saved' ? { ...prev, [product.id]: 'idle' } : prev,
            );
          }, 2000);
        } catch (err) {
          setSaveStates((prev) => ({ ...prev, [product.id]: 'idle' }));
          setSaveError(err instanceof Error ? err.message : 'Failed to save mapping');
        }
      })();
    },
    [canEdit, supplierId],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
        Product Mapping
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Map each COA product to the matching distributor SKU so COAs link to WMS order lines.
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setLoadError('')}>
          {loadError}
        </Alert>
      )}

      {products.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No products yet for this supplier — they appear after COAs are reviewed.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '40%' }}>COA product</TableCell>
                <TableCell>Distributor SKU</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {products.map((product) => {
                const state = saveStates[product.id] ?? 'idle';
                return (
                  <TableRow key={product.id} hover>
                    <TableCell sx={{ verticalAlign: 'top', pt: 2.5 }}>
                      <Typography variant="body2" fontWeight={500}>
                        {product.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                        <Box sx={{ flexGrow: 1 }}>
                          <ProductBridgeControl
                            tenantId={tenantId}
                            supplierId={supplierId}
                            supplierName={supplierName}
                            coaProductName={product.name}
                            disabled={!canEdit}
                            value={values[product.id] ?? null}
                            onChange={(v) => handleChange(product, v)}
                          />
                        </Box>
                        <Box sx={{ minWidth: 70, pt: 3 }}>
                          {state === 'saving' && <CircularProgress size={16} />}
                          {state === 'saved' && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <SavedIcon fontSize="small" color="success" />
                              <Typography variant="caption" color="success.main">
                                Saved
                              </Typography>
                            </Box>
                          )}
                        </Box>
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Snackbar
        open={!!saveError}
        autoHideDuration={5000}
        onClose={() => setSaveError('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setSaveError('')} variant="filled">
          {saveError}
        </Alert>
      </Snackbar>
    </Box>
  );
}
