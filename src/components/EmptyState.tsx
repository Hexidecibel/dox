/**
 * EmptyState — explanatory placeholder for empty lists/grids.
 *
 * Replaces the bare "No data found" rows that creep into list views.
 * Renders a centered, generously-padded card with optional icon,
 * headline, supporting text, and a single action button.
 *
 * Visually: outlined Card with a dashed border so it reads as
 * "intentional emptiness" rather than a loading state.
 *
 * @example
 *   <EmptyState
 *     title="No connectors yet"
 *     description="Connectors ingest from external systems."
 *     actionLabel="New connector"
 *     onAction={() => navigate('/admin/connectors/new')}
 *   />
 */

import { Box, Button, Card, CardContent, Typography } from '@mui/material';

export interface EmptyStateProps {
  /** Headline (e.g. "No connectors yet"). */
  title: string;
  /** Optional supporting text — explain why empty + what to do. */
  description?: React.ReactNode;
  /** Optional action button label. */
  actionLabel?: string;
  /** Optional click handler for the action. */
  onAction?: () => void;
  /** Optional MUI icon component to render above title. */
  icon?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
}: EmptyStateProps) {
  const hasAction = Boolean(actionLabel && onAction);

  return (
    <Card
      variant="outlined"
      sx={{
        borderStyle: 'dashed',
        borderColor: 'divider',
        bgcolor: 'transparent',
      }}
    >
      <CardContent
        sx={{
          textAlign: 'center',
          py: { xs: 6, sm: 8 },
          px: 3,
        }}
      >
        {icon && (
          <Box
            sx={{
              width: 64,
              height: 64,
              borderRadius: 2,
              mx: 'auto',
              mb: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(26, 54, 93, 0.05)',
              color: 'primary.main',
            }}
          >
            {icon}
          </Box>
        )}
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
          {title}
        </Typography>
        {description && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: 460, mx: 'auto', mb: hasAction ? 3 : 0 }}
          >
            {description}
          </Typography>
        )}
        {hasAction && (
          <Button variant="outlined" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
