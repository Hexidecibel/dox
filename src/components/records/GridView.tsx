/**
 * GridView — desktop grid for a Records sheet.
 *
 * Layout decisions:
 *   - Plain HTML <table> rather than MUI DataGrid: we need full control
 *     over per-cell editor swap, click semantics, and sticky columns,
 *     and DataGrid's editing model is row-centric. The table uses CSS
 *     position:sticky for header + first column.
 *   - Cell click enters edit mode in place; row click (anywhere except
 *     a cell with text/number/date/dropdown) opens the drawer. We
 *     implement this by stopping propagation inside cell clicks AND
 *     short-circuiting row click when an editor is mounted.
 *   - Optimistic state lives in the parent (SheetDetail) so cross-cutting
 *     events (WebSocket fan-in) and row deletions resolve cleanly.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { Add as AddIcon, EditOutlined as EditOutlinedIcon } from '@mui/icons-material';
import { CellRenderer } from './CellRenderer';
import { CellEditor } from './CellEditor';
import type { ApiRecordColumn, ApiRecordRow, RecordRowData } from '../../../shared/types';

const ROW_HEIGHT = 44;
const TITLE_COL_WIDTH = 240;
const DEFAULT_COL_WIDTH = 180;
const ACTIONS_COL_WIDTH = 40;

export interface CellHighlight {
  rowId: string;
  columnKey: string;
  /** Performance.now() at moment of highlight. Used to age out the flash. */
  ts: number;
}

interface GridViewProps {
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  tenantId: string | null;
  canMutate: boolean;
  /** Recently-modified cells, used to flash the cell yellow briefly. */
  highlights: CellHighlight[];
  onPatchCell: (rowId: string, columnKey: string, value: unknown) => Promise<void>;
  onOpenRow: (row: ApiRecordRow) => void;
  onAddRow: () => void;
  onAddColumn: () => void;
}

export function GridView({
  columns,
  rows,
  rowData,
  tenantId,
  canMutate,
  highlights,
  onPatchCell,
  onOpenRow,
  onAddRow,
  onAddColumn,
}: GridViewProps) {
  const [activeCell, setActiveCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

  // Sort columns: title first, then display_order.
  const sortedColumns = [...columns]
    .filter((c) => c.archived === 0)
    .sort((a, b) => {
      if (a.is_title === 1 && b.is_title !== 1) return -1;
      if (b.is_title === 1 && a.is_title !== 1) return 1;
      return a.display_order - b.display_order;
    });

  const stickyEnabled = sortedColumns.length > 3;

  const handleCellClick = useCallback(
    (rowId: string, col: ApiRecordColumn, e: React.MouseEvent) => {
      if (!canMutate) return;
      if (col.type === 'formula' || col.type === 'rollup') return;
      e.stopPropagation();
      setActiveCell({ rowId, columnKey: col.key });
    },
    [canMutate],
  );

  const closeActiveCell = useCallback(() => setActiveCell(null), []);

  // Key handler at table level — make Esc close the active editor
  // even if focus left the input (e.g. picker dialog).
  useEffect(() => {
    if (!activeCell) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeActiveCell();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeCell, closeActiveCell]);

  if (rows.length === 0) {
    return (
      <Box
        sx={{
          py: 10,
          textAlign: 'center',
          border: '1px dashed',
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'background.default',
        }}
      >
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
          No rows yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Add your first row to start tracking.
        </Typography>
        {canMutate && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={onAddRow} size="large">
            Add the first row
          </Button>
        )}
      </Box>
    );
  }

  return (
    <Box
      ref={tableRef}
      sx={{
        position: 'relative',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
        overflow: 'auto',
        // Subtle scrollbar treatment so the grid doesn't feel like a bare textarea.
        scrollbarWidth: 'thin',
      }}
    >
      <Box
        component="table"
        sx={{
          width: 'max-content',
          minWidth: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          tableLayout: 'fixed',
          fontSize: '0.875rem',
        }}
      >
        <Box component="thead" sx={{ position: 'sticky', top: 0, zIndex: 3, bgcolor: 'background.paper' }}>
          <tr>
            {/* Leftmost actions column header — empty label, sticky-left when
                title col is also sticky so the affordance never scrolls away. */}
            <Box
              component="th"
              sx={{
                minWidth: ACTIONS_COL_WIDTH,
                width: ACTIONS_COL_WIDTH,
                p: 0,
                borderBottom: '1px solid',
                borderColor: 'divider',
                borderRight: '1px solid',
                borderRightColor: 'divider',
                bgcolor: 'background.paper',
                ...(stickyEnabled && {
                  position: 'sticky',
                  left: 0,
                  zIndex: 4,
                }),
              }}
              aria-label=""
            />
            {sortedColumns.map((col, i) => {
              const isTitleCol = i === 0 && stickyEnabled;
              return (
                <Box
                  key={col.id}
                  component="th"
                  sx={{
                    minWidth: isTitleCol ? TITLE_COL_WIDTH : (col.width ?? DEFAULT_COL_WIDTH),
                    width: isTitleCol ? TITLE_COL_WIDTH : (col.width ?? DEFAULT_COL_WIDTH),
                    px: 1.5,
                    py: 1,
                    textAlign: 'left',
                    fontWeight: 600,
                    color: 'text.secondary',
                    fontSize: '0.75rem',
                    textTransform: 'uppercase',
                    letterSpacing: 0.3,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    borderRight: '1px solid',
                    borderRightColor: 'divider',
                    bgcolor: 'background.paper',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    ...(isTitleCol && {
                      position: 'sticky',
                      left: ACTIONS_COL_WIDTH,
                      zIndex: 4,
                    }),
                  }}
                >
                  {col.label}
                </Box>
              );
            })}
            {/* +column header cell — clickable */}
            <Box
              component="th"
              sx={{
                minWidth: 80,
                width: 80,
                borderBottom: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                p: 0,
              }}
            >
              {canMutate && (
                <IconButton
                  size="small"
                  onClick={onAddColumn}
                  aria-label="Add column"
                  sx={{ mx: 0.5 }}
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
          </tr>
        </Box>
        <tbody>
          {rows.map((row) => {
            const data = rowData[row.id] ?? {};
            return (
              <Box
                key={row.id}
                component="tr"
                sx={{
                  cursor: 'pointer',
                  transition: 'background-color 120ms ease',
                  '&:hover td': {
                    bgcolor: 'action.hover',
                  },
                  // Brighten the leftmost edit-row icon on row hover so the
                  // affordance only obtrudes when the user is on the row.
                  '&:hover .row-edit-icon': {
                    opacity: 1,
                  },
                }}
                onClick={() => {
                  // Don't open the drawer if a cell editor is active —
                  // that click is going to the editor.
                  if (activeCell && activeCell.rowId === row.id) return;
                  onOpenRow(row);
                }}
              >
                {/* Leftmost actions cell — opens the row drawer. Whole-row
                    click still does the same thing; this is purely
                    discoverability. Stops propagation so nested click
                    doesn't double-fire (harmless but noisy). */}
                <Box
                  component="td"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenRow(row);
                  }}
                  sx={{
                    height: ROW_HEIGHT,
                    width: ACTIONS_COL_WIDTH,
                    minWidth: ACTIONS_COL_WIDTH,
                    p: 0,
                    textAlign: 'center',
                    verticalAlign: 'middle',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    borderRight: '1px solid',
                    borderRightColor: 'divider',
                    bgcolor: 'background.paper',
                    ...(stickyEnabled && {
                      position: 'sticky',
                      left: 0,
                      zIndex: 1,
                    }),
                  }}
                >
                  <IconButton
                    size="small"
                    aria-label="Open row"
                    className="row-edit-icon"
                    sx={{
                      minWidth: 40,
                      minHeight: 40,
                      color: 'text.secondary',
                      opacity: 0.4,
                      transition: 'opacity 120ms ease',
                    }}
                  >
                    <EditOutlinedIcon fontSize="small" />
                  </IconButton>
                </Box>
                {sortedColumns.map((col, i) => {
                  const isTitleCol = i === 0 && stickyEnabled;
                  const isActive = activeCell?.rowId === row.id && activeCell.columnKey === col.key;
                  const highlight = highlights.find(
                    (h) => h.rowId === row.id && h.columnKey === col.key,
                  );
                  return (
                    <Box
                      key={col.id}
                      component="td"
                      onClick={(e) => handleCellClick(row.id, col, e)}
                      sx={{
                        height: ROW_HEIGHT,
                        px: 1.5,
                        py: 0.5,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        borderRight: '1px solid',
                        borderRightColor: 'divider',
                        bgcolor: highlight ? 'rgba(255, 215, 0, 0.18)' : 'background.paper',
                        transition: 'background-color 600ms ease',
                        verticalAlign: 'middle',
                        position: 'relative',
                        overflow: 'hidden',
                        ...(isTitleCol && {
                          position: 'sticky',
                          left: ACTIONS_COL_WIDTH,
                          zIndex: 1,
                          fontWeight: 500,
                        }),
                        ...(isActive && {
                          outline: '2px solid',
                          outlineColor: 'primary.main',
                          outlineOffset: -2,
                          zIndex: 2,
                          bgcolor: 'background.paper',
                        }),
                      }}
                    >
                      {isActive ? (
                        <CellEditor
                          column={col}
                          value={data[col.key]}
                          tenantId={tenantId}
                          spacious={false}
                          autoFocus
                          onCommit={(value) => {
                            closeActiveCell();
                            void onPatchCell(row.id, col.key, value);
                          }}
                          onCancel={closeActiveCell}
                        />
                      ) : (
                        <CellRenderer column={col} value={data[col.key]} dense />
                      )}
                    </Box>
                  );
                })}
                {/* spacer to align with +col header */}
                <Box
                  component="td"
                  sx={{
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'background.paper',
                  }}
                />
              </Box>
            );
          })}
        </tbody>
      </Box>
    </Box>
  );
}
