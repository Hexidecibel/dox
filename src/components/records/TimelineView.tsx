/**
 * TimelineView — horizontal-axis layout that lays records out along a
 * chosen date column. Each record is a small palette-tinted chip pinned
 * at its date. Optional vertical grouping ("swimlanes") buckets rows by
 * a second column for quick by-supplier / by-type scans.
 *
 * Why a hand-rolled timeline:
 *   - The dox bundle budget rules out heavy Gantt libraries (vis-timeline,
 *     dhtmlx, etc.); we'd inherit ~80kb+ of features we don't use.
 *   - Single-date chips are trivially expressed with `position: absolute`
 *     against a date-anchored grid. Native `Date` math handles the axis.
 *   - The Calendar view already proved the local-day-boundary pattern;
 *     we reuse the same `coerceDate` / `isoLocalDay` shape so date-only
 *     strings like "2026-04-28" don't drift across timezones.
 *
 * Behavior (v1):
 *   - Single-date chips only. The chip's left edge sits on the day; the
 *     width is fixed (~120px desktop, scaled by zoom). Multi-day spans
 *     (start_date_column_key + end_date_column_key) are deferred — see
 *     plan.md / backlog.md. The renderer is structured to accept a span
 *     when we add it, so the data model isn't a redo.
 *   - Time scale: Day / Week / Month / Quarter. Each scale picks a
 *     pixels-per-day value that keeps the labels readable without
 *     squashing chips into pixel mush at the dense end. Quarter (~1.5
 *     px/day) is intentionally a "pan to find clusters" view, not a
 *     "read every label" view.
 *   - Today marker: a solid 2px primary-tinted vertical line sliced
 *     through the grid. The header strip echoes a small "Today" pill on
 *     the date so it's recognizable when the chip-region scrolls.
 *   - Click chip → open the row drawer. Drag-to-reschedule is deferred
 *     in v1: HTML5 drag against an absolutely-positioned grid is fiddly,
 *     and the drawer's date editor is the obvious place to fix a date.
 *     We do annotate chips with `cursor: pointer` (not grab) so the
 *     affordance matches the actual interaction.
 *
 * Mobile (<= 768px):
 *   - Falls back to the agenda pattern Calendar uses: vertical sections
 *     keyed by date, each section listing its records. Horizontally
 *     scrolling axes don't survive thumbs well, and the agenda gives the
 *     user the same "what's coming up" answer with no zoom UI.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
} from '@mui/icons-material';
import {
  DROPDOWN_PALETTE,
  paletteForOption,
} from './cellHelpers';
import type {
  ApiRecordColumn,
  ApiRecordRow,
  RecordRowData,
  TimelineScale,
} from '../../../shared/types';
import { EmptyState } from '../EmptyState';

interface TimelineViewProps {
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  /** URL-controlled date column key; null = auto-pick. */
  dateColumnKey: string | null;
  onChangeDateColumn: (key: string | null) => void;
  /** URL-controlled grouping/swimlane column; null = single lane. */
  groupColumnKey: string | null;
  onChangeGroupColumn: (key: string | null) => void;
  /** URL-controlled time scale (zoom). */
  scale: TimelineScale;
  onChangeScale: (s: TimelineScale) => void;
  onOpenRow: (row: ApiRecordRow) => void;
}

// Pixels-per-day at each zoom level. Hand-tuned so tick labels at each
// scale aren't crammed: Day shows hours-of-readability; Month gives
// every day a comfortable 24px; Quarter is pan-to-overview density.
const PX_PER_DAY: Record<TimelineScale, number> = {
  day: 96,
  week: 48,
  month: 24,
  quarter: 6,
};

// How many days the visible window spans at each scale. We render a
// window centered on the anchor date; users prev/next to pan.
const WINDOW_DAYS: Record<TimelineScale, number> = {
  day: 14, // two weeks at high zoom
  week: 42, // six weeks
  month: 90, // a quarter
  quarter: 365, // a year
};

const LANE_HEIGHT = 56;
const HEADER_HEIGHT = 56;
const GROUP_LABEL_WIDTH = 160;
const CHIP_WIDTH = 110;

export function TimelineView({
  columns,
  rows,
  rowData,
  dateColumnKey,
  onChangeDateColumn,
  groupColumnKey,
  onChangeGroupColumn,
  scale,
  onChangeScale,
  onOpenRow,
}: TimelineViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const dateColumns = useMemo(
    () =>
      columns.filter(
        (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
      ),
    [columns],
  );
  // Any non-date, non-title column is a candidate for grouping. We don't
  // filter to dropdowns the way Kanban does — text or supplier_ref
  // grouping is useful here too ("by supplier", "by site").
  const groupColumns = useMemo(
    () =>
      columns.filter(
        (c) =>
          c.archived === 0 &&
          c.is_title !== 1 &&
          c.type !== 'date' &&
          c.type !== 'datetime' &&
          c.type !== 'long_text' &&
          c.type !== 'attachment',
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
    const nonTitle = dateColumns.find((c) => c.is_title !== 1);
    return nonTitle ?? dateColumns[0] ?? null;
  }, [dateColumns, dateColumnKey]);

  const activeGroupCol = useMemo(() => {
    if (!groupColumnKey) return null;
    return groupColumns.find((c) => c.key === groupColumnKey) ?? null;
  }, [groupColumns, groupColumnKey]);

  // Today (local-day boundary) — recomputed once per mount which is fine
  // for a session-length view. The vertical "today" line is positioned
  // off this value.
  const today = useMemo(() => startOfDay(new Date()), []);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));

  const indexed = useMemo(() => {
    if (!activeDateCol) return [] as TimelineRecord[];
    return indexTimeline(rows, rowData, activeDateCol, titleCol, activeGroupCol);
  }, [rows, rowData, activeDateCol, titleCol, activeGroupCol]);

  if (dateColumns.length === 0) {
    return (
      <EmptyState
        title="Add a date column to enable Timeline"
        description="Timeline lays records out by a date column. Add a Date column from the Grid view, then come back."
      />
    );
  }
  if (!activeDateCol) return null;

  // ---- Mobile: agenda fallback ----
  if (isMobile) {
    return (
      <MobileAgendaTimeline
        dateColumns={dateColumns}
        activeDateCol={activeDateCol}
        onChangeDateColumn={onChangeDateColumn}
        records={indexed}
        today={today}
        onOpenRow={onOpenRow}
      />
    );
  }

  // ---- Desktop window math ----
  const windowDays = WINDOW_DAYS[scale];
  const pxPerDay = PX_PER_DAY[scale];
  const windowStart = addDays(anchor, -Math.floor(windowDays / 2));
  const windowEnd = addDays(windowStart, windowDays);
  const totalWidth = windowDays * pxPerDay;

  const visibleRecords = indexed.filter(
    (r) => r.date >= windowStart && r.date < windowEnd,
  );

  // Build lanes. With no grouping there's a single lane.
  const lanes = buildLanes(visibleRecords, activeGroupCol);

  const goPrev = () => setAnchor((d) => addDays(d, -Math.floor(windowDays / 3)));
  const goNext = () => setAnchor((d) => addDays(d, Math.floor(windowDays / 3)));
  const goToday = () => setAnchor(startOfDay(new Date()));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="tl-date-col-label">Date column</InputLabel>
          <Select
            labelId="tl-date-col-label"
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
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="tl-group-col-label">Group by</InputLabel>
          <Select
            labelId="tl-group-col-label"
            value={activeGroupCol?.key ?? ''}
            label="Group by"
            onChange={(e) => onChangeGroupColumn(e.target.value || null)}
          >
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {groupColumns.map((c) => (
              <MenuItem key={c.id} value={c.key}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <IconButton onClick={goPrev} aria-label="Pan back" size="small" sx={{ minWidth: 36, minHeight: 36 }}>
            <PrevIcon fontSize="small" />
          </IconButton>
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 600, minWidth: 220, textAlign: 'center' }}
            aria-live="polite"
          >
            {formatRange(windowStart, addDays(windowEnd, -1))}
          </Typography>
          <IconButton onClick={goNext} aria-label="Pan forward" size="small" sx={{ minWidth: 36, minHeight: 36 }}>
            <NextIcon fontSize="small" />
          </IconButton>
        </Box>
        <Button onClick={goToday} size="small" variant="outlined">
          Today
        </Button>
        <ToggleButtonGroup
          size="small"
          value={scale}
          exclusive
          onChange={(_, v) => {
            if (v === 'day' || v === 'week' || v === 'month' || v === 'quarter') {
              onChangeScale(v);
            }
          }}
          aria-label="Timeline zoom"
          sx={{ height: 32 }}
        >
          <ToggleButton value="day" sx={{ px: 1.25, fontSize: '0.75rem' }}>Day</ToggleButton>
          <ToggleButton value="week" sx={{ px: 1.25, fontSize: '0.75rem' }}>Week</ToggleButton>
          <ToggleButton value="month" sx={{ px: 1.25, fontSize: '0.75rem' }}>Month</ToggleButton>
          <ToggleButton value="quarter" sx={{ px: 1.25, fontSize: '0.75rem' }}>Quarter</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">
          {visibleRecords.length} of {indexed.length} {indexed.length === 1 ? 'record' : 'records'} in window
        </Typography>
      </Box>

      {/* Body */}
      <TimelineGrid
        windowStart={windowStart}
        windowEnd={windowEnd}
        windowDays={windowDays}
        pxPerDay={pxPerDay}
        totalWidth={totalWidth}
        scale={scale}
        today={today}
        lanes={lanes}
        hasGroup={Boolean(activeGroupCol)}
        onOpenRow={onOpenRow}
      />
    </Box>
  );
}

// ----------------------------------------------------------------------
// Desktop grid
// ----------------------------------------------------------------------

interface TimelineGridProps {
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
  pxPerDay: number;
  totalWidth: number;
  scale: TimelineScale;
  today: Date;
  lanes: TimelineLane[];
  hasGroup: boolean;
  onOpenRow: (row: ApiRecordRow) => void;
}

function TimelineGrid({
  windowStart,
  windowDays,
  pxPerDay,
  totalWidth,
  scale,
  today,
  lanes,
  hasGroup,
  onOpenRow,
}: TimelineGridProps) {
  // Auto-scroll today into view on mount + window changes.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const todayOffset = daysBetween(windowStart, today) * pxPerDay;
    if (todayOffset >= 0 && todayOffset <= totalWidth) {
      // Center "today" in the visible scroller.
      const target = todayOffset - el.clientWidth / 2 + CHIP_WIDTH / 2;
      el.scrollLeft = Math.max(0, target);
    }
  }, [windowStart, totalWidth, pxPerDay, today]);

  const ticks = buildTicks(windowStart, windowDays, scale);
  const todayOffset = daysBetween(windowStart, today) * pxPerDay;
  const todayInWindow = todayOffset >= 0 && todayOffset <= totalWidth;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      {/* Sticky group column */}
      {hasGroup && (
        <Box
          sx={{
            width: GROUP_LABEL_WIDTH,
            flexShrink: 0,
            borderRight: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.paper',
            zIndex: 2,
          }}
        >
          <Box
            sx={{
              height: HEADER_HEIGHT,
              borderBottom: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              px: 1.5,
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 600,
              color: 'text.secondary',
              flexShrink: 0,
            }}
          >
            Group
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {lanes.map((lane) => (
              <Box
                key={lane.value}
                sx={{
                  height: LANE_HEIGHT,
                  px: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: lane.value === EMPTY_LANE ? 'text.disabled' : 'text.primary',
                  fontStyle: lane.value === EMPTY_LANE ? 'italic' : 'normal',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={lane.label}
              >
                {lane.label}
                <Box
                  component="span"
                  sx={{
                    ml: 'auto',
                    fontSize: '0.7rem',
                    color: 'text.disabled',
                    fontWeight: 600,
                  }}
                >
                  {lane.records.length}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Scroller */}
      <Box
        ref={scrollerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          position: 'relative',
          scrollbarWidth: 'thin',
        }}
      >
        <Box sx={{ width: totalWidth, position: 'relative' }}>
          {/* Tick header */}
          <Box
            sx={{
              height: HEADER_HEIGHT,
              borderBottom: '1px solid',
              borderColor: 'divider',
              position: 'sticky',
              top: 0,
              bgcolor: 'background.paper',
              zIndex: 1,
            }}
          >
            {ticks.map((tick) => (
              <Box
                key={tick.iso}
                sx={{
                  position: 'absolute',
                  left: tick.offsetPx,
                  top: 0,
                  height: '100%',
                  borderLeft: tick.major ? '1px solid' : 'none',
                  borderColor: 'divider',
                  pl: tick.major ? 0.75 : 0,
                  pt: 0.5,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  minWidth: 60,
                }}
              >
                {tick.majorLabel && (
                  <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, lineHeight: 1.1, color: 'text.primary' }}>
                    {tick.majorLabel}
                  </Typography>
                )}
                {tick.minorLabel && (
                  <Typography sx={{ fontSize: '0.65rem', color: 'text.secondary', lineHeight: 1.1 }}>
                    {tick.minorLabel}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>

          {/* Lanes */}
          <Box sx={{ position: 'relative' }}>
            {lanes.map((lane, laneIndex) => (
              <Box
                key={lane.value}
                sx={{
                  position: 'relative',
                  height: LANE_HEIGHT,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  bgcolor: laneIndex % 2 === 1 ? 'rgba(0,0,0,0.015)' : 'transparent',
                }}
              >
                {/* Today line per lane (full-height line below covers all,
                    but per-lane background helps when the user pans across
                    lanes on a tall list). */}
                {lane.records.map((rec) => {
                  const offset = daysBetween(windowStart, rec.date) * pxPerDay;
                  const palette = paletteForOption(rec.paletteIndex);
                  return (
                    <Box
                      key={rec.row.id}
                      component="button"
                      type="button"
                      onClick={() => onOpenRow(rec.row)}
                      title={`${rec.title} · ${formatDate(rec.date)}`}
                      sx={{
                        all: 'unset',
                        cursor: 'pointer',
                        position: 'absolute',
                        left: Math.max(0, offset),
                        top: 8,
                        bottom: 8,
                        width: CHIP_WIDTH,
                        maxWidth: CHIP_WIDTH,
                        px: 1,
                        py: 0.5,
                        boxSizing: 'border-box',
                        bgcolor: palette.bg,
                        color: palette.fg,
                        border: `1px solid ${palette.border}`,
                        borderRadius: 0.75,
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: 'flex',
                        alignItems: 'center',
                        '&:hover': {
                          filter: 'brightness(0.96)',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                        },
                        '&:focus-visible': {
                          outline: `2px solid ${palette.fg}`,
                          outlineOffset: 1,
                        },
                      }}
                    >
                      {rec.title}
                    </Box>
                  );
                })}
              </Box>
            ))}

            {/* Today line */}
            {todayInWindow && (
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: todayOffset,
                  width: 2,
                  bgcolor: 'primary.main',
                  opacity: 0.55,
                  pointerEvents: 'none',
                  boxShadow: '0 0 6px rgba(26, 54, 93, 0.35)',
                }}
              />
            )}

            {/* Empty state for the visible window */}
            {lanes.length === 1 && lanes[0].records.length === 0 && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'text.disabled',
                  fontSize: '0.875rem',
                  pointerEvents: 'none',
                }}
              >
                No records in this window
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------
// Mobile agenda
// ----------------------------------------------------------------------

interface MobileAgendaTimelineProps {
  dateColumns: ApiRecordColumn[];
  activeDateCol: ApiRecordColumn;
  onChangeDateColumn: (key: string | null) => void;
  records: TimelineRecord[];
  today: Date;
  onOpenRow: (row: ApiRecordRow) => void;
}

function MobileAgendaTimeline({
  dateColumns,
  activeDateCol,
  onChangeDateColumn,
  records,
  today,
  onOpenRow,
}: MobileAgendaTimelineProps) {
  const sections = useMemo(() => {
    const byIso = new Map<string, TimelineRecord[]>();
    for (const r of records) {
      const iso = isoLocalDay(r.date);
      let bucket = byIso.get(iso);
      if (!bucket) {
        bucket = [];
        byIso.set(iso, bucket);
      }
      bucket.push(r);
    }
    const out: { iso: string; date: Date; records: TimelineRecord[] }[] = [];
    for (const [iso, recs] of byIso.entries()) {
      const [y, m, d] = iso.split('-').map(Number);
      out.push({ iso, date: new Date(y, m - 1, d), records: recs });
    }
    out.sort((a, b) => a.date.getTime() - b.date.getTime());
    return out;
  }, [records]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const todayIso = isoLocalDay(today);
    const target = el.querySelector(`[data-day="${todayIso}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'start' });
    } else {
      // Find the next future section and scroll there so the user lands
      // somewhere meaningful instead of at the start of history.
      const nextFuture = sections.find((s) => s.date >= today);
      if (nextFuture) {
        const t = el.querySelector(`[data-day="${nextFuture.iso}"]`);
        if (t instanceof HTMLElement) t.scrollIntoView({ block: 'start' });
      }
    }
  }, [sections, today]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ mb: 2, flexShrink: 0 }}>
        <FormControl size="small" fullWidth>
          <InputLabel id="tl-mobile-date-label">Date column</InputLabel>
          <Select
            labelId="tl-mobile-date-label"
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
      </Box>

      {sections.length === 0 ? (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            textAlign: 'center',
            px: 4,
          }}
        >
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
              No dated records
            </Typography>
            <Typography variant="caption" color="text.secondary">
              on the {activeDateCol.label} column.
            </Typography>
          </Box>
        </Box>
      ) : (
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
              <Box key={section.iso} data-day={section.iso} sx={{ mb: 2 }}>
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
                  <Typography
                    variant="subtitle2"
                    sx={{ fontWeight: 700, color: isToday ? 'primary.main' : 'text.primary' }}
                  >
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
                  {section.records.map((rec) => {
                    const palette = paletteForOption(rec.paletteIndex);
                    return (
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
                          border: `1px solid ${palette.border}`,
                          bgcolor: palette.bg,
                          color: palette.fg,
                          minHeight: 56,
                          boxSizing: 'border-box',
                          display: 'flex',
                          alignItems: 'center',
                          fontSize: '0.9375rem',
                          fontWeight: 500,
                          '&:active': { filter: 'brightness(0.95)' },
                        }}
                      >
                        {rec.title}
                      </Box>
                    );
                  })}
                </Stack>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const EMPTY_LANE = '__empty__';

interface TimelineRecord {
  row: ApiRecordRow;
  date: Date;
  title: string;
  /** Lane key (group value or EMPTY_LANE). */
  lane: string;
  /** Lane label for display. */
  laneLabel: string;
  /** Palette index — derived from the lane bucket so chips share a hue per lane. */
  paletteIndex: number;
}

interface TimelineLane {
  value: string;
  label: string;
  records: TimelineRecord[];
}

function indexTimeline(
  rows: ApiRecordRow[],
  rowData: Record<string, RecordRowData>,
  dateCol: ApiRecordColumn,
  titleCol: ApiRecordColumn | undefined,
  groupCol: ApiRecordColumn | null,
): TimelineRecord[] {
  // First pass: determine palette indices per lane by iteration order.
  const laneIndex = new Map<string, number>();
  const out: TimelineRecord[] = [];
  for (const row of rows) {
    const v = rowData[row.id]?.[dateCol.key];
    if (v == null || v === '') continue;
    const d = coerceDate(v);
    if (!d) continue;
    const title =
      row.display_title ??
      (titleCol && typeof rowData[row.id]?.[titleCol.key] === 'string'
        ? (rowData[row.id]?.[titleCol.key] as string)
        : '') ??
      'Untitled';

    let lane = EMPTY_LANE;
    let laneLabel = '(no group)';
    if (groupCol) {
      const gv = rowData[row.id]?.[groupCol.key];
      const labelVal = formatGroupValue(gv);
      if (labelVal) {
        lane = labelVal;
        laneLabel = labelVal;
      }
    } else {
      lane = '__all__';
      laneLabel = 'All records';
    }
    if (!laneIndex.has(lane)) {
      laneIndex.set(lane, laneIndex.size % DROPDOWN_PALETTE.length);
    }
    out.push({
      row,
      date: d,
      title: title || 'Untitled',
      lane,
      laneLabel,
      paletteIndex: laneIndex.get(lane)!,
    });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

function formatGroupValue(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => formatGroupValue(x)).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') {
    const o = v as { name?: unknown; label?: unknown; id?: unknown };
    if (typeof o.name === 'string') return o.name;
    if (typeof o.label === 'string') return o.label;
    if (typeof o.id === 'string') return o.id;
  }
  return null;
}

function buildLanes(
  records: TimelineRecord[],
  groupCol: ApiRecordColumn | null,
): TimelineLane[] {
  const map = new Map<string, TimelineLane>();
  for (const r of records) {
    let lane = map.get(r.lane);
    if (!lane) {
      lane = { value: r.lane, label: r.laneLabel, records: [] };
      map.set(r.lane, lane);
    }
    lane.records.push(r);
  }
  // Stable order: empty lane (or "all") at top if it's the only one,
  // otherwise sort alphabetically.
  const arr = Array.from(map.values());
  if (!groupCol) {
    if (arr.length === 0) {
      return [{ value: '__all__', label: 'All records', records: [] }];
    }
    return arr;
  }
  arr.sort((a, b) => {
    if (a.value === EMPTY_LANE) return 1;
    if (b.value === EMPTY_LANE) return -1;
    return a.label.localeCompare(b.label);
  });
  return arr;
}

interface AxisTick {
  iso: string;
  offsetPx: number;
  major: boolean;
  majorLabel: string | null;
  minorLabel: string | null;
}

function buildTicks(start: Date, days: number, scale: TimelineScale): AxisTick[] {
  const out: AxisTick[] = [];
  const pxPerDay = PX_PER_DAY[scale];
  // Tick spacing per scale.
  const tickEvery = scale === 'day' ? 1 : scale === 'week' ? 1 : scale === 'month' ? 7 : 30;
  for (let i = 0; i < days; i += tickEvery) {
    const d = addDays(start, i);
    const isMajor = scale === 'day'
      ? true
      : scale === 'week'
        ? d.getDay() === 0
        : scale === 'month'
          ? d.getDate() <= 7 && d.getDay() === 0 // first sunday-ish each month
          : d.getDate() === 1; // quarter: first of month
    out.push({
      iso: isoLocalDay(d),
      offsetPx: i * pxPerDay,
      major: isMajor,
      majorLabel: tickMajorLabel(d, scale, isMajor),
      minorLabel: tickMinorLabel(d, scale),
    });
  }
  return out;
}

function tickMajorLabel(d: Date, scale: TimelineScale, isMajor: boolean): string | null {
  if (!isMajor) return null;
  if (scale === 'day') {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  if (scale === 'week') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (scale === 'month') {
    return d.toLocaleDateString(undefined, { month: 'short' });
  }
  // quarter
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function tickMinorLabel(d: Date, scale: TimelineScale): string | null {
  if (scale === 'day') return String(d.getDate());
  if (scale === 'week') return null;
  if (scale === 'month') return null;
  return null;
}

function coerceDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : startOfDay(v);
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split('-').map(Number);
    return new Date(y, m - 1, day);
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return startOfDay(d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function daysBetween(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86400000);
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

function formatDate(d: Date): string {
  try {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return isoLocalDay(d);
  }
}

function formatRange(a: Date, b: Date): string {
  const sameYear = a.getFullYear() === b.getFullYear();
  try {
    if (sameYear) {
      const aPart = a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const bPart = b.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `${aPart} – ${bPart}`;
    }
    return `${formatDate(a)} – ${formatDate(b)}`;
  } catch {
    return `${isoLocalDay(a)} – ${isoLocalDay(b)}`;
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

export function isTimelineCapable(columns: ApiRecordColumn[]): boolean {
  return columns.some(
    (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
  );
}

export function getDefaultTimelineDateColumnKey(columns: ApiRecordColumn[]): string | null {
  const dates = columns.filter(
    (c) => c.archived === 0 && (c.type === 'date' || c.type === 'datetime'),
  );
  const nonTitle = dates.find((c) => c.is_title !== 1);
  return (nonTitle ?? dates[0])?.key ?? null;
}
