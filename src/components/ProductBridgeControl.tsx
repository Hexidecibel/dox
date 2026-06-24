/**
 * Teach-at-review control for the COA-product -> order-product bridge.
 *
 * Rendered per COA record in CoaRecordsReviewTile. The reviewer maps the
 * manufacturer's COA product name (e.g. "Milk - Whole") to the distributor's
 * order-catalog product (e.g. "0417 — MS WHOLE 5 GL BAG"). The mapping itself
 * is NOT persisted here — the selection is lifted to the tile via `onChange`
 * and written server-side in the COA approve body (`product_maps`) after the
 * supplier is resolved. (A standalone PUT exists in api.productMap for editing
 * outside review, but this control never calls it.)
 *
 * Prefill: when supplierId + coaProductName are present we GET the existing
 * mapping on mount so a previously-taught bridge shows up pre-selected.
 *
 * Gate: disabled until the supplier is verified — there's no supplier_id to key
 * the map on until then.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  Box,
  CircularProgress,
  InputAdornment,
  TextField,
  Typography,
} from '@mui/material';
import { CheckCircle as MappedIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { OrderProductOption } from '../lib/types';

/** Value held by the tile for an approved record's mapping. */
export interface ProductBridgeValue {
  order_product_id: string;
  distributor_sku: string | null;
  order_product_name: string | null;
}

interface Props {
  tenantId: string;
  supplierId?: string;
  supplierName: string;
  coaProductName: string;
  disabled?: boolean;
  value: ProductBridgeValue | null;
  onChange: (value: ProductBridgeValue | null) => void;
}

/** "0417 — MS WHOLE 5 GL BAG" (code present) or just the name. */
function optionLabel(opt: OrderProductOption): string {
  const code = opt.product_code?.trim();
  const name = opt.product_name?.trim() || '(unnamed)';
  return code ? `${code} — ${name}` : name;
}

export default function ProductBridgeControl({
  tenantId,
  supplierId,
  // supplierName is part of the public prop contract (callers pass it for
  // future labeling) but not currently rendered.
  coaProductName,
  disabled = false,
  value,
  onChange,
}: Props) {
  const [options, setOptions] = useState<OrderProductOption[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  // Guard so we only attempt the prefill once per (supplier, coaProduct) pair.
  const prefilledFor = useRef<string | null>(null);

  // The Autocomplete value derived from the lifted tile value. We synthesize a
  // minimal option so the input shows the chosen label even before/without a
  // matching search result.
  const selectedOption: OrderProductOption | null = useMemo(() => {
    if (!value) return null;
    return {
      product_id: value.order_product_id,
      product_code: value.distributor_sku,
      product_name: value.order_product_name,
    };
  }, [value]);

  // Debounced search over the distributor order-product catalog.
  useEffect(() => {
    if (disabled) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.orderProducts.list({
          search: searchQuery || undefined,
          limit: 20,
          tenant_id: tenantId,
        });
        setOptions(res.products);
      } catch {
        // Silent — picker just shows no options.
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, disabled, tenantId]);

  // Prefill from an existing taught mapping when supplier + coa product known.
  useEffect(() => {
    if (disabled || !supplierId || !coaProductName.trim()) return;
    const key = `${supplierId}::${coaProductName.trim()}`;
    if (prefilledFor.current === key) return;
    prefilledFor.current = key;
    // Don't clobber an explicit local selection.
    if (value) return;
    let cancelled = false;
    setPrefilling(true);
    (async () => {
      try {
        const res = await api.productMap.get({
          supplier_id: supplierId,
          coa_product: coaProductName.trim(),
        });
        if (cancelled || !res.mapping) return;
        onChange({
          order_product_id: res.mapping.order_product_id,
          distributor_sku: res.mapping.distributor_sku,
          order_product_name: null,
        });
      } catch {
        // Non-fatal — no prefill.
      } finally {
        if (!cancelled) setPrefilling(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, coaProductName, disabled]);

  // Merge the selected option into the options list so the Autocomplete can
  // resolve its value even when it's not in the current search results.
  const mergedOptions = useMemo(() => {
    if (!selectedOption) return options;
    if (options.some((o) => o.product_id === selectedOption.product_id)) return options;
    return [selectedOption, ...options];
  }, [options, selectedOption]);

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Order product mapping
      </Typography>
      <Autocomplete
        size="small"
        options={mergedOptions}
        value={selectedOption}
        getOptionLabel={optionLabel}
        isOptionEqualToValue={(opt, val) => opt.product_id === val.product_id}
        onChange={(_, opt) =>
          onChange(
            opt
              ? {
                  order_product_id: opt.product_id,
                  distributor_sku: opt.product_code,
                  order_product_name: opt.product_name,
                }
              : null,
          )
        }
        onInputChange={(_, v, reason) => {
          if (reason === 'input') setSearchQuery(v);
        }}
        loading={searching || prefilling}
        disabled={disabled}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={
              coaProductName.trim()
                ? `Map "${coaProductName.trim()}" → order product…`
                : 'Map → order product…'
            }
            helperText={disabled ? 'Verify the supplier first' : undefined}
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <>
                  {value && (
                    <InputAdornment position="start">
                      <MappedIcon fontSize="small" color="success" />
                    </InputAdornment>
                  )}
                  {params.InputProps.startAdornment}
                </>
              ),
              endAdornment: (
                <>
                  {searching || prefilling ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />
    </Box>
  );
}
