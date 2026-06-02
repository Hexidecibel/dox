import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Autocomplete,
  TextField,
  Chip,
  CircularProgress,
  Box,
  Typography,
  createFilterOptions,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  WarningAmber as WarningAmberIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiSupplier } from '../lib/types';

/**
 * The verified-supplier value surfaced by this control.
 *
 * - `supplierId` is set only when an EXISTING supplier was selected.
 * - `supplierName` is the chosen/typed name (always present when non-empty).
 * - `verified` is true when an existing supplier was selected OR the user has
 *   explicitly confirmed creating a free-typed new name (via the
 *   "Create '<name>'" option). A free-typed name that hasn't been confirmed
 *   stays `verified: false`.
 */
export interface SupplierValue {
  supplierId?: string;
  supplierName: string;
  verified: boolean;
}

interface SupplierAutocompleteProps {
  tenantId: string;
  value: SupplierValue;
  onChange: (value: SupplierValue) => void;
  label?: string;
  /** Disable the input (e.g. while a save is in flight). */
  disabled?: boolean;
  size?: 'small' | 'medium';
  /** Render the verified/unverified status adornment. Defaults to true. */
  showStatus?: boolean;
}

/**
 * Option shape used internally by the Autocomplete. An existing supplier
 * carries an `id`; the synthetic "Create '<name>'" entry carries
 * `create: true` and no id.
 */
interface SupplierOption {
  id?: string;
  name: string;
  /** Synthetic "create this name" affordance. */
  create?: boolean;
  /** Raw freeSolo string typed by the user (used to build the create label). */
  inputValue?: string;
}

const filter = createFilterOptions<SupplierOption>();

/**
 * Reusable supplier picker (MUI Autocomplete, freeSolo) that forces the
 * reviewer to VERIFY the supplier: selecting an existing supplier verifies
 * immediately; typing a brand-new name stays unverified until the user picks
 * the "Create '<name>'" option.
 *
 * Used by the Review Queue (gate approval on verification) and the document
 * detail supplier-edit control.
 */
export default function SupplierAutocomplete({
  tenantId,
  value,
  onChange,
  label = 'Supplier',
  disabled = false,
  size = 'small',
  showStatus = true,
}: SupplierAutocompleteProps) {
  const [inputValue, setInputValue] = useState(value.supplierName || '');
  const [options, setOptions] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the visible input text in sync when the value is reset/initialized
  // from outside (e.g. switching the selected queue item).
  useEffect(() => {
    setInputValue(value.supplierName || '');
  }, [value.supplierName]);

  // Debounced catalog search as the user types.
  useEffect(() => {
    if (!tenantId) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.suppliers.list({
          search: inputValue.trim() || undefined,
          active: 1,
          tenant_id: tenantId,
          limit: 20,
        });
        setOptions(
          (res.suppliers || []).map((s: ApiSupplier) => ({ id: s.id, name: s.name })),
        );
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, tenantId]);

  // The currently-selected option object, so the Autocomplete renders a
  // controlled value rather than just echoing input text.
  const selectedOption = useMemo<SupplierOption | null>(() => {
    if (value.supplierId) {
      return { id: value.supplierId, name: value.supplierName };
    }
    if (value.supplierName) {
      // Verified free-typed name: represent as a plain (id-less) option so the
      // chip/check renders; unverified free text is held in inputValue.
      return value.verified ? { name: value.supplierName } : null;
    }
    return null;
  }, [value.supplierId, value.supplierName, value.verified]);

  const statusAdornment = showStatus
    ? value.verified && value.supplierName
      ? (
        <CheckCircleIcon color="success" fontSize="small" titleAccess="Supplier verified" />
      )
      : value.supplierName
        ? (
          <WarningAmberIcon color="warning" fontSize="small" titleAccess="Supplier not verified" />
        )
        : null
    : null;

  return (
    <Box>
      <Autocomplete<SupplierOption, false, false, true>
        freeSolo
        size={size}
        disabled={disabled}
        options={options}
        loading={loading}
        value={selectedOption}
        inputValue={inputValue}
        // Treat option objects and the synthetic create row sanely.
        getOptionLabel={(opt) =>
          typeof opt === 'string' ? opt : opt.create ? (opt.inputValue ?? '') : opt.name
        }
        isOptionEqualToValue={(opt, val) =>
          typeof opt !== 'string' &&
          typeof val !== 'string' &&
          (opt.id ? opt.id === val.id : opt.name === val.name)
        }
        filterOptions={(opts, params) => {
          const filtered = filter(opts, params);
          const typed = params.inputValue.trim();
          // Offer a "Create '<name>'" affordance when the typed value doesn't
          // exactly match an existing option (case-insensitive).
          const exists = opts.some(
            (o) => o.name.toLowerCase() === typed.toLowerCase(),
          );
          if (typed && !exists) {
            filtered.push({
              name: typed,
              create: true,
              inputValue: typed,
            });
          }
          return filtered;
        }}
        onInputChange={(_e, newInput, reason) => {
          setInputValue(newInput);
          // While the user is typing, the value is an UNVERIFIED free name.
          if (reason === 'input') {
            onChange({ supplierName: newInput, verified: false });
          }
          if (reason === 'clear') {
            onChange({ supplierName: '', verified: false });
          }
        }}
        onChange={(_e, picked) => {
          if (picked == null) {
            onChange({ supplierName: '', verified: false });
            return;
          }
          if (typeof picked === 'string') {
            // Raw freeSolo string (e.g. Enter on typed text) — unverified.
            onChange({ supplierName: picked, verified: false });
            return;
          }
          if (picked.create) {
            // User explicitly confirmed creating a new name → verified.
            const name = picked.inputValue ?? picked.name;
            setInputValue(name);
            onChange({ supplierName: name, verified: true });
            return;
          }
          // Existing supplier selected → verified with id.
          setInputValue(picked.name);
          onChange({ supplierId: picked.id, supplierName: picked.name, verified: true });
        }}
        renderOption={(props, opt) => (
          <li {...props} key={opt.create ? `__create__${opt.inputValue}` : opt.id ?? opt.name}>
            {opt.create ? (
              <Typography component="span">
                Create &ldquo;<strong>{opt.inputValue}</strong>&rdquo;
              </Typography>
            ) : (
              opt.name
            )}
          </li>
        )}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder="Search or type a supplier name"
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {loading ? <CircularProgress color="inherit" size={16} /> : null}
                  {statusAdornment}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />
      {showStatus && value.supplierName && !value.verified && (
        <Chip
          label="Unverified — select an existing supplier or confirm creating this name"
          color="warning"
          size="small"
          variant="outlined"
          sx={{ mt: 0.5 }}
        />
      )}
    </Box>
  );
}
