/**
 * What ONE product of ONE supplier owes per product (migration 0123), inside
 * the expanded row on Supplier › Products.
 *
 * Three edits live here, each a person's decision with a recorded reason where
 * one could make an obligation disappear:
 *
 *   Exempt       an inherited per-product requirement, for this product only.
 *                Reason required (a packaging SKU owes no nutritionals).
 *   Add          a per-product requirement to this product only.
 *   Nothing owed a declaration that this product owes nothing per product,
 *                reason required, so it reads settled rather than "nothing set
 *                up". And "no longer supplied", which takes the product out of
 *                per-product checking (the gap report still names it).
 *
 * The state shown comes from the gap engine (`ProductGap`), never recomputed
 * here, so this panel and the Requirements panel cannot disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import type { ApiProduct, ApiProductRequirement, ApiRequirement, ProductGap } from '../lib/types';
import { ProductStatusChip } from './SupplierRequirementGaps';

export default function ProductRequirementsPanel({
  supplierId,
  product,
  productGap,
  canEdit,
  onChanged,
}: {
  supplierId: string;
  product: ApiProduct;
  /** Undefined when the product is not active for this supplier (inactive / no longer supplied). */
  productGap: ProductGap | undefined;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ApiProductRequirement[]>([]);
  const [vocab, setVocab] = useState<ApiRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exempting, setExempting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [addId, setAddId] = useState('');
  const [nothingOwed, setNothingOwed] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pr, req] = await Promise.all([
        api.productRequirements.list({ supplier_id: supplierId, product_id: product.id }),
        api.requirements.list({ tenant_id: product.tenant_id, limit: 500 }),
      ]);
      setRows(pr.product_requirements);
      setVocab(req.requirements.filter((r) => r.scope === 'product' && r.active));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load per-product requirements');
    } finally {
      setLoading(false);
    }
  }, [supplierId, product.id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setExempting(null);
      setReason('');
      setAddId('');
      setNothingOwed('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const rowFor = (requirementId: string) => rows.find((r) => r.requirement_id === requirementId);
  const addable = useMemo(() => {
    const taken = new Set([
      ...(productGap?.requirements ?? []).map((r) => r.requirement_id),
      ...rows.map((r) => r.requirement_id),
    ]);
    return vocab.filter((r) => !taken.has(r.id));
  }, [vocab, rows, productGap]);

  const discontinued = !!product.link_discontinued_at;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">Per-product requirements</Typography>
        {discontinued ? (
          <Chip size="small" label="No longer supplied" />
        ) : productGap ? (
          <ProductStatusChip product={productGap} />
        ) : !product.active ? (
          <Chip size="small" label="Inactive product — not checked" />
        ) : null}
        <Box sx={{ flexGrow: 1 }} />
        {canEdit && (
          <Button
            size="small"
            disabled={busy}
            onClick={() =>
              run(() => api.supplierProducts.update(supplierId, product.id, { discontinued: !discontinued }))
            }
          >
            {discontinued ? 'Supplied again' : 'No longer supplied'}
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {productGap?.status === 'not_checked' && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          No per-product requirement is attached to this supplier, so products are not checked
          one by one. Attach one on the Requirements tab, or add one to this product below.
        </Typography>
      )}

      {(productGap?.requirements ?? []).map((r) => {
        const own = rowFor(r.requirement_id);
        return (
          <Box key={r.requirement_id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              variant="outlined"
              color={r.satisfied ? 'success' : 'error'}
              label={r.satisfied ? 'closed' : 'open'}
            />
            <Typography variant="body2" sx={{ minWidth: 200 }}>
              {r.name}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                {r.origin === 'supplier'
                  ? '(attached to the supplier)'
                  : r.origin === 'product'
                    ? '(added to this product)'
                    : '(opened by a claim about this product)'}
              </Typography>
            </Typography>
            {canEdit && r.origin === 'supplier' && exempting !== r.requirement_id && (
              <Button size="small" disabled={busy} onClick={() => setExempting(r.requirement_id)}>
                Exempt this product
              </Button>
            )}
            {canEdit && own?.mode === 'add' && (
              <Button size="small" disabled={busy} onClick={() => run(() => api.productRequirements.delete(own.id))}>
                Remove from this product
              </Button>
            )}
            {exempting === r.requirement_id && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', width: '100%' }}>
                <TextField
                  size="small"
                  label="Why this product is exempt"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  sx={{ flexGrow: 1 }}
                  autoFocus
                />
                <Button
                  size="small"
                  variant="contained"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    run(() =>
                      api.productRequirements.create({
                        supplier_id: supplierId,
                        product_id: product.id,
                        requirement_id: r.requirement_id,
                        mode: 'exempt',
                        reason: reason.trim(),
                      }),
                    )
                  }
                >
                  Exempt
                </Button>
                <Button size="small" onClick={() => setExempting(null)}>
                  Cancel
                </Button>
              </Box>
            )}
          </Box>
        );
      })}

      {rows
        .filter((r) => r.mode === 'exempt')
        .map((r) => (
          <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, flexWrap: 'wrap' }}>
            <Chip size="small" variant="outlined" label="exempt" />
            <Typography variant="body2" sx={{ minWidth: 200 }}>
              {r.requirement_name}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                — {r.reason || 'no reason recorded'}
              </Typography>
            </Typography>
            {canEdit && (
              <Button size="small" disabled={busy} onClick={() => run(() => api.productRequirements.delete(r.id))}>
                Remove exemption
              </Button>
            )}
          </Box>
        ))}

      {canEdit && !discontinued && addable.length > 0 && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
          <TextField
            select
            size="small"
            label="Add a per-product requirement to this product"
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            sx={{ minWidth: 320 }}
          >
            {addable.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {r.name}
              </MenuItem>
            ))}
          </TextField>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !addId}
            onClick={() =>
              run(() =>
                api.productRequirements.create({
                  supplier_id: supplierId,
                  product_id: product.id,
                  requirement_id: addId,
                  mode: 'add',
                }),
              )
            }
          >
            Add
          </Button>
        </Box>
      )}

      {!discontinued && (
        <Box sx={{ mt: 1.5 }}>
          {product.link_nothing_owed_reason ? (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2">
                Declared: nothing owed per product — {product.link_nothing_owed_reason}
              </Typography>
              {canEdit && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    run(() => api.supplierProducts.update(supplierId, product.id, { nothing_owed_reason: null }))
                  }
                >
                  Clear
                </Button>
              )}
            </Box>
          ) : (
            canEdit && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <TextField
                  size="small"
                  label="Declare nothing owed per product — why?"
                  value={nothingOwed}
                  onChange={(e) => setNothingOwed(e.target.value)}
                  sx={{ minWidth: 320 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy || !nothingOwed.trim()}
                  onClick={() =>
                    run(() =>
                      api.supplierProducts.update(supplierId, product.id, {
                        nothing_owed_reason: nothingOwed.trim(),
                      }),
                    )
                  }
                >
                  Declare
                </Button>
              </Box>
            )
          )}
        </Box>
      )}
    </Box>
  );
}
