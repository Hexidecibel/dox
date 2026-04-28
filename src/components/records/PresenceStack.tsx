/**
 * PresenceStack — small avatar stack of who else is viewing this sheet.
 * Presence comes from the SheetSession DO snapshot/join/leave events.
 *
 * Phase 1 surface: deduplicate by userId (one user with multiple tabs
 * shows up once), exclude the current user, render up to 3 avatars + an
 * overflow chip. Names aren't joined onto presence yet — we render
 * initials derived from userId. Wiring user metadata is a follow-up.
 */

import { Avatar, AvatarGroup, Box, Tooltip } from '@mui/material';
import type { SheetPresenceEntry } from '../../hooks/useSheetSession';

interface PresenceStackProps {
  presence: SheetPresenceEntry[];
  /** Current user's id so we can exclude self from the stack. */
  selfUserId: string | null;
  /** Map userId -> display name (falls back to short id). */
  userNames?: Record<string, string>;
}

const COLORS = ['#1A365D', '#2E7D32', '#874100', '#9A1F1F', '#4A148C', '#01579B', '#37474F'];

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

export function PresenceStack({ presence, selfUserId, userNames }: PresenceStackProps) {
  const seen = new Set<string>();
  const others = presence.filter((p) => {
    if (p.userId === selfUserId) return false;
    if (seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });

  if (others.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <AvatarGroup
        max={4}
        sx={{
          '& .MuiAvatar-root': {
            width: 28,
            height: 28,
            fontSize: '0.75rem',
            fontWeight: 600,
            border: '2px solid',
            borderColor: 'background.paper',
          },
        }}
      >
        {others.map((p) => {
          const name = userNames?.[p.userId] ?? p.userId.slice(0, 6);
          const color = colorFor(p.userId);
          return (
            <Tooltip key={p.sessionId} title={`${name} is viewing`} arrow>
              <Avatar sx={{ bgcolor: color }}>{initialsFor(name)}</Avatar>
            </Tooltip>
          );
        })}
      </AvatarGroup>
    </Box>
  );
}
