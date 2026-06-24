/**
 * Per-supplier lot-numbering scheme picker.
 *
 * Controls how a supplier's COA lot numbers are normalized into the match key
 * that COA and order lines collide on. Most suppliers stay on 'auto' (no
 * transform). Date-code suppliers (e.g. Country Morning Farms) append an item
 * code to a MMDDYY date on their COA lots while their WMS strips it to the bare
 * date — 'date_code' strips the trailing code so both sides key the same.
 */

import { FormControl, FormHelperText, InputLabel, MenuItem, Select } from '@mui/material';
import type { LotScheme } from '../lib/types';

interface SchemeOption {
  value: LotScheme;
  label: string;
  description: string;
}

export const LOT_SCHEME_OPTIONS: SchemeOption[] = [
  {
    value: 'auto',
    label: 'Auto (no transform)',
    description: 'Default. Lot numbers are keyed as-is (plus any extracted sublot). Use this unless you know the supplier mangles lots between COA and order.',
  },
  {
    value: 'date_code',
    label: 'Date + item code',
    description: 'COA lots are a MMDDYY date with a trailing item code (e.g. 061626WHO) but the order side carries only the bare date (061626). Strips the code so both sides match.',
  },
  {
    value: 'lims_combined',
    label: 'LIMS combined (lot + sublot)',
    description: 'Concatenate the base lot number with a normalized 2-digit sublot code. Only fires when sublots are extracted (e.g. Darigold).',
  },
  {
    value: 'plain',
    label: 'Plain (lot only)',
    description: 'Key on the lot number alone with no sublot concatenation and no code stripping.',
  },
];

interface Props {
  value: LotScheme;
  onChange: (value: LotScheme) => void;
  disabled?: boolean;
}

export default function LotSchemeSelect({ value, onChange, disabled = false }: Props) {
  const helper = LOT_SCHEME_OPTIONS.find((o) => o.value === value)?.description ?? '';
  return (
    <FormControl fullWidth size="small" disabled={disabled}>
      <InputLabel id="lot-scheme-label">Lot scheme</InputLabel>
      <Select
        labelId="lot-scheme-label"
        label="Lot scheme"
        value={value}
        onChange={(e) => onChange(e.target.value as LotScheme)}
      >
        {LOT_SCHEME_OPTIONS.map((opt) => (
          <MenuItem key={opt.value} value={opt.value}>
            {opt.label}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>{helper}</FormHelperText>
    </FormControl>
  );
}
