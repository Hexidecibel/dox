/**
 * InfoTooltip — small (?) icon next to a label that opens hover/click help.
 *
 * Use next to form labels, table headers, or anywhere a single concept
 * needs a one-liner explanation. Mirrors the visual + interaction shape
 * of <CopyId> (size="small" IconButton wrapped in a MUI Tooltip).
 *
 * Accessibility: the IconButton owns aria-label="Help" so screen
 * readers announce the affordance, and the tooltip is keyboard-
 * focusable. Click also opens (mobile-friendly — hover doesn't fire on
 * touch devices).
 *
 * @example
 *   <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
 *     <Typography variant="body2">External ref</Typography>
 *     <InfoTooltip text="Stable upstream identifier; ingest matches on this." />
 *   </Box>
 */

import { useState } from 'react';
import { IconButton, Tooltip, type TooltipProps } from '@mui/material';
import { InfoOutlined as InfoIcon } from '@mui/icons-material';

export interface InfoTooltipProps {
  /** Plain-text help string. */
  text?: string;
  /** Or rich content; if both provided, children wins. */
  children?: React.ReactNode;
  /** MUI tooltip placement. */
  placement?: TooltipProps['placement'];
  /** Icon size override; default 'small'. */
  size?: 'small' | 'medium';
}

export function InfoTooltip({
  text,
  children,
  placement = 'top',
  size = 'small',
}: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const content = children ?? text ?? '';
  if (!content) return null;

  const fontSize = size === 'small' ? 14 : 18;

  return (
    <Tooltip
      title={content}
      placement={placement}
      arrow
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      // disableInteractive lets the tooltip dismiss as soon as hover
      // leaves the icon — feels snappier for one-line help.
      disableInteractive
    >
      <IconButton
        aria-label="Help"
        size={size}
        // Click toggles for mobile/touch where hover doesn't fire.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        sx={{ p: 0.25, color: 'text.disabled' }}
      >
        <InfoIcon sx={{ fontSize }} />
      </IconButton>
    </Tooltip>
  );
}
