/**
 * CellRenderer — read-only display of a cell. The grid swaps in
 * <CellEditor /> once the user clicks; this component handles the
 * resting render. Kept thin so re-renders during fast scrolling are
 * cheap.
 */

import { Box, Tooltip, Typography, Checkbox } from '@mui/material';
import { dropdownOptions, formatCellValue, paletteForOption, refLabel } from './cellHelpers';
import { EntityChip } from './EntityChip';
import type { ApiRecordColumn, RecordColumnType } from '../../../shared/types';

interface CellRendererProps {
  column: ApiRecordColumn;
  value: unknown;
  /** When true, render in compact form for the dense desktop grid. */
  dense?: boolean;
}

const ENTITY_REF_TYPES: RecordColumnType[] = [
  'supplier_ref',
  'product_ref',
  'document_ref',
  'record_ref',
  'contact',
];

export function CellRenderer({ column, value, dense = true }: CellRendererProps) {
  if (column.type === 'checkbox') {
    return (
      <Checkbox
        size="small"
        checked={!!value}
        disabled
        sx={{ p: 0, '&.Mui-disabled': { color: value ? 'primary.main' : 'text.disabled' } }}
      />
    );
  }

  if (column.type === 'dropdown_single') {
    if (value == null || value === '') return <EmptyCell />;
    const opts = dropdownOptions(column);
    const optIndex = opts.findIndex((o) => o.value === value);
    const label = optIndex >= 0 ? (opts[optIndex].label ?? opts[optIndex].value) : String(value);
    const palette = paletteForOption(optIndex >= 0 ? optIndex : hashIndex(String(value)));
    return (
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          px: 1,
          py: 0.25,
          borderRadius: 999,
          bgcolor: palette.bg,
          color: palette.fg,
          border: `1px solid ${palette.border}`,
          fontSize: '0.8125rem',
          fontWeight: 500,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Box>
    );
  }

  if (ENTITY_REF_TYPES.includes(column.type)) {
    if (value == null || value === '') return <EmptyCell />;
    const items = Array.isArray(value) ? value : [value];
    return (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {items.map((item, i) => {
          const label = refLabel(item) ?? '—';
          return <EntityChip key={i} type={column.type} label={label} />;
        })}
      </Box>
    );
  }

  if (column.type === 'formula' || column.type === 'rollup') {
    const formatted = formatCellValue(column, value);
    if (!formatted) return <EmptyCell />;
    return (
      <Typography
        component="span"
        variant="body2"
        sx={{ fontStyle: 'italic', color: 'text.secondary', fontSize: '0.875rem' }}
      >
        {formatted}
      </Typography>
    );
  }

  if (column.type === 'long_text') {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (!text) return <EmptyCell />;
    return (
      <Tooltip title={text} placement="top-start" enterDelay={500}>
        <Typography
          component="span"
          variant="body2"
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: dense ? 1 : 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </Typography>
      </Tooltip>
    );
  }

  if (column.type === 'number' || column.type === 'currency' || column.type === 'percent') {
    const formatted = formatCellValue(column, value);
    if (!formatted) return <EmptyCell />;
    return (
      <Typography component="span" variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', display: 'block' }}>
        {formatted}
      </Typography>
    );
  }

  const formatted = formatCellValue(column, value);
  if (!formatted) return <EmptyCell />;
  return (
    <Typography component="span" variant="body2" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {formatted}
    </Typography>
  );
}

function EmptyCell() {
  return (
    <Typography component="span" variant="body2" color="text.disabled" sx={{ fontStyle: 'italic', fontSize: '0.875rem' }}>
      —
    </Typography>
  );
}

/** Stable index for free-form dropdown values that don't appear in the option list. */
function hashIndex(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
