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
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { KanbanView } from '../../components/records/KanbanView';
import { CalendarView } from '../../components/records/CalendarView';
import { TimelineView } from '../../components/records/TimelineView';
import { GalleryView } from '../../components/records/GalleryView';
import { MobileList } from '../../components/records/MobileList';
import { RowEditPanel } from '../../components/records/RowEditPanel';
import { AddColumnDialog } from '../../components/records/AddColumnDialog';
import { EditColumnDialog } from '../../components/records/EditColumnDialog';
import { PresenceStack } from '../../components/records/PresenceStack';
import { FormsTab } from '../../components/records/FormsTab';
import { WorkflowsTab } from '../../components/records/WorkflowsTab';
import { parseRowData } from '../../components/records/cellHelpers';
import type {
  AnyRecordViewType,
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordSheet,
  ApiRecordView,
  CreateColumnRequest,
  RecordRowData,
  TimelineScale,
  UpdateColumnRequest,
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

  // ------ active view (URL-controlled) ------
  // The active view + per-view config are held in the URL so links are
  // shareable. Persisting the user's last-used view to records_views is
  // deferred — see plan.md and the AnyRecordViewType comment in
  // shared/types.ts. Slice 3b lights up Timeline + Gallery alongside the
  // existing Grid / Kanban / Calendar.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView: AnyRecordViewType = ((): AnyRecordViewType => {
    const v = searchParams.get('view');
    if (v === 'kanban' || v === 'calendar' || v === 'timeline' || v === 'gallery') return v;
    return 'grid';
  })();
  const groupColumnKey = searchParams.get('group');
  const dateColumnKey = searchParams.get('date');
  // Timeline-specific zoom level. Defaults to 'month' since that's the
  // most common "what's on the schedule this quarter" lens.
  const timelineScale: TimelineScale = ((): TimelineScale => {
    const v = searchParams.get('scale');
    if (v === 'day' || v === 'week' || v === 'month' || v === 'quarter') return v;
    return 'month';
  })();
  // Gallery-specific sort + filter knobs.
  const gallerySortKey = searchParams.get('sort');
  const gallerySortDir: 'asc' | 'desc' = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const galleryPhotosOnly = searchParams.get('photos') === '1';

  const setActiveView = useCallback(
    (view: AnyRecordViewType) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (view === 'grid') next.delete('view');
          else next.set('view', view);
          // Don't clear `group`/`date` params — they're per-view and the
          // user may flip back. Browsers don't mind a stale param.
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setGroupColumnKey = useCallback(
    (key: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key) next.set('group', key);
          else next.delete('group');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setDateColumnKey = useCallback(
    (key: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key) next.set('date', key);
          else next.delete('date');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setTimelineScale = useCallback(
    (scale: TimelineScale) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Don't write the default — keeps URLs short for the common case.
          if (scale === 'month') next.delete('scale');
          else next.set('scale', scale);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setGallerySortKey = useCallback(
    (key: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key) next.set('sort', key);
          else next.delete('sort');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setGallerySortDir = useCallback(
    (dir: 'asc' | 'desc') => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (dir === 'desc') next.delete('dir');
          else next.set('dir', dir);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setGalleryPhotosOnly = useCallback(
    (v: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v) next.set('photos', '1');
          else next.delete('photos');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // ------ data ------
  const [sheet, setSheet] = useState<ApiRecordSheet | null>(null);
  const [columns, setColumns] = useState<ApiRecordColumn[]>([]);
  // `views` (records_views) is fetched but not yet read — view persistence
  // is a Slice 3b follow-up. We keep the fetch warm so the response stays
  // cached and we don't re-flight when persistence lands.
  const [, setViews] = useState<ApiRecordView[]>([]);
  const [rows, setRows] = useState<ApiRecordRow[]>([]);
  /** Keyed map of row.id -> parsed cell data (RecordRowData). */
  const [rowData, setRowData] = useState<Record<string, RecordRowData>>({});

  // ------ flags ------
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingRows, setLoadingRows] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ message: string; severity: 'error' | 'info' | 'success' } | null>(null);

  // ------ row drawer ------
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);

  // ------ dialogs ------
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [editColumnTarget, setEditColumnTarget] = useState<ApiRecordColumn | null>(null);
  const [archiveSheetOpen, setArchiveSheetOpen] = useState(false);
  const [archiveRowTarget, setArchiveRowTarget] = useState<ApiRecordRow | null>(null);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);

  // ------ tabs (Phase 2: Forms is a peer of the grid view; Phase 3: Workflows added) ------
  const initialTab = (() => {
    const t = searchParams.get('tab');
    if (t === 'forms' || t === 'workflows') return t;
    return 'data';
  })();
  const [activeTab, setActiveTab] = useState<'data' | 'forms' | 'workflows'>(initialTab);

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

  const handleAddRow = useCallback(
    async (initialData?: RecordRowData) => {
      if (!sheetId) return;
      try {
        const res = await recordsApi.rows.create(
          sheetId,
          initialData && Object.keys(initialData).length > 0 ? { data: initialData } : {},
        );
        setRows((prev) => [...prev, res.row]);
        setRowData((m) => ({ ...m, [res.row.id]: parseRowData(res.row.data) }));
        // Open the new row immediately so the user can fill it in.
        setDrawerRowId(res.row.id);
      } catch (err) {
        setToast({ message: err instanceof Error ? err.message : 'Failed to add row', severity: 'error' });
      }
    },
    [sheetId],
  );

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

  const handleUpdateColumn = useCallback(
    async (columnId: string, data: UpdateColumnRequest) => {
      if (!sheetId) return;
      const res = await recordsApi.columns.update(sheetId, columnId, data);
      // Replace the matching column in place. CellEditor / FormsTab read
      // column.config on each render so the new options propagate to all
      // dropdown cells without any further plumbing.
      setColumns((prev) => prev.map((c) => (c.id === columnId ? res.column : c)));
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
    <Button variant="contained" startIcon={<AddIcon />} onClick={() => handleAddRow()}>
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
            <ToggleButtonGroup
              size="small"
              value={activeTab}
              exclusive
              onChange={(_, val) => val && setActiveTab(val)}
              sx={{ height: 36 }}
              aria-label="Sheet section"
            >
              <ToggleButton value="data" sx={{ px: 1.5, fontWeight: 500 }}>
                Data
              </ToggleButton>
              <ToggleButton value="forms" sx={{ px: 1.5, fontWeight: 500 }}>
                Forms
              </ToggleButton>
              <ToggleButton value="workflows" sx={{ px: 1.5, fontWeight: 500 }}>
                Workflows
              </ToggleButton>
            </ToggleButtonGroup>
          )}
          {!isMobile && activeTab === 'data' && (
            <ViewSwitcher activeView={activeView} onChange={setActiveView} />
          )}
          {activeTab === 'data' && headerActions}
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

      {/* Mobile tab switcher (data/forms) */}
      {isMobile && (
        <Box sx={{ mb: 2, display: 'flex', flexShrink: 0 }}>
          <ToggleButtonGroup
            size="small"
            value={activeTab}
            exclusive
            onChange={(_, val) => val && setActiveTab(val)}
            fullWidth
            sx={{ width: '100%' }}
          >
            <ToggleButton value="data" sx={{ flex: 1, fontWeight: 500, minHeight: 44 }}>Data</ToggleButton>
            <ToggleButton value="forms" sx={{ flex: 1, fontWeight: 500, minHeight: 44 }}>Forms</ToggleButton>
            <ToggleButton value="workflows" sx={{ flex: 1, fontWeight: 500, minHeight: 44 }}>Workflows</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {/* Mobile view switcher (the desktop one lives in the header). */}
      {isMobile && activeTab === 'data' && (
        <Box sx={{ mb: 2, flexShrink: 0 }}>
          <MobileViewSwitcher activeView={activeView} onChange={setActiveView} />
        </Box>
      )}

      {/* Body */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {activeTab === 'forms' ? (
          <FormsTab sheetId={sheetId} canMutate={canMutate} />
        ) : activeTab === 'workflows' ? (
          <WorkflowsTab sheetId={sheetId} canMutate={canMutate} />
        ) : loadingRows ? (
          <RowSkeletons mobile={isMobile} />
        ) : activeView === 'kanban' ? (
          <KanbanView
            columns={columns}
            rows={rows}
            rowData={rowData}
            canMutate={canMutate}
            groupColumnKey={groupColumnKey}
            onChangeGroupColumn={setGroupColumnKey}
            onPatchCell={patchCell}
            onOpenRow={(r) => setDrawerRowId(r.id)}
            onAddRow={handleAddRow}
          />
        ) : activeView === 'calendar' ? (
          <CalendarView
            columns={columns}
            rows={rows}
            rowData={rowData}
            dateColumnKey={dateColumnKey}
            onChangeDateColumn={setDateColumnKey}
            onOpenRow={(r) => setDrawerRowId(r.id)}
          />
        ) : activeView === 'timeline' ? (
          <TimelineView
            columns={columns}
            rows={rows}
            rowData={rowData}
            dateColumnKey={dateColumnKey}
            onChangeDateColumn={setDateColumnKey}
            groupColumnKey={groupColumnKey}
            onChangeGroupColumn={setGroupColumnKey}
            scale={timelineScale}
            onChangeScale={setTimelineScale}
            onOpenRow={(r) => setDrawerRowId(r.id)}
          />
        ) : activeView === 'gallery' ? (
          <GalleryView
            sheetId={sheetId}
            columns={columns}
            rows={rows}
            rowData={rowData}
            sortColumnKey={gallerySortKey}
            onChangeSortColumn={setGallerySortKey}
            sortDir={gallerySortDir}
            onChangeSortDir={setGallerySortDir}
            photosOnly={galleryPhotosOnly}
            onChangePhotosOnly={setGalleryPhotosOnly}
            onOpenRow={(r) => setDrawerRowId(r.id)}
          />
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
            onEditColumn={(col) => setEditColumnTarget(col)}
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

      {/* Edit column dialog */}
      <EditColumnDialog
        open={Boolean(editColumnTarget)}
        column={editColumnTarget}
        onClose={() => setEditColumnTarget(null)}
        onSave={handleUpdateColumn}
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
  activeView: AnyRecordViewType;
  onChange: (view: AnyRecordViewType) => void;
}

/**
 * ViewSwitcher — flips between Grid / Kanban / Calendar / Timeline / Gallery.
 * State lives in the URL (`?view=...`) on the SheetDetail page so the
 * active lens is shareable. No persistence to records_views yet.
 */
function ViewSwitcher({ activeView, onChange }: ViewSwitcherProps) {
  return (
    <ToggleButtonGroup
      size="small"
      value={activeView}
      exclusive
      onChange={(_, val) => {
        if (
          val === 'grid' ||
          val === 'kanban' ||
          val === 'calendar' ||
          val === 'timeline' ||
          val === 'gallery'
        ) {
          onChange(val);
        }
      }}
      sx={{ height: 36 }}
      aria-label="View type"
    >
      <ToggleButton value="grid" sx={{ px: 1.5 }} aria-label="Grid view">
        <Tooltip title="Grid"><GridIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="kanban" sx={{ px: 1.5 }} aria-label="Kanban view">
        <Tooltip title="Kanban"><KanbanIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="calendar" sx={{ px: 1.5 }} aria-label="Calendar view">
        <Tooltip title="Calendar"><CalendarIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="timeline" sx={{ px: 1.5 }} aria-label="Timeline view">
        <Tooltip title="Timeline"><TimelineIcon fontSize="small" /></Tooltip>
      </ToggleButton>
      <ToggleButton value="gallery" sx={{ px: 1.5 }} aria-label="Gallery view">
        <Tooltip title="Gallery"><GalleryIcon fontSize="small" /></Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

/**
 * MobileViewSwitcher — same shape as the desktop ViewSwitcher but
 * scrollable horizontally so it fits next to the data tab on phones.
 * The toggle group itself wraps in a horizontally-scrollable box.
 */
function MobileViewSwitcher({
  activeView,
  onChange,
}: {
  activeView: AnyRecordViewType;
  onChange: (view: AnyRecordViewType) => void;
}) {
  return (
    <Box
      sx={{
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      <ToggleButtonGroup
        size="small"
        value={activeView}
        exclusive
        onChange={(_, val) => {
          if (
            val === 'grid' ||
            val === 'kanban' ||
            val === 'calendar' ||
            val === 'timeline' ||
            val === 'gallery'
          ) {
            onChange(val);
          }
        }}
        sx={{ height: 40 }}
        aria-label="View type"
      >
        <ToggleButton value="grid" sx={{ px: 2, minHeight: 40 }} aria-label="Grid view">
          <GridIcon fontSize="small" sx={{ mr: 0.75 }} /> Grid
        </ToggleButton>
        <ToggleButton value="kanban" sx={{ px: 2, minHeight: 40 }} aria-label="Kanban view">
          <KanbanIcon fontSize="small" sx={{ mr: 0.75 }} /> Kanban
        </ToggleButton>
        <ToggleButton value="calendar" sx={{ px: 2, minHeight: 40 }} aria-label="Calendar view">
          <CalendarIcon fontSize="small" sx={{ mr: 0.75 }} /> Calendar
        </ToggleButton>
        <ToggleButton value="timeline" sx={{ px: 2, minHeight: 40 }} aria-label="Timeline view">
          <TimelineIcon fontSize="small" sx={{ mr: 0.75 }} /> Timeline
        </ToggleButton>
        <ToggleButton value="gallery" sx={{ px: 2, minHeight: 40 }} aria-label="Gallery view">
          <GalleryIcon fontSize="small" sx={{ mr: 0.75 }} /> Gallery
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
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
