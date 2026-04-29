/**
 * CellEditor — the in-place editor for a single cell. Used in two
 * contexts:
 *   - Desktop grid: tight, autoFocus, blur=commit, Enter=commit, Esc=cancel.
 *   - Row drawer / mobile full-screen modal: full-width, multi-line where
 *     appropriate; commit on blur (consistent with grid).
 *
 * Entity-ref cells render a chip + "change" button — picker opens a
 * separate Dialog. Dropdowns render a select. Date renders a native date
 * input (Phase 1; the Typeform-style mobile bottom sheet is a future
 * polish pass).
 *
 * The editor never PATCHes itself — it lifts the new value to the parent
 * via `onCommit(value)`, which is responsible for the optimistic update +
 * REST call. Keeping IO out of this component means it stays trivially
 * testable and the grid can swap renderers without re-wiring optimistic
 * state.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { Edit as EditIcon } from '@mui/icons-material';
import { dropdownOptions, parseConfig, refLabel } from './cellHelpers';
import { EntityChip } from './EntityChip';
import { EntityPicker, type EntityOption } from './EntityPicker';
import type { ApiRecordColumn, RecordColumnDateConfig } from '../../../shared/types';

interface CellEditorProps {
  column: ApiRecordColumn;
  value: unknown;
  /** True when rendered as a form field (drawer / modal); false in grid. */
  spacious?: boolean;
  tenantId: string | null;
  /** Fires when the user has settled on a new value. Parent does the IO. */
  onCommit: (value: unknown) => void;
  /** Optional cancel hook (Esc on grid, close button on modal). */
  onCancel?: () => void;
  /** Optional flag to autoFocus on mount (grid uses this; drawer doesn't). */
  autoFocus?: boolean;
  /** Mobile context — used to open EntityPicker fullscreen. */
  fullScreenPicker?: boolean;
}

export function CellEditor({
  column,
  value,
  spacious = false,
  tenantId,
  onCommit,
  onCancel,
  autoFocus = true,
  fullScreenPicker = false,
}: CellEditorProps) {
  // ============= Checkbox =============
  if (column.type === 'checkbox') {
    return (
      <Checkbox
        size={spacious ? 'medium' : 'small'}
        checked={!!value}
        onChange={(e) => onCommit(e.target.checked)}
        sx={spacious ? { ml: -1 } : { p: 0 }}
        autoFocus={autoFocus}
      />
    );
  }

  // ============= Dropdown single =============
  if (column.type === 'dropdown_single') {
    const opts = dropdownOptions(column);
    return (
      <Select
        autoFocus={autoFocus}
        // Use `defaultOpen` (uncontrolled) instead of `open` so MUI manages
        // open/close internally. With a controlled `open={true}` set at mount,
        // the cell-click that triggered mount leaks through to the menu's
        // backdrop listener and slams the menu shut before paint — the user
        // sees nothing happen. defaultOpen lets MUI attach its click-away
        // listener after the originating click has settled.
        defaultOpen={autoFocus}
        size={spacious ? 'medium' : 'small'}
        value={(typeof value === 'string' ? value : '') as string}
        onChange={(e) => onCommit(e.target.value)}
        onClose={() => onCancel?.()}
        fullWidth
        displayEmpty
        sx={
          spacious
            ? { minHeight: 48 }
            : {
                fontSize: '0.875rem',
                '& .MuiSelect-select': { py: 0.75 },
              }
        }
      >
        <MenuItem value="">
          <em style={{ color: 'rgba(0,0,0,0.4)' }}>None</em>
        </MenuItem>
        {opts.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label ?? o.value}
          </MenuItem>
        ))}
      </Select>
    );
  }

  // ============= Date / datetime =============
  if (column.type === 'date' || column.type === 'datetime') {
    const cfg = parseConfig(column) as RecordColumnDateConfig | undefined;
    const inputType = column.type === 'datetime' || cfg?.include_time ? 'datetime-local' : 'date';
    const initial = toDateInputValue(value, inputType);
    return (
      <DateInput
        autoFocus={autoFocus}
        spacious={spacious}
        type={inputType}
        defaultValue={initial}
        onCommit={(next) => onCommit(next)}
        onCancel={onCancel}
      />
    );
  }

  // ============= Entity refs =============
  if (
    column.type === 'supplier_ref' ||
    column.type === 'product_ref' ||
    column.type === 'customer_ref' ||
    column.type === 'document_ref' ||
    column.type === 'record_ref' ||
    column.type === 'contact'
  ) {
    return (
      <EntityRefEditor
        column={column}
        value={value}
        tenantId={tenantId}
        spacious={spacious}
        onCommit={onCommit}
        onCancel={onCancel}
        autoFocus={autoFocus}
        fullScreenPicker={fullScreenPicker}
      />
    );
  }

  // ============= Formula / rollup — read-only =============
  if (column.type === 'formula' || column.type === 'rollup') {
    return (
      <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
        {value == null || value === '' ? '—' : String(value)}
      </Typography>
    );
  }

  // ============= Number =============
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percent') {
    const initial = value == null ? '' : String(value);
    return (
      <TextInputCell
        type="number"
        autoFocus={autoFocus}
        spacious={spacious}
        defaultValue={initial}
        onCommit={(s) => {
          const trimmed = s.trim();
          if (trimmed === '') return onCommit(null);
          const n = Number(trimmed);
          onCommit(Number.isNaN(n) ? null : n);
        }}
        onCancel={onCancel}
        align="right"
      />
    );
  }

  // ============= Long text =============
  if (column.type === 'long_text') {
    const initial = typeof value === 'string' ? value : value == null ? '' : String(value);
    return (
      <TextInputCell
        autoFocus={autoFocus}
        spacious={spacious}
        defaultValue={initial}
        multiline
        onCommit={(s) => onCommit(s)}
        onCancel={onCancel}
      />
    );
  }

  // ============= Default text-ish =============
  const initial = typeof value === 'string' ? value : value == null ? '' : String(value);
  return (
    <TextInputCell
      autoFocus={autoFocus}
      spacious={spacious}
      defaultValue={initial}
      onCommit={(s) => onCommit(s)}
      onCancel={onCancel}
    />
  );
}

// ---------- helpers ----------

function toDateInputValue(value: unknown, inputType: 'date' | 'datetime-local'): string {
  if (value == null || value === '') return '';
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return '';
    date = parsed;
  } else {
    return '';
  }
  if (inputType === 'date') {
    return date.toISOString().slice(0, 10);
  }
  // datetime-local expects YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface TextInputCellProps {
  autoFocus: boolean;
  spacious: boolean;
  defaultValue: string;
  multiline?: boolean;
  type?: 'text' | 'number';
  align?: 'left' | 'right';
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

function TextInputCell({ autoFocus, spacious, defaultValue, multiline, type, align, onCommit, onCancel }: TextInputCellProps) {
  const [val, setVal] = useState(defaultValue);
  const committedRef = useRef(false);

  return (
    <TextField
      type={type ?? 'text'}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      autoFocus={autoFocus}
      multiline={multiline}
      minRows={multiline && spacious ? 3 : undefined}
      maxRows={multiline ? 8 : undefined}
      fullWidth
      size={spacious ? 'medium' : 'small'}
      variant={spacious ? 'outlined' : 'standard'}
      onBlur={() => {
        if (committedRef.current) return;
        committedRef.current = true;
        if (val !== defaultValue) onCommit(val);
        else onCancel?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !multiline) {
          e.preventDefault();
          committedRef.current = true;
          if (val !== defaultValue) onCommit(val);
          else onCancel?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = true;
          onCancel?.();
        }
      }}
      sx={{
        // Inline-grid editor needs an opaque backdrop so adjacent cell content
        // doesn't bleed through the focus ring. Drawer/modal already has its
        // own surface, but the styling here is harmless there.
        ...(!spacious && {
          position: 'relative',
          zIndex: 2,
          bgcolor: 'background.paper',
          boxShadow: 1,
        }),
        '& input': {
          minHeight: spacious ? 28 : undefined,
          textAlign: align ?? 'left',
          backgroundColor: 'background.paper',
        },
        '& textarea': {
          backgroundColor: 'background.paper',
        },
      }}
      InputProps={{
        sx: {
          minHeight: spacious ? 48 : undefined,
          backgroundColor: 'background.paper',
        },
      }}
    />
  );
}

function DateInput({
  autoFocus,
  spacious,
  type,
  defaultValue,
  onCommit,
  onCancel,
}: {
  autoFocus: boolean;
  spacious: boolean;
  type: 'date' | 'datetime-local';
  defaultValue: string;
  onCommit: (val: string | null) => void;
  onCancel?: () => void;
}) {
  const [val, setVal] = useState(defaultValue);
  const ref = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      // Kick off the native picker on supported browsers (Chromium).
      try {
        ref.current.showPicker?.();
      } catch {
        // Safari / older — fine, focus alone is enough.
      }
    }
  }, [autoFocus]);

  return (
    <TextField
      type={type}
      inputRef={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      fullWidth
      size={spacious ? 'medium' : 'small'}
      variant={spacious ? 'outlined' : 'standard'}
      onBlur={() => {
        if (committedRef.current) return;
        committedRef.current = true;
        if (val !== defaultValue) onCommit(val ? val : null);
        else onCancel?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          committedRef.current = true;
          if (val !== defaultValue) onCommit(val ? val : null);
          else onCancel?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = true;
          onCancel?.();
        }
      }}
      sx={
        !spacious
          ? {
              position: 'relative',
              zIndex: 2,
              bgcolor: 'background.paper',
              boxShadow: 1,
              '& input': { backgroundColor: 'background.paper' },
            }
          : undefined
      }
      InputProps={{
        sx: {
          minHeight: spacious ? 48 : undefined,
          backgroundColor: 'background.paper',
        },
      }}
    />
  );
}

function EntityRefEditor({
  column,
  value,
  tenantId,
  spacious,
  onCommit,
  onCancel,
  autoFocus,
  fullScreenPicker,
}: {
  column: ApiRecordColumn;
  value: unknown;
  tenantId: string | null;
  spacious: boolean;
  onCommit: (value: unknown) => void;
  onCancel?: () => void;
  autoFocus: boolean;
  fullScreenPicker: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(autoFocus);

  // Auto-open picker when this is the active in-place editor.
  useEffect(() => {
    if (autoFocus) setPickerOpen(true);
  }, [autoFocus]);

  // Resolve the current chip label.
  const single = Array.isArray(value) ? value[0] : value;
  const label = single ? refLabel(single) : null;

  const initialOption: EntityOption | null =
    single && typeof single === 'object' && (single as { id?: unknown }).id
      ? { id: String((single as { id: string }).id), name: label ?? '' }
      : null;

  const handleSelect = (opt: EntityOption | null) => {
    setPickerOpen(false);
    if (opt === null) {
      onCommit(null);
    } else {
      onCommit({ id: opt.id, name: opt.name });
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {label ? (
          <EntityChip type={column.type} label={label} />
        ) : (
          <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
            None
          </Typography>
        )}
      </Box>
      {spacious ? (
        <Button size="small" startIcon={<EditIcon />} onClick={() => setPickerOpen(true)}>
          {label ? 'Change' : 'Pick'}
        </Button>
      ) : (
        <IconButton size="small" onClick={() => setPickerOpen(true)} aria-label="Pick">
          <EditIcon fontSize="small" />
        </IconButton>
      )}
      <EntityPicker
        open={pickerOpen}
        type={column.type}
        tenantId={tenantId}
        initialValue={initialOption}
        onClose={() => {
          setPickerOpen(false);
          onCancel?.();
        }}
        onSelect={handleSelect}
        fullScreen={fullScreenPicker}
      />
    </Box>
  );
}
