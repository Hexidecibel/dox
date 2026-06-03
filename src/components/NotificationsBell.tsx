/**
 * NotificationsBell — top-bar bell with a badge + dropdown tray surfacing the
 * current user's actionable notifications.
 *
 * Today the tray is fed by a single source: pending workflow approvals
 * (`recordsApi.workflowApprovals.inbox()`). The internal model is a generic
 * `Notification` list (each tagged with a `type`) so other notification kinds
 * can be appended later without reworking the UI — but only the approvals feed
 * is wired now. Keep it simple.
 *
 * Behaviour:
 *  - Fetch on mount, then on a light 3-minute interval, and again whenever the
 *    menu opens (so the count is fresh when the user looks).
 *  - Badge = number of pending approvals; hidden at 0.
 *  - Fetch errors are swallowed (empty tray, no crash).
 *  - Rows + footer navigate to /approvals, which owns approve/reject.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemButton,
  ListItemText,
  Menu,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  NotificationsNone as BellIcon,
  AccountTree as WorkflowIcon,
} from '@mui/icons-material';
import { recordsApi } from '../lib/recordsApi';
import type { WorkflowApprovalInboxItem } from '../../shared/types';

const POLL_MS = 3 * 60 * 1000; // 3 minutes
const MAX_VISIBLE = 6;

/** Generic tray item. Extend the union as new sources are added. */
interface Notification {
  id: string;
  type: 'approval';
  title: string;
  /** e.g. "Step name · Sheet name" */
  subtitle: string;
  /** ISO date string or null. */
  dueAt: string | null;
}

function approvalToNotification(item: WorkflowApprovalInboxItem): Notification {
  const parts = [item.step_name, item.sheet_name].filter(Boolean);
  return {
    id: item.step_run_id,
    type: 'approval',
    title: item.row_title || 'Untitled record',
    subtitle: parts.join(' · '),
    dueAt: item.due_at,
  };
}

function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function NotificationsBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  // Avoid overlapping fetches if a poll and a menu-open coincide.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await recordsApi.workflowApprovals.inbox();
      setNotifications((res.items ?? []).map(approvalToNotification));
    } catch {
      // Swallow — show an empty tray rather than crashing the top bar.
      setNotifications([]);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleOpen = (e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
    void refresh();
  };
  const handleClose = () => setAnchorEl(null);

  const goToApprovals = () => {
    handleClose();
    navigate('/approvals');
  };

  const count = notifications.length;
  const visible = notifications.slice(0, MAX_VISIBLE);

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton onClick={handleOpen} aria-label="notifications">
          <Badge badgeContent={count} color="error" overlap="circular">
            <BellIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 340, maxWidth: '90vw' } } }}
      >
        <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Notifications
          </Typography>
        </Box>
        <Divider />

        {count === 0 ? (
          <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              You're all caught up.
            </Typography>
          </Box>
        ) : (
          <Box>
            {visible.map((n) => {
              const due = formatDue(n.dueAt);
              return (
                <ListItemButton key={n.id} onClick={goToApprovals} sx={{ alignItems: 'flex-start', py: 1 }}>
                  <WorkflowIcon sx={{ fontSize: 18, color: 'text.secondary', mt: 0.3, mr: 1.25 }} />
                  <ListItemText
                    primary={n.title}
                    secondary={[n.subtitle, due].filter(Boolean).join(' · ')}
                    primaryTypographyProps={{ variant: 'body2', fontWeight: 600, noWrap: true }}
                    secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
                  />
                </ListItemButton>
              );
            })}
          </Box>
        )}

        <Divider />
        <Box sx={{ p: 1 }}>
          <Button fullWidth size="small" onClick={goToApprovals}>
            See all approvals
          </Button>
        </Box>
      </Menu>
    </>
  );
}
