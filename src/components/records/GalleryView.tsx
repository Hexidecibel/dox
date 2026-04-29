/**
 * GalleryView — photo-forward card grid, optimized for sheets where rows
 * carry attached images (e.g. site-visit reports, sample photos, defect
 * captures). Each card leads with a large thumbnail of the row's first
 * image attachment, followed by the row's title and 2-3 secondary fields.
 *
 * Why this view earns its keep:
 *   - Grid is the spreadsheet view; Kanban is the workflow view; Calendar
 *     and Timeline are time views. Gallery is the *visual* view — when a
 *     user is reviewing a stack of inspections or photo logs, scanning by
 *     image is dramatically faster than scanning by file name.
 *   - Reuses CellRenderer for the secondary fields so dropdown chips and
 *     entity refs render identically to the Grid view; the user's mental
 *     model of "what's in this column" doesn't have to fork per view.
 *
 * Data fetching:
 *   - The /rows.list endpoint returns `attachment_count` per row but not
 *     the attachments themselves. We lazily fetch per-row attachments in
 *     a small concurrency pool (kept low — 4 — to stay well under any
 *     edge-rate-limit even on a large sheet) and cache the first image
 *     URL per row in component state. Rows with `attachment_count === 0`
 *     are short-circuited and never trigger a fetch.
 *   - Refetches are scoped to row id changes, not card visibility — IO
 *     observers add complexity for a feature that's already gated by
 *     attachment_count and a hard limit (200 rows from /rows.list). If
 *     pagination grows we can graduate to a viewport observer or a bulk
 *     `?image_only=1` endpoint.
 *
 * Behavior:
 *   - Sort by any column (default: most-recently-updated first)
 *   - Filter toggle: "Photos only" hides records without an image
 *   - Click card → opens the row drawer, identical to Grid/Kanban
 *   - Cards are 3:4 portrait so a wall of inspections looks like a contact sheet
 *
 * Mobile:
 *   - 2 columns with generous gap; cards keep the 3:4 ratio so the photo
 *     stays the dominant element.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Card,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  AttachFile as AttachIcon,
  ImageNotSupportedOutlined as NoImageIcon,
  ArrowDownward as DescIcon,
  ArrowUpward as AscIcon,
} from '@mui/icons-material';
import { CellRenderer } from './CellRenderer';
import { pickMobileSecondaryColumns } from './cellHelpers';
import { recordsApi } from '../../lib/recordsApi';
import type {
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordRowAttachment,
  RecordRowData,
} from '../../../shared/types';

// Concurrency cap on lazy attachment fetches. Each call hits the row's
// attachments endpoint; we don't want a 200-row sheet to fan out 200
// in-flight requests. 4 is a polite ceiling that still feels instant.
const ATTACHMENT_FETCH_CONCURRENCY = 4;

interface GalleryViewProps {
  sheetId: string;
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  /** URL-controlled sort column key (null = updated_at desc). */
  sortColumnKey: string | null;
  onChangeSortColumn: (key: string | null) => void;
  sortDir: 'asc' | 'desc';
  onChangeSortDir: (dir: 'asc' | 'desc') => void;
  photosOnly: boolean;
  onChangePhotosOnly: (v: boolean) => void;
  onOpenRow: (row: ApiRecordRow) => void;
}

interface ImageInfo {
  /** Authenticated download URL with `?preview=true` for inline rendering. */
  url: string;
  fileName: string;
}

type ImageCache = Record<string, ImageInfo | null>; // null => fetched, no image

export function GalleryView({
  sheetId,
  columns,
  rows,
  rowData,
  sortColumnKey,
  onChangeSortColumn,
  sortDir,
  onChangeSortDir,
  photosOnly,
  onChangePhotosOnly,
  onOpenRow,
}: GalleryViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const titleCol = useMemo(
    () => columns.find((c) => c.is_title === 1) ?? columns[0],
    [columns],
  );
  const secondaryCols = useMemo(
    () => pickMobileSecondaryColumns(columns, 3),
    [columns],
  );
  const sortableCols = useMemo(
    () =>
      columns.filter(
        (c) =>
          c.archived === 0 &&
          c.type !== 'long_text' &&
          c.type !== 'attachment' &&
          c.type !== 'formula' &&
          c.type !== 'rollup',
      ),
    [columns],
  );

  // ---- lazy attachment fetch ----
  const [imageCache, setImageCache] = useState<ImageCache>({});
  useEffect(() => {
    let cancelled = false;
    const queue = rows.filter(
      (r) => (r.attachment_count ?? 0) > 0 && !(r.id in imageCache),
    );
    if (queue.length === 0) return;

    const inflight: Promise<void>[] = [];
    let cursor = 0;

    const next = async (): Promise<void> => {
      while (cursor < queue.length) {
        const i = cursor++;
        const row = queue[i];
        try {
          const res = await recordsApi.rows.attachments(sheetId, row.id);
          if (cancelled) return;
          const image = pickFirstImage(res.attachments);
          setImageCache((prev) => ({
            ...prev,
            [row.id]: image,
          }));
        } catch {
          if (cancelled) return;
          // Mark fetched-with-no-image so we don't keep retrying. The
          // retry boundary is "row attachment_count changes", which is
          // a different cache miss path.
          setImageCache((prev) => ({ ...prev, [row.id]: null }));
        }
      }
    };

    const cap = Math.min(ATTACHMENT_FETCH_CONCURRENCY, queue.length);
    for (let i = 0; i < cap; i++) {
      inflight.push(next());
    }

    return () => {
      cancelled = true;
    };
    // We intentionally exclude `imageCache` from deps — including it
    // would re-run the effect every time we set a result, kicking off
    // duplicate fetches. The `r.id in imageCache` check inside catches
    // already-fetched rows on the next legitimate trigger (rows change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, rows]);

  // ---- visible ----
  const visibleRows = useMemo(() => {
    let arr = rows.slice();
    if (photosOnly) {
      arr = arr.filter((r) => imageCache[r.id]);
    }
    arr.sort((a, b) => compareRows(a, b, sortColumnKey, sortDir, rowData));
    return arr;
  }, [rows, photosOnly, imageCache, sortColumnKey, sortDir, rowData]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No records yet"
        body="Add some via Grid view or the form, then come back to see them as a gallery."
      />
    );
  }

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
          <InputLabel id="gallery-sort-label">Sort by</InputLabel>
          <Select
            labelId="gallery-sort-label"
            value={sortColumnKey ?? ''}
            label="Sort by"
            onChange={(e) => onChangeSortColumn(e.target.value || null)}
          >
            <MenuItem value="">
              <em>Last updated</em>
            </MenuItem>
            {sortableCols.map((c) => (
              <MenuItem key={c.id} value={c.key}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <ToggleButtonGroup
          size="small"
          value={sortDir}
          exclusive
          onChange={(_, v) => {
            if (v === 'asc' || v === 'desc') onChangeSortDir(v);
          }}
          aria-label="Sort direction"
          sx={{ height: 32 }}
        >
          <ToggleButton value="desc" sx={{ px: 1 }} aria-label="Descending">
            <DescIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="asc" sx={{ px: 1 }} aria-label="Ascending">
            <AscIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={photosOnly}
              onChange={(e) => onChangePhotosOnly(e.target.checked)}
            />
          }
          label="Photos only"
          sx={{ ml: 1 }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
          {visibleRows.length} {visibleRows.length === 1 ? 'card' : 'cards'}
          {photosOnly && rows.length !== visibleRows.length && (
            <> · {rows.length - visibleRows.length} hidden</>
          )}
        </Typography>
      </Box>

      {/* Grid */}
      {visibleRows.length === 0 ? (
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
              {photosOnly ? 'No records have photos yet' : 'No records match'}
            </Typography>
            {photosOnly && (
              <Typography variant="caption" color="text.secondary">
                Turn off the "Photos only" toggle to see all records.
              </Typography>
            )}
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            pb: { xs: 11, md: 1 }, // room for the mobile FAB
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gap: { xs: 1.25, sm: 2 },
              gridTemplateColumns: {
                xs: 'repeat(2, 1fr)',
                sm: 'repeat(3, 1fr)',
                md: 'repeat(4, 1fr)',
                lg: 'repeat(5, 1fr)',
              },
            }}
          >
            {visibleRows.map((row) => (
              <GalleryCard
                key={row.id}
                row={row}
                titleCol={titleCol}
                secondaryCols={secondaryCols}
                data={rowData[row.id] ?? {}}
                image={imageCache[row.id] ?? undefined}
                imageUnknown={!(row.id in imageCache) && (row.attachment_count ?? 0) > 0}
                isMobile={isMobile}
                onOpen={() => onOpenRow(row)}
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ----------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------

interface GalleryCardProps {
  row: ApiRecordRow;
  titleCol: ApiRecordColumn | undefined;
  secondaryCols: ApiRecordColumn[];
  data: RecordRowData;
  /** undefined => unknown (loading); null/object handled by `imageUnknown`. */
  image: ImageInfo | null | undefined;
  imageUnknown: boolean;
  isMobile: boolean;
  onOpen: () => void;
}

function GalleryCard({
  row,
  titleCol,
  secondaryCols,
  data,
  image,
  imageUnknown,
  isMobile,
  onOpen,
}: GalleryCardProps) {
  const titleText =
    row.display_title ??
    (titleCol && typeof data[titleCol.key] === 'string' ? (data[titleCol.key] as string) : '') ??
    'Untitled';

  return (
    <Card
      elevation={0}
      variant="outlined"
      onClick={onOpen}
      sx={{
        cursor: 'pointer',
        position: 'relative',
        bgcolor: 'background.paper',
        borderRadius: 1.5,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'transform 120ms ease, box-shadow 120ms ease',
        '&:hover': {
          boxShadow: '0 6px 18px rgba(26, 54, 93, 0.12)',
          transform: 'translateY(-1px)',
        },
        '&:focus-visible': {
          outline: '2px solid #1A365D',
          outlineOffset: 2,
        },
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* Photo area — 3:4 ratio (aspect-ratio CSS keeps it without JS). */}
      <Box
        sx={{
          width: '100%',
          aspectRatio: '3 / 4',
          bgcolor: 'background.default',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.disabled',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        {image ? (
          <Box
            component="img"
            src={image.url}
            alt={image.fileName}
            loading="lazy"
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : imageUnknown ? (
          // Placeholder while we resolve the attachment list. Don't show
          // a spinner — the cards arriving in waves is its own progress
          // indicator and a spinner per card would be visual noise.
          <NoImageIcon sx={{ fontSize: 40, opacity: 0.5 }} />
        ) : (row.attachment_count ?? 0) > 0 ? (
          // Has attachments but none are images — show a file icon and
          // count so the user knows the row is "attached, just not visual".
          <Stack spacing={0.5} alignItems="center">
            <AttachIcon sx={{ fontSize: 32, opacity: 0.6 }} />
            <Typography variant="caption" color="text.disabled">
              {row.attachment_count} {row.attachment_count === 1 ? 'file' : 'files'}
            </Typography>
          </Stack>
        ) : (
          <NoImageIcon sx={{ fontSize: 40, opacity: 0.4 }} />
        )}

        {row.attachment_count != null && row.attachment_count > 1 && image && (
          <Chip
            label={`+${row.attachment_count - 1}`}
            size="small"
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              height: 22,
              fontSize: '0.7rem',
              fontWeight: 600,
              bgcolor: 'rgba(0,0,0,0.55)',
              color: '#fff',
              border: 'none',
              backdropFilter: 'blur(4px)',
            }}
          />
        )}
      </Box>

      {/* Body */}
      <Box sx={{ p: { xs: 1, sm: 1.25 }, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            fontSize: isMobile ? '0.8125rem' : '0.875rem',
            lineHeight: 1.3,
            mb: secondaryCols.length > 0 ? 0.5 : 0,
            wordBreak: 'break-word',
            // Clamp to two lines so cards keep a predictable height.
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {titleText || 'Untitled'}
        </Typography>
        {secondaryCols.length > 0 && (
          <Stack spacing={0.25} sx={{ mt: 0.25 }}>
            {secondaryCols.map((col) => {
              const value = data[col.key];
              if (value == null || value === '') return null;
              return (
                <Box
                  key={col.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    fontSize: '0.75rem',
                    color: 'text.secondary',
                    minWidth: 0,
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                    <CellRenderer column={col} value={value} />
                  </Box>
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
    </Card>
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function pickFirstImage(attachments: ApiRecordRowAttachment[]): ImageInfo | null {
  for (const a of attachments) {
    if ((a.mime_type || '').toLowerCase().startsWith('image/')) {
      return {
        url: recordsApi.attachments.downloadUrl(a.id, { preview: true }),
        fileName: a.file_name,
      };
    }
  }
  return null;
}

function compareRows(
  a: ApiRecordRow,
  b: ApiRecordRow,
  sortKey: string | null,
  dir: 'asc' | 'desc',
  rowData: Record<string, RecordRowData>,
): number {
  const mul = dir === 'asc' ? 1 : -1;
  if (!sortKey) {
    // Default: most recent first (updated_at desc by default).
    return mul * compareStrings(a.updated_at, b.updated_at);
  }
  const av = rowData[a.id]?.[sortKey];
  const bv = rowData[b.id]?.[sortKey];
  return mul * compareCellValues(av, bv);
}

function compareCellValues(a: unknown, b: unknown): number {
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // empties last regardless of direction caller — flip handled by mul above
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b);
  // Fall back to JSON string comparison for objects/arrays so the sort
  // is at least stable per repaint, even if the order isn't meaningful.
  try {
    return compareStrings(JSON.stringify(a), JSON.stringify(b));
  } catch {
    return 0;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Box
      sx={{
        py: 10,
        textAlign: 'center',
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.default',
        px: 4,
      }}
    >
      <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {body}
      </Typography>
    </Box>
  );
}

