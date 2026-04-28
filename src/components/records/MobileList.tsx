/**
 * MobileList — phone-sized rendering of the sheet's rows.
 *
 * Wedge-against-Smartsheet decisions:
 *   - Real cards, not a shrunken table. Each row's title is the
 *     primary visual, with 2–3 secondary columns inline.
 *   - Touch targets are >= 44px. Card padding is generous.
 *   - Swipe-left on a card reveals an Archive action (Material gesture).
 *   - Pull-to-refresh on the scroll container.
 *   - Floating action button (56px) bottom-right in the thumb zone.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Fab,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutline as ArchiveIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { CellRenderer } from './CellRenderer';
import { pickMobileSecondaryColumns } from './cellHelpers';
import type { ApiRecordColumn, ApiRecordRow, RecordRowData } from '../../../shared/types';

interface MobileListProps {
  columns: ApiRecordColumn[];
  rows: ApiRecordRow[];
  rowData: Record<string, RecordRowData>;
  canMutate: boolean;
  onOpenRow: (row: ApiRecordRow) => void;
  onAddRow: () => void;
  onArchiveRow: (row: ApiRecordRow) => void;
  /** Called when the user pulls down past threshold. */
  onRefresh: () => Promise<void>;
}

const PULL_THRESHOLD = 70;
const SWIPE_REVEAL_PX = 88;

export function MobileList({
  columns,
  rows,
  rowData,
  canMutate,
  onOpenRow,
  onAddRow,
  onArchiveRow,
  onRefresh,
}: MobileListProps) {
  const titleCol = columns.find((c) => c.is_title === 1) ?? columns[0];
  const secondary = pickMobileSecondaryColumns(columns, 3);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);

  // Pull-to-refresh
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop > 0) return;
      pullStartY.current = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pullStartY.current === null) return;
      const dy = e.touches[0].clientY - pullStartY.current;
      if (dy > 0) {
        // Prevent the OS from also doing pull-to-refresh on the page.
        if (e.cancelable) e.preventDefault();
        setPullDistance(Math.min(dy, PULL_THRESHOLD * 1.5));
      }
    };
    const onTouchEnd = async () => {
      if (pullStartY.current === null) return;
      pullStartY.current = null;
      if (pullDistance >= PULL_THRESHOLD && !refreshing) {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
      setPullDistance(0);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [pullDistance, refreshing, onRefresh]);

  return (
    <Box sx={{ position: 'relative', height: '100%' }}>
      {/* Pull-to-refresh indicator */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: PULL_THRESHOLD,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
          transform: `translateY(${pullDistance - PULL_THRESHOLD}px)`,
          transition: refreshing ? 'transform 0.2s' : pullStartY.current === null ? 'transform 0.25s' : 'none',
          pointerEvents: 'none',
          opacity: pullDistance / PULL_THRESHOLD,
        }}
      >
        <RefreshIcon
          fontSize="small"
          sx={{
            transform: `rotate(${(pullDistance / PULL_THRESHOLD) * 180}deg)`,
            mr: 1,
            ...(refreshing && { animation: 'spin 0.8s linear infinite' }),
            '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
          }}
        />
        <Typography variant="caption">{refreshing ? 'Refreshing…' : 'Release to refresh'}</Typography>
      </Box>

      <Box
        ref={containerRef}
        sx={{
          height: '100%',
          overflow: 'auto',
          WebkitOverflowScrolling: 'touch',
          px: 2,
          pt: 2,
          pb: 11, // room for FAB
          transform: pullStartY.current !== null ? `translateY(${pullDistance}px)` : 'translateY(0)',
          transition: pullStartY.current === null ? 'transform 0.2s ease' : 'none',
        }}
      >
        {rows.length === 0 ? (
          <Box sx={{ py: 8, textAlign: 'center' }}>
            <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>No rows yet</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Tap the + button to add your first row.
            </Typography>
            {canMutate && (
              <Button variant="contained" startIcon={<AddIcon />} onClick={onAddRow} size="large">
                Add the first row
              </Button>
            )}
          </Box>
        ) : (
          rows.map((row) => (
            <SwipeableCard
              key={row.id}
              titleCol={titleCol}
              secondaryCols={secondary}
              data={rowData[row.id] ?? {}}
              onTap={() => onOpenRow(row)}
              onArchive={canMutate ? () => onArchiveRow(row) : undefined}
              displayTitle={row.display_title}
            />
          ))
        )}
      </Box>

      {canMutate && (
        <Fab
          color="primary"
          aria-label="Add row"
          onClick={onAddRow}
          sx={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            width: 56,
            height: 56,
            zIndex: 10,
          }}
        >
          <AddIcon />
        </Fab>
      )}
    </Box>
  );
}

interface SwipeableCardProps {
  titleCol: ApiRecordColumn | undefined;
  secondaryCols: ApiRecordColumn[];
  data: RecordRowData;
  displayTitle: string | null;
  onTap: () => void;
  onArchive?: () => void;
}

function SwipeableCard({ titleCol, secondaryCols, data, displayTitle, onTap, onArchive }: SwipeableCardProps) {
  const [offset, setOffset] = useState(0);
  const startX = useRef<number | null>(null);
  const moved = useRef(false);
  const [revealed, setRevealed] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!onArchive) return;
    startX.current = e.touches[0].clientX;
    moved.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null) return;
    const dx = e.touches[0].clientX - startX.current;
    if (Math.abs(dx) > 4) moved.current = true;
    if (dx < 0) {
      setOffset(Math.max(dx, -SWIPE_REVEAL_PX));
    } else if (revealed) {
      setOffset(Math.min(dx - SWIPE_REVEAL_PX, 0));
    }
  };
  const onTouchEnd = () => {
    startX.current = null;
    if (offset < -SWIPE_REVEAL_PX / 2) {
      setOffset(-SWIPE_REVEAL_PX);
      setRevealed(true);
    } else {
      setOffset(0);
      setRevealed(false);
    }
  };

  const handleClick = () => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (revealed) {
      setOffset(0);
      setRevealed(false);
      return;
    }
    onTap();
  };

  const titleText = displayTitle
    ?? (titleCol && typeof data[titleCol.key] === 'string' ? (data[titleCol.key] as string) : '')
    ?? 'Untitled';

  return (
    <Box sx={{ position: 'relative', mb: 1.5, minHeight: 88 }}>
      {/* Archive reveal layer */}
      {onArchive && (
        <Box
          onClick={() => {
            onArchive();
            setOffset(0);
            setRevealed(false);
          }}
          sx={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: SWIPE_REVEAL_PX,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'error.main',
            color: 'common.white',
            borderRadius: 1,
            cursor: 'pointer',
          }}
        >
          <ArchiveIcon />
          <Typography variant="caption" sx={{ ml: 1, fontWeight: 600 }}>Archive</Typography>
        </Box>
      )}
      <Card
        elevation={0}
        variant="outlined"
        onClick={handleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        sx={{
          position: 'relative',
          transform: `translateX(${offset}px)`,
          transition: startX.current === null ? 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
          cursor: 'pointer',
          minHeight: 88,
          p: 2,
          bgcolor: 'background.paper',
          '&:active': { bgcolor: 'action.hover' },
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1, lineHeight: 1.3, wordBreak: 'break-word' }}>
          {titleText || 'Untitled'}
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          {secondaryCols.map((col) => {
            const value = data[col.key];
            if (value == null || value === '') return null;
            return (
              <Box
                key={col.id}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  fontSize: '0.8125rem',
                  color: 'text.secondary',
                  maxWidth: '100%',
                }}
              >
                <Box component="span" sx={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>
                  {col.label}
                </Box>
                <CellRenderer column={col} value={value} />
              </Box>
            );
          })}
        </Box>
      </Card>
    </Box>
  );
}
