/**
 * PLACEHOLDER SCREEN — screen 4 is not built yet.
 *
 * It is wired into the stepper anyway, and deliberately so: a six-step flow
 * that renders five steps is not the flow, and nobody walking it can tell
 * whether screen 5 reads correctly in its real position. It renders as an
 * explicit "not built yet" panel rather than as an empty div or a skipped step,
 * because a blank screen in a wizard is indistinguishable from a bug.
 *
 * It states what it will do and — since screen 4 is the reason the feature
 * exists — why. Next is enabled throughout: the flow must be walkable end to
 * end today.
 *
 * The map is keyed by step rather than holding one hard-coded block so that the
 * file does not have to be restructured when the last screen lands; the
 * fallback below is what an unlisted step gets.
 */

import { Alert, AlertTitle, Box, Chip, Typography } from '@mui/material';
import { Construction as PlaceholderIcon } from '@mui/icons-material';
import type { SetupStepProps } from './stepProps';

interface PlaceholderCopy {
  title: string;
  body: string;
}

const COPY: Record<number, PlaceholderCopy> = {
  4: {
    title: 'One document, several boxes',
    body: 'The teaching screen, and the reason this wizard exists: a real specification sheet on the left, this tenant’s own checklist on the right, and a counter that redraws as boxes are ticked. The lesson is that a document TYPE is not a checklist REQUIREMENT — one file can close nine line items, and a certificate of analysis, which looks like it should close the same ones, closes exactly one.',
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
