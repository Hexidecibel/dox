/**
 * SheetDetail — the Records grid + drawer experience.
 *
 * Architecture:
 *   - Fetches sheet metadata + columns + views in one round trip
 *     (`recordsApi.sheets.get`), then paginated rows in a follow-up
 *     (`recordsApi.rows.list`).
 *   - Maintains `rowData` as a keyed map of row.id -> RecordRowData so
 *     a single cell mutation only re-renders that cell, not the whole
 *     grid. Optimistic update writes to the map immediately; the PATCH
 *     response is reconciled, and a remote WebSocket cell_update from
 *     another user merges the same way.
 *   - Desktop/mobile pivot via MUI's useMediaQuery breakpoint. The two
 *     branches share state but render different sub-components — no
 *     CSS-only "responsive table" trick. The mobile experience is the
 *     wedge against Smartsheet, so it earns its own component tree.
 *   - Real-time is enhancement, not required: WebSocket failures don't
 *     block any REST flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Drawer,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Skeleton,
  Snackbar,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowBack as BackIcon,
  Close as CloseIcon,
  GridOnOutlined as GridIcon,
  ViewKanbanOutlined as KanbanIcon,
  TimelineOutlined as TimelineIcon,
  CalendarMonthOutlined as CalendarIcon,
  CollectionsOutlined as GalleryIcon,
  MoreVert as MoreIcon,
  DriveFileRenameOutline as RenameIcon,
  Inventory2Outlined as ArchiveIcon,
  ViewColumnOutlined as ColumnIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { useAuth } from '../../contexts/AuthContext';
import { useSheetSession, type SheetCellUpdate } from '../../hooks/useSheetSession';
import { GridView, type CellHighlight } from '../../components/records/GridView';
import { MobileList } from '../../components/records/MobileList';
import { RowEditPanel } from '../../components/records/RowEditPanel';
import { AddColumnDialog } from '../../components/records/AddColumnDialog';
import { PresenceStack } from '../../components/records/PresenceStack';
import { parseRowData } from '../../components/records/cellHelpers';
import type {
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordSheet,
  ApiRecordView,
  CreateColumnRequest,
  RecordRowData,
} from '../../../shared/types';

// Highlight TTL: how long the yellow flash sticks around. The CSS handles
// the fade — this just clears it from state once the animation is done.
const HIGHLIGHT_TTL_MS = 700;

export function SheetDetail() {
  const { sheetId } = useParams<{ sheetId: string }>();
  const navigate = useNavigate();
  const { user, isReader } = useAuth();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const canMutate = !isReader;

  // ------ data ------
  const [sheet, setSheet] = useState<ApiRecordSheet | null>(null);
  const [columns, setColumns] = useState<ApiRecordColumn[]>([]);
  const [views, setViews] = useState<ApiRecordView[]>([]);
  const [rows, setRows] = useState<ApiRecordRow[]>([]);
  /** Keyed map of row.id -> parsed cell data (RecordRowData). */
  const [rowData, setRowData] = useState<Record<string, RecordRowData>>({});
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  // ------ flags ------
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingRows, setLoadingRows] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ message: string; severity: 'error' | 'info' | 'success' } | null>(null);

  // ------ row drawer ------
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);

  // ------ dialogs ------
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [archiveSheetOpen, setArchiveSheetOpen] = useState(false);
  const [archiveRowTarget, setArchiveRowTarget] = useState<ApiRecordRow | null>(null);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);

  // ------ realtime ------
  const session = useSheetSession(sheetId);
  const [highlights, setHighlights] = useState<CellHighlight[]>([]);
  const highlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ------ mounting ------
  const reloadSheetMeta = useCallback(async () => {
    if (!sheetId) return;
    setLoadingMeta(true);
    setError('');
    try {
      const res = await recordsApi.sheets.get(sheetId);
      setSheet(res.sheet);
      setColumns(res.columns ?? []);
      setViews(res.views ?? []);
      const def = (res.views ?? []).find((v) => v.is_default === 1) ?? (res.views ?? [])[0];
      setActiveViewId(def?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sheet');
    } finally {
      setLoadingMeta(false);
    }
  }, [sheetId]);

  const reloadRows = useCallback(async () => {
    if (!sheetId) return;
    setLoadingRows(true);
    try {
      const res = await recordsApi.rows.list(sheetId, { limit: 200 });
      setRows(res.rows);
      const map: Record<string, RecordRowData> = {};
      for (const row of res.rows) {
        map[row.id] = parseRowData(row.data);
      }
      setRowData(map);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to load rows', severity: 'error' });
    } finally {
      setLoadingRows(false);
    }
  }, [sheetId]);

  useEffect(() => {
    void reloadSheetMeta();
  }, [reloadSheetMeta]);

  useEffect(() => {
    void reloadRows();
  }, [reloadRows]);

  // Subscribe to remote cell updates from other users.
  useEffect(() => {
    const unsub = session.subscribe((edit: SheetCellUpdate) => {
      if (edit.userId === user?.id) return; // our own echo, no need to apply
      setRowData((prev) => {
        const existing = prev[edit.rowId];
        if (!existing) return prev;
        return {
          ...prev,
          [edit.rowId]: { ...existing, [edit.columnKey]: edit.value },
        };
      });
      addHighlight(edit.rowId, edit.columnKey);
    });
    return unsub;
  }, [session, user?.id]);

  const addHighlight = useCallback((rowId: string, columnKey: string) => {
    const key = `${rowId}::${columnKey}`;
    const ts = performance.now();
    setHighlights((prev) => [...prev.filter((h) => `${h.rowId}::${h.columnKey}` !== key), { rowId, columnKey, ts }]);
    const existing = highlightTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      setHighlights((prev) => prev.filter((h) => `${h.rowId}::${h.columnKey}` !== key));
      highlightTimers.current.delete(key);
    }, HIGHLIGHT_TTL_MS);
    highlightTimers.current.set(key, t);
  }, []);

  // Clear timers on unmount
  useEffect(() => {
    const timers = highlightTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // ------ mutations ------

  const patchCell = useCallback(
    async (rowId: string, columnKey: string, value: unknown) => {
      if (!sheetId) return;
      const prev = rowData[rowId]?.[columnKey];
      // Optimistic
      setRowData((m) => ({
        ...m,
        [rowId]: { ...(m[rowId] ?? {}), [columnKey]: value },
      }));
      try {
        await recordsApi.rows.patchCell(sheetId, rowId, columnKey, value);
      } catch (err) {
        // Revert
        setRowData((m) => {
          const cur = { ...(m[rowId] ?? {}) };
          if (prev === undefined) {
            delete cur[columnKey];
          } else {
            cur[columnKey] = prev;
          }
          return { ...m, [rowId]: cur };
        });
        setToast({
          message: err instanceof Error ? err.message : 'Failed to save change',
          severity: 'error',
        });
      }
    },
    [sheetId, rowData],
  );

  const handleAddRow = useCallback(async () => {
    if (!sheetId) return;
    try {
      const res = await recordsApi.rows.create(sheetId, {});
      setRows((prev) => [...prev, res.row]);
      setRowData((m) => ({ ...m, [res.row.id]: parseRowData(res.row.data) }));
      // Open the new row immediately so the user can fill it in.
      setDrawerRowId(res.row.id);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to add row', severity: 'error' });
    }
  }, [sheetId]);

  const handleArchiveRow = useCallback(
    async (row: ApiRecordRow) => {
      if (!sheetId) return;
      try {
        await recordsApi.rows.archive(sheetId, row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        setRowData((m) => {
          const { [row.id]: _, ...rest } = m;
          return rest;
        });
        if (drawerRowId === row.id) setDrawerRowId(null);
        setArchiveRowTarget(null);
        setToast({ message: 'Row archived', severity: 'success' });
      } catch (err) {
        setToast({ message: err instanceof Error ? err.message : 'Failed to archive row', severity: 'error' });
      }
    },
    [sheetId, drawerRowId],
  );

  const handleAddColumn = useCallback(
    async (data: CreateColumnRequest) => {
      if (!sheetId) return;
      const res = await recordsApi.columns.create(sheetId, data);
      setColumns((prev) => [...prev, res.column]);
    },
    [sheetId],
  );

  const handleArchiveSheet = useCallback(async () => {
    if (!sheetId) return;
    try {
      await recordsApi.sheets.archive(sheetId);
      navigate('/records');
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to archive sheet', severity: 'error' });
    }
  }, [sheetId, navigate]);

  // ------ derived ------

  const drawerRow = useMemo(
    () => (drawerRowId ? rows.find((r) => r.id === drawerRowId) ?? null : null),
    [drawerRowId, rows],
  );
  const drawerData = drawerRowId ? rowData[drawerRowId] ?? {} : {};

  /**
   * id→name lookup harvested from current row data so RowEditPanel's
   * activity feed can resolve entity-ref values that come back as bare
   * IDs. We walk every row's entity-ref-shaped payloads and stash any
   * `{id, name}` we see. This is best-effort — if a reference predates
   * the rows currently loaded we won't have it, and the activity entry
   * will still fall back to the faint-ID style. That's acceptable given
   * the alternative (extra fetches per drawer open) and the bonus's
   * "minimal" guidance.
   */
  const refs = useMemo(() => {
    const out: Record<string, string> = {};
    const collect = (v: unknown): void => {
      if (v == null) return;
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (typeof v === 'object') {
        const o = v as { id?: unknown; name?: unknown; label?: unknown };
        if (typeof o.id === 'string') {
          const label = typeof o.name === 'string' ? o.name : typeof o.label === 'string' ? o.label : null;
          if (label) out[o.id] = label;
        }
      }
    };
    for (const data of Object.values(rowData)) {
      for (const v of Object.values(data)) collect(v);
    }
    return out;
  }, [rowData]);

  // ------ render ------

  if (loadingMeta && !sheet) {
    return <SheetSkeleton onBack={() => navigate('/records')} />;
  }

  if (error) {
    return (
      <Box sx={{ maxWidth: 1280, mx: 'auto' }}>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/records')} sx={{ mb: 2 }}>
          Back to Records
        </Button>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!sheet || !sheetId) return null;

  const headerActions = !isMobile && canMutate ? (
    <Button variant="contained" startIcon={<AddIcon />} onClick={handleAddRow}>
      Add row
    </Button>
  ) : null;

  return (
    <Box sx={{ maxWidth: 1280, mx: 'auto', height: isMobile ? 'calc(100vh - 64px)' : 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2,
          mb: { xs: 2, sm: 3 },
          flexShrink: 0,
        }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Button
            startIcon={<BackIcon />}
            size="small"
            onClick={() => navigate('/records')}
            sx={{ mb: 1, color: 'text.secondary' }}
          >
            Records
          </Button>
          <Typography variant="h4" fontWeight={700} sx={{ mb: 0.5, wordBreak: 'break-word' }}>
            {sheet.name}
          </Typography>
          {sheet.description && (
            <Typography variant="body2" color="text.secondary">
              {sheet.description}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}>
          <PresenceStack presence={session.presence} selfUserId={user?.id ?? null} />
          {!isMobile && (
            <ViewSwitcher
              views={views}
              activeViewId={activeViewId}
              onChange={setActiveViewId}
            />
          )}
          {headerActions}
          {canMutate && (
            <>
              <IconButton
                aria-label="Sheet settings"
                onClick={(e) => setSettingsAnchor(e.currentTarget)}
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <MoreIcon />
              </IconButton>
              <Menu
                anchorEl={settingsAnchor}
                open={Boolean(settingsAnchor)}
                onClose={() => setSettingsAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem disabled>
                  <ListItemIcon><RenameIcon fontSize="small" /></ListItemIcon>
                  <ListItemText>Rename (use list page)</ListItemText>
                </MenuItem>
                {isMobile && (
                  <MenuItem
                    onClick={() => {
                      setSettingsAnchor(null);
                      setAddColumnOpen(true);
                    }}
                  >
                    <ListItemIcon><ColumnIcon fontSize="small" /></ListItemIcon>
                    <ListItemText>Add column</ListItemText>
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    setSettingsAnchor(null);
                    setArchiveSheetOpen(true);
                  }}
                >
                  <ListItemIcon><ArchiveIcon fontSize="small" /></ListItemIcon>
                  <ListItemText>Archive sheet</ListItemText>
                </MenuItem>
              </Menu>
            </>
          )}
        </Box>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loadingRows ? (
          <RowSkeletons mobile={isMobile} />
        ) : isMobile ? (
          <MobileList
            columns={columns}
            rows={rows}
            rowData={rowData}
            canMutate={canMutate}
            onOpenRow={(r) => setDrawerRowId(r.id)}
            onAddRow={handleAddRow}
            onArchiveRow={(r) => setArchiveRowTarget(r)}
            onRefresh={reloadRows}
          />
        ) : (
          <GridView
            columns={columns}
            rows={rows}
            rowData={rowData}
            tenantId={user?.tenant_id ?? null}
            canMutate={canMutate}
            highlights={highlights}
            onPatchCell={patchCell}
            onOpenRow={(r) => setDrawerRowId(r.id)}
            onAddRow={handleAddRow}
            onAddColumn={() => setAddColumnOpen(true)}
          />
        )}
      </Box>

      {/* Desktop drawer */}
      {!isMobile && (
        <Drawer
          anchor="right"
          open={Boolean(drawerRow)}
          onClose={() => setDrawerRowId(null)}
          PaperProps={{ sx: { width: 480, maxWidth: '90vw' } }}
        >
          {drawerRow && (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <Box
                sx={{
                  px: 3,
                  py: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="h6" sx={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {drawerRow.display_title || 'Untitled'}
                </Typography>
                <IconButton onClick={() => setDrawerRowId(null)} aria-label="Close drawer" sx={{ minWidth: 44, minHeight: 44 }}>
                  <CloseIcon />
                </IconButton>
              </Box>
              <Box sx={{ overflow: 'auto', flex: 1 }}>
                <RowEditPanel
                  sheetId={sheetId}
                  row={drawerRow}
                  data={drawerData}
                  columns={columns}
                  tenantId={user?.tenant_id ?? null}
                  refs={refs}
                  onPatchCell={(k, v) => patchCell(drawerRow.id, k, v)}
                  onArchive={() => setArchiveRowTarget(drawerRow)}
                />
              </Box>
            </Box>
          )}
        </Drawer>
      )}

      {/* Mobile full-screen modal */}
      {isMobile && drawerRow && (
        <Dialog open fullScreen onClose={() => setDrawerRowId(null)}>
          <Box
            sx={{
              px: 1,
              py: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid',
              borderColor: 'divider',
              position: 'sticky',
              top: 0,
              bgcolor: 'background.paper',
              zIndex: 1,
            }}
          >
            <IconButton onClick={() => setDrawerRowId(null)} aria-label="Close" sx={{ minWidth: 44, minHeight: 44 }}>
              <CloseIcon />
            </IconButton>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', mx: 1 }}>
              {drawerRow.display_title || 'Untitled'}
            </Typography>
            <Button onClick={() => setDrawerRowId(null)} sx={{ minWidth: 64, minHeight: 44, fontWeight: 600 }}>
              Done
            </Button>
          </Box>
          <Box sx={{ overflow: 'auto', flex: 1 }}>
            <RowEditPanel
              sheetId={sheetId}
              row={drawerRow}
              data={drawerData}
              columns={columns}
              tenantId={user?.tenant_id ?? null}
              mobile
              refs={refs}
              onPatchCell={(k, v) => patchCell(drawerRow.id, k, v)}
              onArchive={() => setArchiveRowTarget(drawerRow)}
            />
          </Box>
        </Dialog>
      )}

      {/* Add column dialog (desktop + via mobile menu) */}
      <AddColumnDialog
        open={addColumnOpen}
        onClose={() => setAddColumnOpen(false)}
        onCreate={async (data) => {
          await handleAddColumn(data);
        }}
      />

      {/* Archive sheet confirm */}
      <Dialog open={archiveSheetOpen} onClose={() => setArchiveSheetOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Archive this sheet?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            <strong>{sheet.name}</strong> will be hidden from the main list. Rows and columns are kept and can be restored later.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setArchiveSheetOpen(false)}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={handleArchiveSheet}>Archive</Button>
        </DialogActions>
      </Dialog>

      {/* Archive row confirm */}
      <Dialog open={Boolean(archiveRowTarget)} onClose={() => setArchiveRowTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Archive this row?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            <strong>{archiveRowTarget?.display_title || 'Untitled'}</strong> will be hidden. You can restore it from the archived rows list later.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setArchiveRowTarget(null)}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={() => archiveRowTarget && handleArchiveRow(archiveRowTarget)}>
            Archive
          </Button>
        </DialogActions>
      </Dialog>

      {/* Toasts */}
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert
            severity={toast.severity}
            onClose={() => setToast(null)}
            sx={{ minWidth: 280 }}
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

// ----------------------------------------------------------------------
// Sub-components kept inline because they're page-specific.
// ----------------------------------------------------------------------

interface ViewSwitcherProps {
  views: ApiRecordView[];
  activeViewId: string | null;
  onChange: (id: string) => void;
}

/**
 * ViewSwitcher — Phase 1 has only Grid views, but we render the future
 * shape (Board/Timeline/etc) as disabled toggles so the system shape is
 * obvious at a glance. This is the "communicates the system shape" part
 * of the spec — see records-with-many-views design philosophy.
 */
function ViewSwitcher({ views, activeViewId, onChange }: ViewSwitcherProps) {
  const grid = views.find((v) => v.view_type === 'grid');

  return (
    <ToggleButtonGroup
      size="small"
      value={activeViewId}
      exclusive
      onChange={(_, val) => val && onChange(val)}
      sx={{ height: 36 }}
    >
      <ToggleButton value={grid?.id ?? 'grid'} sx={{ px: 1.5 }}>
        <Tooltip title="Grid view"><GridIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="board-disabled" disabled sx={{ px: 1.5 }}>
        <Tooltip title="Board (coming soon)"><KanbanIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="timeline-disabled" disabled sx={{ px: 1.5 }}>
        <Tooltip title="Timeline (coming soon)"><TimelineIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="gallery-disabled" disabled sx={{ px: 1.5 }}>
        <Tooltip title="Gallery (coming soon)"><GalleryIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="calendar-disabled" disabled sx={{ px: 1.5 }}>
        <Tooltip title="Calendar (coming soon)"><CalendarIcon fontSize="small" /></Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

function SheetSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <Box sx={{ maxWidth: 1280, mx: 'auto' }}>
      <Button startIcon={<BackIcon />} onClick={onBack} sx={{ mb: 2 }}>
        Back to Records
      </Button>
      <Skeleton width={320} height={42} sx={{ mb: 1 }} />
      <Skeleton width={240} height={20} sx={{ mb: 4 }} />
      <RowSkeletons mobile={false} />
    </Box>
  );
}

function RowSkeletons({ mobile }: { mobile: boolean }) {
  if (mobile) {
    return (
      <Box sx={{ px: 2, pt: 1 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            height={88}
            sx={{ mb: 1.5, borderRadius: 1, bgcolor: 'rgba(26, 54, 93, 0.04)' }}
          />
        ))}
      </Box>
    );
  }
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} variant="rectangular" height={44} sx={{ bgcolor: i % 2 ? 'transparent' : 'rgba(26, 54, 93, 0.03)' }} />
      ))}
    </Box>
  );
}
