/**
 * CalendarView — month grid that lays out records on a chosen date column.
 *
 * Behavior:
 *   - Month-view default. Header has month/year, prev/next, Today, plus
 *     a Week toggle (disabled with "coming soon" tooltip — Slice 3b).
 *   - The grid is a 6-row x 7-col layout filled with day cells. Days
 *     outside the visible month render with muted styling so the layout
 *     is always 42 cells (no jagged edges between months).
 *   - Records on a day appear as small palette-tinted chips. We show 2
 *     and collapse the rest into "+N more" — clicking that opens a
 *     popover with the remaining records for the day.
 *   - Click a chip → open the same drawer the Grid view uses.
 *   - Keyboard: ← / → switch months when the toolbar has focus; the
 *     visible-month label is the live region announcing the change.
 *   - Date math is done with native `Date` — first-of-month, weekday
 *     index, days-in-month — no third-party calendar library so the
 *     bundle stays light. All date comparisons happen on local-day
 *     boundaries so timezone fence-posting doesn't drop a record from
 *     "today" when the value parses as midnight UTC.
 *
 * Mobile (<= 768px):
 *   - Collapses to a list. Each day with records becomes a section with
 *     a sticky-ish date header and a stack of cards. "Today" anchors
 *     the scroll position. Empty days are omitted to save vertical
 *     real estate.
 *   - The month strip stays at the top; tapping prev/next swaps months.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Popover,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
} from '@mui/icons-material';
import type {
  ApiRecordColumn,
  ApiRecordRow,
  RecordRowData,
} from '../../../shared/types';
import { EmptyState } from '../EmptyState';

interface CalendarViewProps {
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  /** URL-controlled date column key; null = auto-pick. */
  dateColumnKey: string | null;
  onChangeDateColumn: (key: string | null) => void;
  onOpenRow: (row: ApiRecordRow) => void;
}

interface DayRecord {
  row: ApiRecordRow;
  /** ISO date string (yyyy-mm-dd, local) for the day this lands on. */
  iso: string;
  title: string;
}

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarView({
  columns,
  rows,
  rowData,
  dateColumnKey,
  onChangeDateColumn,
  onOpenRow,
}: CalendarViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const dateColumns = useMemo(
    () =>
      columns.filter(
        (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
      ),
    [columns],
  );
  const titleCol = useMemo(
    () => columns.find((c) => c.is_title === 1) ?? columns[0],
    [columns],
  );

  const activeDateCol = useMemo(() => {
    if (dateColumnKey) {
      return dateColumns.find((c) => c.key === dateColumnKey) ?? null;
    }
    // Smart default: any non-title date column first, else first date col.
    const nonTitle = dateColumns.find((c) => c.is_title !== 1);
    return nonTitle ?? dateColumns[0] ?? null;
  }, [dateColumns, dateColumnKey]);

  // Anchor month state — first of month (local).
  const today = useMemo(() => startOfDay(new Date()), []);
  const [anchor, setAnchor] = useState<Date>(() => startOfMonth(new Date()));

  // Build the records-by-day index. Safe even if activeDateCol is null
  // — we fall through to an empty index. We always run the hook to
  // satisfy rules-of-hooks; the early return below short-circuits the
  // render path.
  const { byDay, allRecords } = useMemo(
    () => {
      if (!activeDateCol) {
        return { byDay: new Map<string, DayRecord[]>(), allRecords: [] as DayRecord[] };
      }
      return indexRecordsByDay(rows, rowData, activeDateCol, titleCol);
    },
    [rows, rowData, activeDateCol, titleCol],
  );

  // Visible window: 6 rows x 7 cols starting on the Sunday on/before the 1st.
  const cells = useMemo(() => buildMonthCells(anchor), [anchor]);

  const goPrev = () => setAnchor((d) => addMonths(d, -1));
  const goNext = () => setAnchor((d) => addMonths(d, 1));
  const goToday = () => setAnchor(startOfMonth(new Date()));

  // Keyboard arrows on the toolbar.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  if (dateColumns.length === 0) {
    return (
      <EmptyState
        title="Add a date column to enable Calendar"
        description="Calendar lays records out by a date column. Add a Date column from the Grid view, then come back."
      />
    );
  }
  if (!activeDateCol) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <Box
        ref={toolbarRef}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          mb: 2,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="cal-date-col-label">Date column</InputLabel>
          <Select
            labelId="cal-date-col-label"
            value={activeDateCol.key}
            label="Date column"
            onChange={(e) => onChangeDateColumn(e.target.value || null)}
          >
            {dateColumns.map((c) => (
              <MenuItem key={c.id} value={c.key}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <IconButton onClick={goPrev} aria-label="Previous month" size="small" sx={{ minWidth: 36, minHeight: 36 }}>
            <PrevIcon fontSize="small" />
          </IconButton>
          <Typography
            variant="subtitle1"
            sx={{ fontWeight: 600, minWidth: 160, textAlign: 'center' }}
            aria-live="polite"
          >
            {formatMonthYear(anchor)}
          </Typography>
          <IconButton onClick={goNext} aria-label="Next month" size="small" sx={{ minWidth: 36, minHeight: 36 }}>
            <NextIcon fontSize="small" />
          </IconButton>
        </Box>
        <Button onClick={goToday} size="small" variant="outlined">
          Today
        </Button>
        <ToggleButtonGroup
          size="small"
          value="month"
          exclusive
          aria-label="Calendar view scale"
          sx={{ height: 32 }}
        >
          <ToggleButton value="month" sx={{ px: 1.5, fontSize: '0.75rem' }}>
            Month
          </ToggleButton>
          <Tooltip title="Week view coming soon">
            <span>
              <ToggleButton value="week" disabled sx={{ px: 1.5, fontSize: '0.75rem' }}>
                Week
              </ToggleButton>
            </span>
          </Tooltip>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">
          {allRecords.length} {allRecords.length === 1 ? 'record' : 'records'} on this column
        </Typography>
      </Box>

      {/* Body */}
      {isMobile ? (
        <MobileAgenda
          anchor={anchor}
          today={today}
          byDay={byDay}
          onOpenRow={onOpenRow}
          dateCol={activeDateCol}
        />
      ) : (
        <MonthGrid
          cells={cells}
          anchor={anchor}
          today={today}
          byDay={byDay}
          onOpenRow={onOpenRow}
        />
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------
// Desktop month grid
// ----------------------------------------------------------------------

interface MonthGridProps {
  cells: Date[];
  anchor: Date;
  today: Date;
  byDay: Map<string, DayRecord[]>;
  onOpenRow: (row: ApiRecordRow) => void;
}

function MonthGrid({ cells, anchor, today, byDay, onOpenRow }: MonthGridProps) {
  const [popoverDay, setPopoverDay] = useState<{ anchor: HTMLElement; iso: string } | null>(null);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      {/* Weekday header */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        {WEEKDAY_HEADERS.map((d) => (
          <Box
            key={d}
            sx={{
              px: 1,
              py: 1,
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 600,
              color: 'text.secondary',
              textAlign: 'center',
            }}
          >
            {d}
          </Box>
        ))}
      </Box>
      {/* Grid */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: '1fr',
          flex: 1,
          minHeight: 0,
        }}
      >
        {cells.map((day) => {
          const iso = isoLocalDay(day);
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = sameDay(day, today);
          const records = byDay.get(iso) ?? [];
          const visible = records.slice(0, 2);
          const overflow = records.length - visible.length;

          return (
            <Box
              key={iso}
              sx={{
                borderRight: '1px solid',
                borderBottom: '1px solid',
                borderColor: 'divider',
                p: 0.75,
                minHeight: 90,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                position: 'relative',
                bgcolor: isToday ? 'rgba(26, 54, 93, 0.04)' : 'transparent',
                opacity: inMonth ? 1 : 0.45,
                '&:nth-of-type(7n)': { borderRight: 'none' },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Box
                  sx={{
                    fontSize: '0.75rem',
                    fontWeight: isToday ? 700 : 500,
                    color: isToday ? 'primary.main' : inMonth ? 'text.primary' : 'text.disabled',
                    lineHeight: 1,
                    px: isToday ? 0.75 : 0.25,
                    py: isToday ? 0.25 : 0,
                    borderRadius: 999,
                    bgcolor: isToday ? 'rgba(26, 54, 93, 0.10)' : 'transparent',
                  }}
                >
                  {day.getDate()}
                </Box>
              </Box>
              <Stack spacing={0.5} sx={{ flex: 1, minHeight: 0 }}>
                {visible.map((rec) => (
                  <DayChip key={rec.row.id} rec={rec} onClick={() => onOpenRow(rec.row)} />
                ))}
                {overflow > 0 && (
                  <Box
                    component="button"
                    type="button"
                    onClick={(e) => setPopoverDay({ anchor: e.currentTarget, iso })}
                    sx={{
                      all: 'unset',
                      cursor: 'pointer',
                      px: 0.75,
                      py: 0.25,
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      color: 'text.secondary',
                      borderRadius: 0.75,
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                    aria-label={`Show ${overflow} more record${overflow === 1 ? '' : 's'}`}
                  >
                    +{overflow} more
                  </Box>
                )}
              </Stack>
            </Box>
          );
        })}
      </Box>
      {/* Overflow popover */}
      <Popover
        open={Boolean(popoverDay)}
        anchorEl={popoverDay?.anchor ?? null}
        onClose={() => setPopoverDay(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        {popoverDay && (
          <Box sx={{ p: 1.5, minWidth: 220, maxWidth: 320 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontWeight: 600 }}>
              {formatLongDay(popoverDay.iso)}
            </Typography>
            <Stack spacing={0.5}>
              {(byDay.get(popoverDay.iso) ?? []).map((rec) => (
                <DayChip
                  key={rec.row.id}
                  rec={rec}
                  onClick={() => {
                    onOpenRow(rec.row);
                    setPopoverDay(null);
                  }}
                />
              ))}
            </Stack>
          </Box>
        )}
      </Popover>
    </Box>
  );
}

function DayChip({ rec, onClick }: { rec: DayRecord; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      sx={{
        all: 'unset',
        cursor: 'pointer',
        px: 0.75,
        py: 0.25,
        bgcolor: 'rgba(26, 54, 93, 0.10)',
        color: '#1A365D',
        border: '1px solid rgba(26, 54, 93, 0.18)',
        borderRadius: 0.75,
        fontSize: '0.75rem',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
        '&:hover': { bgcolor: 'rgba(26, 54, 93, 0.18)' },
        '&:focus-visible': { outline: '2px solid #1A365D', outlineOffset: 1 },
      }}
      title={rec.title}
    >
      {rec.title}
    </Box>
  );
}

// ----------------------------------------------------------------------
// Mobile agenda
// ----------------------------------------------------------------------

interface MobileAgendaProps {
  anchor: Date;
  today: Date;
  byDay: Map<string, DayRecord[]>;
  onOpenRow: (row: ApiRecordRow) => void;
  dateCol: ApiRecordColumn;
}

function MobileAgenda({ anchor, today, byDay, onOpenRow, dateCol }: MobileAgendaProps) {
  // Show all days in the anchored month that have records, plus
  // optionally today even if empty (so the user always sees an anchor).
  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);

  const sections = useMemo(() => {
    const out: { iso: string; date: Date; records: DayRecord[] }[] = [];
    for (let d = new Date(monthStart); d <= monthEnd; d = addDays(d, 1)) {
      const iso = isoLocalDay(d);
      const records = byDay.get(iso) ?? [];
      if (records.length > 0) out.push({ iso, date: new Date(d), records });
    }
    return out;
  }, [monthStart, monthEnd, byDay]);

  // Anchor scroll to today when month flips and today's section exists.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const todayIso = isoLocalDay(today);
    const target = el.querySelector(`[data-day="${todayIso}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'start' });
    } else {
      el.scrollTop = 0;
    }
  }, [anchor, today]);

  if (sections.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          color: 'text.secondary',
          px: 4,
        }}
      >
        <Box>
          <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
            No records this month
          </Typography>
          <Typography variant="caption" color="text.secondary">
            on the {dateCol.label} column.
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        pb: 4,
      }}
    >
      {sections.map((section) => {
        const isToday = sameDay(section.date, today);
        return (
          <Box
            key={section.iso}
            data-day={section.iso}
            sx={{ mb: 2 }}
          >
            <Box
              sx={{
                position: 'sticky',
                top: 0,
                bgcolor: 'background.paper',
                zIndex: 1,
                py: 1,
                borderBottom: '1px solid',
                borderColor: 'divider',
                display: 'flex',
                alignItems: 'baseline',
                gap: 1,
              }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 700, color: isToday ? 'primary.main' : 'text.primary' }}>
                {formatShortDay(section.date)}
              </Typography>
              {isToday && (
                <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 600 }}>
                  · Today
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                {section.records.length} {section.records.length === 1 ? 'record' : 'records'}
              </Typography>
            </Box>
            <Stack spacing={1} sx={{ pt: 1 }}>
              {section.records.map((rec) => (
                <Box
                  key={rec.row.id}
                  component="button"
                  type="button"
                  onClick={() => onOpenRow(rec.row)}
                  sx={{
                    all: 'unset',
                    cursor: 'pointer',
                    p: 1.5,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'background.paper',
                    minHeight: 56,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: '0.9375rem',
                    fontWeight: 500,
                    '&:active': { bgcolor: 'action.hover' },
                  }}
                >
                  {rec.title}
                </Box>
              ))}
            </Stack>
          </Box>
        );
      })}
    </Box>
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function indexRecordsByDay(
  rows: ApiRecordRow[],
  rowData: Record<string, RecordRowData>,
  dateCol: ApiRecordColumn,
  titleCol: ApiRecordColumn | undefined,
): { byDay: Map<string, DayRecord[]>; allRecords: DayRecord[] } {
  const byDay = new Map<string, DayRecord[]>();
  const allRecords: DayRecord[] = [];
  for (const row of rows) {
    const v = rowData[row.id]?.[dateCol.key];
    if (v == null || v === '') continue;
    const d = coerceDate(v);
    if (!d) continue;
    const iso = isoLocalDay(d);
    const title =
      row.display_title ??
      (titleCol && typeof rowData[row.id]?.[titleCol.key] === 'string'
        ? (rowData[row.id]?.[titleCol.key] as string)
        : '') ??
      'Untitled';
    const rec: DayRecord = { row, iso, title: title || 'Untitled' };
    let bucket = byDay.get(iso);
    if (!bucket) {
      bucket = [];
      byDay.set(iso, bucket);
    }
    bucket.push(rec);
    allRecords.push(rec);
  }
  // Sort each day's records by title for stable rendering.
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.title.localeCompare(b.title));
  }
  return { byDay, allRecords };
}

function coerceDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  // Date-only strings ("2026-04-28") are parsed as UTC midnight by the
  // JS Date ctor, which then renders as the previous day in negative
  // offsets. If the value looks like a bare date string, rebuild it
  // as local midnight so it lands on the day the user actually meant.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split('-').map(Number);
    return new Date(y, m - 1, day);
  }
  return d;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isoLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function buildMonthCells(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  // Go back to the Sunday on/before the 1st.
  const start = addDays(first, -first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(addDays(start, i));
  }
  return cells;
}

function formatMonthYear(d: Date): string {
  try {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } catch {
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }
}

function formatLongDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  try {
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatShortDay(d: Date): string {
  try {
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return isoLocalDay(d);
  }
}

export function isCalendarCapable(columns: ApiRecordColumn[]): boolean {
  return columns.some(
    (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
  );
}

export function getDefaultDateColumnKey(columns: ApiRecordColumn[]): string | null {
  const dates = columns.filter(
    (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
  );
  const nonTitle = dates.find((c) => c.is_title !== 1);
  return (nonTitle ?? dates[0])?.key ?? null;
}
