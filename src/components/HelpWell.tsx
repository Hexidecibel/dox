/**
 * HelpWell — dismissible info banner for self-documenting pages.
 *
 * Rendered at the top of a page (or section) to give the user a
 * one-paragraph "what is this surface for?" explanation without
 * pushing them out into separate docs. Dismissed wells stay
 * dismissed via localStorage keyed by `id`.
 *
 * Visually: MUI Alert (severity=info, variant=outlined). Quiet by
 * design — helpful context, not a modal popup.
 *
 * @example
 *   <HelpWell id="connectors.list" title="Connectors">
 *     {helpContent.connectors.list.well}
 *   </HelpWell>
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertTitle, IconButton, Box } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';

export interface HelpWellProps {
  /** Stable key for tracking dismissal in localStorage. */
  id: string;
  /** Optional title for the well; if omitted, no title row. */
  title?: string;
  /** Body content. */
  children: React.ReactNode;
  /** Whether the well can be dismissed (default true). */
  dismissible?: boolean;
}

/** localStorage key used to track dismissal for a given well id. */
export function helpWellStorageKey(id: string): string {
  return `dox.helpwell.${id}.dismissed`;
}

/** Read dismissal state from localStorage, swallowing access errors. */
function readDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(helpWellStorageKey(id)) === '1';
  } catch {
    return false;
  }
}

/** Persist dismissal to localStorage, swallowing access errors. */
function writeDismissed(id: string): void {
  try {
    window.localStorage.setItem(helpWellStorageKey(id), '1');
  } catch {
    // ignore — quota / privacy mode / SSR
  }
}

export function HelpWell({
  id,
  title,
  children,
  dismissible = true,
}: HelpWellProps) {
  // Lazy initial state so the first paint matches localStorage rather
  // than flashing the well briefly before hiding.
  const [dismissed, setDismissed] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readDismissed(id),
  );

  // Re-sync when the id prop changes (e.g. modal reuses the same component).
  useEffect(() => {
    setDismissed(readDismissed(id));
  }, [id]);

  const handleDismiss = useCallback(() => {
    writeDismissed(id);
    setDismissed(true);
  }, [id]);

  if (dismissed) return null;

  return (
    <Alert
      severity="info"
      variant="outlined"
      icon={false}
      sx={{
        mb: 2,
        bgcolor: 'background.paper',
        '& .MuiAlert-message': { width: '100%' },
      }}
      action={
        dismissible ? (
          <IconButton
            aria-label="Dismiss help"
            size="small"
            onClick={handleDismiss}
            sx={{ color: 'text.secondary' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : undefined
      }
    >
      {title && (
        <AlertTitle sx={{ fontWeight: 600, mb: 0.5 }}>{title}</AlertTitle>
      )}
      <Box sx={{ color: 'text.secondary', fontSize: '0.875rem' }}>
        {children}
      </Box>
    </Alert>
  );
}
