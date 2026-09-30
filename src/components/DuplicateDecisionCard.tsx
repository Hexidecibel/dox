/**
 * "You already have this" (migration 0132) -- the choice a person makes when a
 * file arrives that we already hold, byte for byte or as a newer revision.
 *
 *   Replace existing (becomes vN+1)   primary, the default: approving adds a
 *                                     new version to the document on file
 *   Keep as a new document            approving makes a separate document
 *   Discard                           close this card without touching the
 *                                     document on file (a rejection with the
 *                                     reason "Discarded: already have it")
 *
 * Used on the Review Queue card and, with `onChoose`, on the Import page right
 * after upload, so the words a person sees are the same in both places.
 */

import { Alert, AlertTitle, Box, Button, Link, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { formatDate } from '../utils/format';
import { keptVersionsLabel, replaceButtonLabel } from '../../shared/duplicateProposal';
import type { DuplicateDecision, DuplicateProposal } from '../../shared/types';

/** "You already have this: <title>, <supplier>, approved <date>". */
export function AlreadyHaveSentence({ proposal }: { proposal: DuplicateProposal }) {
  return (
    <>
      You already have this:{' '}
      <Link component={RouterLink} to={`/documents/${proposal.document_id}`} onClick={(e) => e.stopPropagation()}>
        {proposal.document_title}
      </Link>
      {proposal.supplier_name ? `, ${proposal.supplier_name}` : ''}
      {proposal.approved_at ? `, approved ${formatDate(proposal.approved_at)}` : ''}.
      {proposal.documents.length > 1 ? ` (${proposal.documents.length} documents, one per lot.)` : ''}
    </>
  );
}

export function DuplicateDecisionCard({
  proposal,
  value,
  onChange,
  onDiscard,
  replaceDisabledReason,
  busy = false,
  compact = false,
}: {
  proposal: DuplicateProposal;
  /** The approval choice in force (discard is an action, not a selection). */
  value: Exclude<DuplicateDecision, 'discard'>;
  onChange: (next: Exclude<DuplicateDecision, 'discard'>) => void;
  onDiscard: () => void;
  /** When set, Replace is shown disabled with this explanation. */
  replaceDisabledReason?: string | null;
  busy?: boolean;
  compact?: boolean;
}) {
  const replaceDisabled = !!replaceDisabledReason;
  return (
    <Alert severity="warning" sx={{ mb: compact ? 1 : 2 }} data-testid="already-have-card" onClick={(e) => e.stopPropagation()}>
      <AlertTitle sx={{ mb: 0.5 }}>
        <AlreadyHaveSentence proposal={proposal} />
      </AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Why: {proposal.reason}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
        <Box>
          <Tooltip title={replaceDisabledReason ?? ''} arrow>
            <span>
              <Button
                size="small"
                variant={value === 'replace' && !replaceDisabled ? 'contained' : 'outlined'}
                color="primary"
                disabled={busy || replaceDisabled}
                onClick={() => onChange('replace')}
                aria-pressed={value === 'replace'}
                data-testid="duplicate-replace"
              >
                {replaceButtonLabel(proposal.next_version)}
              </Button>
            </span>
          </Tooltip>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
            {keptVersionsLabel(proposal.current_version)}
          </Typography>
        </Box>
        <Button
          size="small"
          variant={value === 'keep_both' || replaceDisabled ? 'contained' : 'outlined'}
          color="inherit"
          disabled={busy}
          onClick={() => onChange('keep_both')}
          aria-pressed={value === 'keep_both'}
          data-testid="duplicate-keep"
        >
          Keep as a new document
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="error"
          disabled={busy}
          onClick={onDiscard}
          data-testid="duplicate-discard"
        >
          Discard
        </Button>
      </Stack>
      {!compact && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {value === 'replace' && !replaceDisabled
            ? `Approve adds this file to "${proposal.document_title}" as v${proposal.next_version}, with what you confirm below. Nothing is deleted.`
            : 'Approve makes a separate document. The one on file is not changed.'}{' '}
          Discard closes this card without changing anything on file.
        </Typography>
      )}
    </Alert>
  );
}
