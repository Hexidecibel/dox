/**
 * KanbanView — board layout for a Records sheet, grouped by a
 * dropdown_single column.
 *
 * Behavior:
 *   - Columns are the options of the chosen grouping column. An extra
 *     "(empty)" column collects rows whose value is null/empty.
 *   - Cards show the row's title (large) plus 2-3 secondary cells
 *     picked the same way the mobile card does. Attachment count and
 *     entity-ref chips are surfaced inline so a reviewer can scan a
 *     column at a glance.
 *   - Drag-and-drop is HTML5 native: the dragged row's id rides on
 *     `dataTransfer`, the drop target column resolves the target option
 *     value, and we reuse the parent's `onPatchCell` so the optimistic
 *     update + audit trail + WebSocket fanout are identical to a click
 *     edit. No third-party DnD library; the spec's bundle-weight
 *     constraint matters.
 *   - "+ Add card" pre-sets the grouping column's value via the parent
 *     `onAddRow(initialData)` hook, then opens the row drawer.
 *
 * Mobile (<= 768px):
 *   - Columns become full-width vertical sections (no horizontal scroll
 *     between boards). Each section has the column header + scrollable
 *     stack of cards. This is simpler than swipe-paging for v1 and
 *     keeps the system shape obvious on small screens.
 *   - Drag-and-drop is disabled on touch (HTML5 DnD is unreliable on
 *     mobile browsers without polyfills). Tapping a card still opens
 *     the drawer; the user can change status from the drawer.
 *
 * Aesthetic:
 *   - Tinted bar at the top of each column matches the option's
 *     palette index (DROPDOWN_PALETTE) so a Kanban view of "Status"
 *     reads like the same column as in the Grid view's chips.
 */

import { useMemo, useState } from 'react';
import {
  Box,
  Card,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Add as AddIcon,
  AttachFile as AttachFileIcon,
  DragIndicator as DragHandleIcon,
} from '@mui/icons-material';
import { CellRenderer } from './CellRenderer';
import {
  DROPDOWN_PALETTE,
  dropdownOptions,
  paletteForOption,
  pickMobileSecondaryColumns,
} from './cellHelpers';
import type {
  ApiRecordColumn,
  ApiRecordRow,
  RecordColumnDropdownOption,
  RecordRowData,
} from '../../../shared/types';
import { EmptyState } from '../EmptyState';

const EMPTY_COLUMN_VALUE = '__empty__';

interface KanbanViewProps {
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  canMutate: boolean;
  /** The user-chosen grouping column key (URL-controlled); null = auto. */
  groupColumnKey: string | null;
  onChangeGroupColumn: (key: string | null) => void;
  onPatchCell: (rowId: string, columnKey: string, value: unknown) => Promise<void>;
  onOpenRow: (row: ApiRecordRow) => void;
  /** Add a row pre-populated with `{ [groupColumnKey]: optionValue }`. */
  onAddRow: (initialData?: RecordRowData) => void;
}

export function KanbanView({
  columns,
  rows,
  rowData,
  canMutate,
  groupColumnKey,
  onChangeGroupColumn,
  onPatchCell,
  onOpenRow,
  onAddRow,
}: KanbanViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const dropdownColumns = useMemo(
    () => columns.filter((c) => c.archived === 0 && c.type === 'dropdown_single'),
    [columns],
  );

  // Resolve the active grouping column: explicit key first, then a
  // smart default (a column literally named "Status"), then the first
  // dropdown_single, else null.
  const activeGroupCol = useMemo(() => {
    if (groupColumnKey) {
      return dropdownColumns.find((c) => c.key === groupColumnKey) ?? null;
    }
    const named = dropdownColumns.find((c) => c.label.toLowerCase() === 'status');
    return named ?? dropdownColumns[0] ?? null;
  }, [dropdownColumns, groupColumnKey]);

  const titleCol = useMemo(
    () => columns.find((c) => c.is_title === 1) ?? columns[0],
    [columns],
  );

  // Secondary columns to surface on cards. Pick the same way mobile
  // cards do but exclude the grouping column itself (it's redundant
  // with the column the card is in).
  const secondaryCols = useMemo(() => {
    if (!activeGroupCol) return pickMobileSecondaryColumns(columns, 3);
    const remaining = columns.filter(
      (c) => c.archived === 0 && c.key !== activeGroupCol.key && c.is_title !== 1,
    );
    return pickMobileSecondaryColumns(remaining, 3);
  }, [columns, activeGroupCol]);

  if (dropdownColumns.length === 0) {
    return (
      <EmptyState
        title="Add a dropdown column to enable Kanban"
        description="Kanban groups rows by a dropdown column's options. Add a column with type 'Single-select dropdown' from the Grid view, then come back."
      />
    );
  }
  if (!activeGroupCol) return null;

  const options = dropdownOptions(activeGroupCol);
  const groups = buildGroups(activeGroupCol, options, rows, rowData);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          mb: 2,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="kanban-group-by-label">Group by</InputLabel>
          <Select
            labelId="kanban-group-by-label"
            value={activeGroupCol.key}
            label="Group by"
            onChange={(e) => onChangeGroupColumn(e.target.value || null)}
          >
            {dropdownColumns.map((c) => (
              <MenuItem key={c.id} value={c.key}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Typography variant="body2" color="text.secondary">
          {rows.length} {rows.length === 1 ? 'card' : 'cards'} across {groups.length} {groups.length === 1 ? 'column' : 'columns'}
        </Typography>
      </Box>

      {/* Board */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          ...(isMobile
            ? {
                overflowY: 'auto',
                overflowX: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                pb: 11, // room for the FAB
                position: 'relative',
              }
            : {
                overflowX: 'auto',
                overflowY: 'hidden',
                display: 'flex',
                gap: 2,
                pb: 1,
                scrollbarWidth: 'thin',
              }),
        }}
      >
        {groups.map((group) => (
          <KanbanColumn
            key={group.value}
            group={group}
            titleCol={titleCol}
            secondaryCols={secondaryCols}
            rowData={rowData}
            canMutate={canMutate}
            isMobile={isMobile}
            onOpenRow={onOpenRow}
            onAddCard={() => {
              if (group.value === EMPTY_COLUMN_VALUE) {
                onAddRow({});
              } else {
                onAddRow({ [activeGroupCol.key]: group.value });
              }
            }}
            onDropRow={async (rowId) => {
              const newValue = group.value === EMPTY_COLUMN_VALUE ? null : group.value;
              await onPatchCell(rowId, activeGroupCol.key, newValue);
            }}
          />
        ))}
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------
// Column
// ----------------------------------------------------------------------

interface KanbanGroup {
  /** Option value, or EMPTY_COLUMN_VALUE for the no-value bucket. */
  value: string;
  label: string;
  paletteIndex: number;
  rows: ApiRecordRow[];
}

interface KanbanColumnProps {
  group: KanbanGroup;
  titleCol: ApiRecordColumn | undefined;
  secondaryCols: ApiRecordColumn[];
  rowData: Record<string, RecordRowData>;
  canMutate: boolean;
  isMobile: boolean;
  onOpenRow: (row: ApiRecordRow) => void;
  onAddCard: () => void;
  onDropRow: (rowId: string) => Promise<void>;
}

function KanbanColumn({
  group,
  titleCol,
  secondaryCols,
  rowData,
  canMutate,
  isMobile,
  onOpenRow,
  onAddCard,
  onDropRow,
}: KanbanColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const palette =
    group.value === EMPTY_COLUMN_VALUE
      ? { bg: 'rgba(0,0,0,0.04)', fg: '#555', border: 'rgba(0,0,0,0.08)' }
      : paletteForOption(group.paletteIndex);

  const COLUMN_WIDTH = 300;

  return (
    <Box
      onDragOver={
        canMutate && !isMobile
          ? (e) => {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={
        canMutate && !isMobile
          ? () => {
              if (dragOver) setDragOver(false);
            }
          : undefined
      }
      onDrop={
        canMutate && !isMobile
          ? async (e) => {
              e.preventDefault();
              setDragOver(false);
              const rowId = e.dataTransfer.getData('text/x-record-row-id');
              if (!rowId) return;
              await onDropRow(rowId);
            }
          : undefined
      }
      sx={{
        flexShrink: 0,
        width: isMobile ? '100%' : COLUMN_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: dragOver ? 'primary.main' : 'divider',
        transition: 'border-color 120ms ease, background-color 120ms ease',
        ...(dragOver && { bgcolor: 'rgba(26, 54, 93, 0.04)' }),
        maxHeight: isMobile ? undefined : '100%',
        overflow: 'hidden',
      }}
    >
      {/* Tinted header bar */}
      <Box
        sx={{
          height: 4,
          bgcolor: palette.fg,
          opacity: 0.6,
          flexShrink: 0,
        }}
      />
      {/* Header */}
      <Box
        sx={{
          px: 2,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexShrink: 0,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: group.value === EMPTY_COLUMN_VALUE ? 'text.secondary' : 'text.primary',
            fontStyle: group.value === EMPTY_COLUMN_VALUE ? 'italic' : 'normal',
          }}
        >
          {group.label}
        </Typography>
        <Chip
          label={group.rows.length}
          size="small"
          sx={{
            height: 22,
            fontSize: '0.75rem',
            fontWeight: 600,
            bgcolor: palette.bg,
            color: palette.fg,
            border: `1px solid ${palette.border}`,
          }}
        />
        {canMutate && (
          <IconButton
            size="small"
            onClick={onAddCard}
            aria-label={`Add card to ${group.label}`}
            sx={{ minWidth: 32, minHeight: 32, color: 'text.secondary' }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        )}
      </Box>

      {/* Cards */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          px: 1.25,
          py: 1.25,
          scrollbarWidth: 'thin',
        }}
      >
        {group.rows.length === 0 ? (
          <Box
            sx={{
              border: '1px dashed',
              borderColor: 'divider',
              borderRadius: 1,
              py: 4,
              px: 2,
              textAlign: 'center',
              color: 'text.disabled',
              fontSize: '0.8125rem',
            }}
          >
            {canMutate ? 'Drop a card here' : 'No cards'}
          </Box>
        ) : (
          <Stack spacing={1.25}>
            {group.rows.map((row) => (
              <KanbanCard
                key={row.id}
                row={row}
                titleCol={titleCol}
                secondaryCols={secondaryCols}
                data={rowData[row.id] ?? {}}
                canDrag={canMutate && !isMobile}
                onOpen={() => onOpenRow(row)}
              />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------

interface KanbanCardProps {
  row: ApiRecordRow;
  titleCol: ApiRecordColumn | undefined;
  secondaryCols: ApiRecordColumn[];
  data: RecordRowData;
  canDrag: boolean;
  onOpen: () => void;
}

function KanbanCard({ row, titleCol, secondaryCols, data, canDrag, onOpen }: KanbanCardProps) {
  const [dragging, setDragging] = useState(false);

  const titleText =
    row.display_title ??
    (titleCol && typeof data[titleCol.key] === 'string' ? (data[titleCol.key] as string) : '') ??
    'Untitled';

  return (
    <Card
      elevation={0}
      variant="outlined"
      draggable={canDrag}
      onDragStart={
        canDrag
          ? (e) => {
              e.dataTransfer.setData('text/x-record-row-id', row.id);
              e.dataTransfer.effectAllowed = 'move';
              setDragging(true);
            }
          : undefined
      }
      onDragEnd={canDrag ? () => setDragging(false) : undefined}
      onClick={onOpen}
      sx={{
        position: 'relative',
        p: 1.5,
        bgcolor: 'background.paper',
        cursor: canDrag ? 'grab' : 'pointer',
        opacity: dragging ? 0.4 : 1,
        transition: 'transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        minHeight: 64,
        '&:hover': {
          boxShadow: '0 4px 12px rgba(26, 54, 93, 0.10)',
          transform: 'translateY(-1px)',
        },
        '&:active': {
          cursor: canDrag ? 'grabbing' : 'pointer',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
        {canDrag && (
          <DragHandleIcon
            fontSize="small"
            sx={{
              color: 'text.disabled',
              opacity: 0.5,
              mt: 0.125,
              flexShrink: 0,
              fontSize: '1rem',
            }}
          />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              fontSize: '0.9375rem',
              lineHeight: 1.3,
              wordBreak: 'break-word',
              mb: secondaryCols.length > 0 ? 0.75 : 0,
            }}
          >
            {titleText || 'Untitled'}
          </Typography>
          {secondaryCols.length > 0 && (
            <Stack spacing={0.5}>
              {secondaryCols.map((col) => {
                const value = data[col.key];
                if (value == null || value === '') return null;
                return (
                  <Box
                    key={col.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.75,
                      fontSize: '0.8125rem',
                      color: 'text.secondary',
                      minWidth: 0,
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        fontSize: '0.6875rem',
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        fontWeight: 600,
                        flexShrink: 0,
                        minWidth: 56,
                        color: 'text.disabled',
                      }}
                    >
                      {col.label}
                    </Box>
                    <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                      <CellRenderer column={col} value={value} />
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          )}
          {row.attachment_count != null && row.attachment_count > 0 && (
            <Box
              sx={{
                mt: 1,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                color: 'text.secondary',
                fontSize: '0.75rem',
              }}
            >
              <AttachFileIcon sx={{ fontSize: '0.875rem' }} />
              {row.attachment_count}
            </Box>
          )}
        </Box>
      </Box>
    </Card>
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function buildGroups(
  groupCol: ApiRecordColumn,
  options: RecordColumnDropdownOption[],
  rows: ApiRecordRow[],
  rowData: Record<string, RecordRowData>,
): KanbanGroup[] {
  const groups: KanbanGroup[] = options.map((opt, i) => ({
    value: opt.value,
    label: opt.label ?? opt.value,
    paletteIndex: i % DROPDOWN_PALETTE.length,
    rows: [],
  }));
  // Empty bucket for null / unknown values.
  const emptyGroup: KanbanGroup = {
    value: EMPTY_COLUMN_VALUE,
    label: '(no value)',
    paletteIndex: 0,
    rows: [],
  };
  // For values that don't appear in the option list (e.g. allow_custom),
  // we still want a column. Track them dynamically.
  const extraByValue = new Map<string, KanbanGroup>();

  for (const row of rows) {
    const v = rowData[row.id]?.[groupCol.key];
    if (v == null || v === '') {
      emptyGroup.rows.push(row);
      continue;
    }
    const value = String(v);
    const known = groups.find((g) => g.value === value);
    if (known) {
      known.rows.push(row);
      continue;
    }
    let extra = extraByValue.get(value);
    if (!extra) {
      extra = {
        value,
        label: value,
        paletteIndex: (groups.length + extraByValue.size) % DROPDOWN_PALETTE.length,
        rows: [],
      };
      extraByValue.set(value, extra);
    }
    extra.rows.push(row);
  }

  // Always show declared option columns; show the empty bucket only if
  // it has rows or if there are no options at all.
  const result: KanbanGroup[] = [...groups, ...extraByValue.values()];
  if (emptyGroup.rows.length > 0 || result.length === 0) {
    result.push(emptyGroup);
  }
  return result;
}

/** Optional helper: kept around so SheetDetail can render an "add card" FAB on mobile without re-deriving the active column. */
export function getDefaultGroupColumnKey(columns: ApiRecordColumn[]): string | null {
  const dropdowns = columns.filter((c) => c.archived === 0 && c.type === 'dropdown_single');
  const named = dropdowns.find((c) => c.label.toLowerCase() === 'status');
  return (named ?? dropdowns[0])?.key ?? null;
}

export function isKanbanCapable(columns: ApiRecordColumn[]): boolean {
  return columns.some((c) => c.archived === 0 && c.type === 'dropdown_single');
}

// Re-exported for tests / future view-config integration.
export const KANBAN_EMPTY_COLUMN_VALUE = EMPTY_COLUMN_VALUE;
