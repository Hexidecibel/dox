import { useState, type MouseEvent } from 'react';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  IconButton,
  Menu,
  MenuItem,
  Typography,
  ListItemIcon,
  ListItemText,
  Fade,
} from '@mui/material';
import {
  MoreHoriz as MoreIcon,
  DriveFileRenameOutline as RenameIcon,
  Inventory2Outlined as ArchiveIcon,
  TableViewOutlined as TableIcon,
} from '@mui/icons-material';
import type { ApiRecordSheet } from '../../shared/types';

/** Format an ISO timestamp as a relative "5m ago" string. Mirrors Activity.tsx. */
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(/[Zz]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / (7 * 86_400_000))}w ago`;
  return new Date(then).toLocaleDateString();
}

interface SheetCardProps {
  sheet: ApiRecordSheet;
  /** Stagger order — controls fade-in delay so the grid reveals row by row. */
  index?: number;
  /** Show menu (rename/archive). Hidden for read-only viewers. */
  canMutate?: boolean;
  onOpen: (sheet: ApiRecordSheet) => void;
  onRename: (sheet: ApiRecordSheet) => void;
  onArchive: (sheet: ApiRecordSheet) => void;
}

/**
 * A generous, lift-on-hover card for a single Records sheet. Renders the
 * name, a two-line description clamp, row-count + relative-update line,
 * and an optional context menu (Rename / Archive). The menu button stops
 * propagation so the card click navigates without firing the menu.
 */
export function SheetCard({ sheet, index = 0, canMutate = true, onOpen, onRename, onArchive }: SheetCardProps) {
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchor);

  const handleOpenMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuAnchor(e.currentTarget);
  };

  const handleCloseMenu = (e?: MouseEvent) => {
    if (e) e.stopPropagation();
    setMenuAnchor(null);
  };

  const rowCount = sheet.row_count ?? 0;
  const rowLabel = `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`;

  return (
    <Fade in timeout={400} style={{ transitionDelay: `${Math.min(index, 12) * 60}ms` }}>
      <Card
        variant="outlined"
        sx={{
          minHeight: 188,
          position: 'relative',
          overflow: 'visible',
          transition: 'transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: '0 8px 24px rgba(15, 35, 65, 0.08)',
            borderColor: 'primary.light',
            '& .sheet-card-menu': { opacity: 1 },
            '& .sheet-card-icon': { color: 'primary.main' },
          },
        }}
      >
        <CardActionArea
          onClick={() => onOpen(sheet)}
          sx={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            p: 0,
            borderRadius: 'inherit',
          }}
        >
          <CardContent sx={{ p: 3, flex: 1, display: 'flex', flexDirection: 'column', gap: 1.5, width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
              <Box
                className="sheet-card-icon"
                sx={{
                  width: 36,
                  height: 36,
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'rgba(26, 54, 93, 0.06)',
                  color: 'text.secondary',
                  transition: 'color 180ms ease',
                }}
              >
                <TableIcon fontSize="small" />
              </Box>
              {/* Spacer where the menu button lives — keeps the title from sliding when menu appears. */}
              <Box sx={{ width: 32, height: 32 }} />
            </Box>

            <Typography
              variant="h6"
              sx={{
                fontSize: '1.0625rem',
                fontWeight: 600,
                color: 'text.primary',
                lineHeight: 1.35,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {sheet.name}
            </Typography>

            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                minHeight: '2.6em',
              }}
            >
              {sheet.description || (
                <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>
                  No description
                </Box>
              )}
            </Typography>

            <Box sx={{ flex: 1 }} />

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                pt: 1,
                borderTop: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
                {rowLabel}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Updated {formatRelative(sheet.updated_at)}
              </Typography>
            </Box>
          </CardContent>
        </CardActionArea>

        {canMutate && (
          <IconButton
            className="sheet-card-menu"
            size="small"
            onClick={handleOpenMenu}
            aria-label="Sheet actions"
            sx={{
              position: 'absolute',
              top: 12,
              right: 12,
              opacity: menuOpen ? 1 : 0,
              transition: 'opacity 180ms ease, background-color 180ms ease',
              bgcolor: 'background.paper',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <MoreIcon fontSize="small" />
          </IconButton>
        )}

        <Menu
          anchorEl={menuAnchor}
          open={menuOpen}
          onClose={() => handleCloseMenu()}
          onClick={(e) => e.stopPropagation()}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem
            onClick={(e) => {
              handleCloseMenu(e);
              onRename(sheet);
            }}
          >
            <ListItemIcon>
              <RenameIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Rename</ListItemText>
          </MenuItem>
          <MenuItem
            onClick={(e) => {
              handleCloseMenu(e);
              onArchive(sheet);
            }}
          >
            <ListItemIcon>
              <ArchiveIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Archive</ListItemText>
          </MenuItem>
        </Menu>
      </Card>
    </Fade>
  );
}
