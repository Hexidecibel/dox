/**
 * PLACEHOLDER SCREENS — screens 2, 4 and 6 are not built yet.
 *
 * They are wired into the stepper anyway, and deliberately so: a six-step flow
 * that renders four steps is not the flow, and nobody walking it can tell
 * whether screen 5 reads correctly in its real position. These render as an
 * explicit "not built yet" panel rather than as an empty div or a skipped step,
 * because a blank screen in a wizard is indistinguishable from a bug.
 *
 * Each one states what it will do and — for screen 4, which is the reason the
 * feature exists — why. Next is enabled throughout: the flow must be walkable
 * end to end today.
 */

import { Alert, AlertTitle, Box, Chip, Typography } from '@mui/material';
import { Construction as PlaceholderIcon } from '@mui/icons-material';
import type { SetupStepProps } from './stepProps';

interface PlaceholderCopy {
  title: string;
  body: string;
}

const COPY: Record<number, PlaceholderCopy> = {
  2: {
    title: 'Which parts of the portal you use',
    body: 'Turning modules on and off per tenant — Supplier Documents, Compliance, Order Fulfillment, Records. The tables and the gate already exist (migration 0099); this screen is the switch.',
  },
  4: {
    title: 'One document, several boxes',
    body: 'The teaching screen, and the reason this wizard exists: a real specification sheet on the left, this tenant’s own checklist on the right, and a counter that redraws as boxes are ticked. The lesson is that a document TYPE is not a checklist REQUIREMENT — one file can close nine line items, and a certificate of analysis, which looks like it should close the same ones, closes exactly one.',
  },
  6: {
    title: 'Drop a document through it',
    body: 'A real file through the real pipeline, traced live: classification, the type-level reading instructions, the spec check, and the checklist items the approved document would close. With honest failure states — the worker can be down — and a "finish without the demo" way out.',
  },
};

export function StepPlaceholder({ run }: SetupStepProps) {
  const copy = COPY[run.current_step] ?? {
    title: 'Not built yet',
    body: 'This screen is part of the planned flow and has not been implemented.',
  };

  return (
    <Box>
      <Alert severity="info" icon={<PlaceholderIcon />}>
        <AlertTitle>
          {copy.title} <Chip size="small" label="not built yet" sx={{ ml: 1 }} />
        </AlertTitle>
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {copy.body}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          The step is wired into the flow so the wizard is walkable end to end. Continue — nothing
          here is a prerequisite for the screens after it.
        </Typography>
      </Alert>
    </Box>
  );
}

export default StepPlaceholder;
