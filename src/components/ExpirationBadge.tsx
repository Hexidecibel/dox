import { Chip } from '@mui/material';

interface ExpirationBadgeProps {
  expiresAt: string | null;
  size?: 'small' | 'medium';
}

/**
 * Computes days remaining and renders a color-coded MUI Chip.
 *
 * - green   "Xd"              for >60 days
 * - orange  "Xd"              for 14-60 days
 * - red     "Xd"              for 0-14 days
 * - dark red "Expired Xd ago" for past dates
 * - grey    "No expiry"       if null
 */
export function ExpirationBadge({ expiresAt, size = 'small' }: ExpirationBadgeProps) {
  if (!expiresAt) {
    return (
      <Chip
        label="No expiry"
        size={size}
        variant="outlined"
        sx={{ color: 'text.secondary', borderColor: 'divider' }}
      />
    );
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const expires = new Date(expiresAt + (expiresAt.includes('T') ? '' : 'T00:00:00Z'));
  const diffMs = expires.getTime() - now.getTime();
  const daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  let label: string;
  let bgcolor: string;
  let color: string;

  if (daysRemaining < 0) {
    label = `Expired ${Math.abs(daysRemaining)}d ago`;
    bgcolor = '#b71c1c';
    color = '#fff';
  } else if (daysRemaining <= 14) {
    label = `${daysRemaining}d`;
    bgcolor = '#d32f2f';
    color = '#fff';
  } else if (daysRemaining <= 60) {
    label = `${daysRemaining}d`;
    bgcolor = '#ed6c02';
    color = '#fff';
  } else {
    label = `${daysRemaining}d`;
    bgcolor = '#2e7d32';
    color = '#fff';
  }

  return (
    <Chip
      label={label}
      size={size}
      sx={{ bgcolor, color, fontWeight: 600 }}
    />
  );
}
