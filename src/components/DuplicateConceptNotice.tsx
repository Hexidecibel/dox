/**
 * "You already have this" for the three vocabulary screens (document types,
 * requirements, claim types).
 *
 * The server refuses to create -- or rename into -- a name the organisation
 * already uses, or one its starter pack lists as another name for something it
 * has (409 `duplicate_concept`, shared/duplicateConcept.ts). The same concept
 * under two slugs is the one thing a starter-pack update can never reach, so
 * the refusal names the row and this notice gives the person their real
 * choices: use the one that exists, create it as the pack's item, or say out
 * loud that a separate one is what they want. The last is audited.
 */

import { Alert, AlertTitle, Box, Button } from '@mui/material';
import { useCallback, useState } from 'react';
import { ApiError } from '../lib/apiError';
import type { DuplicateConcept } from '../../shared/duplicateConcept';

export interface DuplicateConceptState {
  message: string;
  duplicate: DuplicateConcept;
}

/** What a save may be told once the person has read the notice. */
export interface DuplicateConceptChoice {
  allow_duplicate?: boolean;
  adopt_pack_slug?: boolean;
}

/** Pull the refusal out of a thrown save error; null when it is some other error. */
export function duplicateConceptFromError(err: unknown): DuplicateConceptState | null {
  if (!(err instanceof ApiError) || err.code !== 'duplicate_concept') return null;
  const body = err.body as { duplicate?: DuplicateConcept } | undefined;
  if (!body?.duplicate) return null;
  return { message: err.message, duplicate: body.duplicate };
}

/** The dialog state every vocabulary screen keeps: the refusal, and clearing it. */
export function useDuplicateConcept() {
  const [duplicate, setDuplicate] = useState<DuplicateConceptState | null>(null);
  const clear = useCallback(() => setDuplicate(null), []);
  /** Returns true when the error was a duplicate refusal (and is now on show). */
  const capture = useCallback((err: unknown): boolean => {
    const found = duplicateConceptFromError(err);
    if (found) setDuplicate(found);
    return found !== null;
  }, []);
  return { duplicate, clear, capture };
}

interface Props {
  state: DuplicateConceptState;
  /** True when the dialog is renaming an existing row rather than creating one. */
  renaming: boolean;
  busy: boolean;
  onChoose: (choice: DuplicateConceptChoice) => void;
  onDismiss: () => void;
}

export function DuplicateConceptNotice({ state, renaming, busy, onChoose, onDismiss }: Props) {
  const { duplicate, message } = state;
  const fromPack = duplicate.source === 'pack';
  return (
    <Alert severity="warning" sx={{ mb: 2 }} onClose={busy ? undefined : onDismiss} data-testid="duplicate-concept">
      <AlertTitle>{fromPack ? 'The starter pack already defines this' : 'You already have this'}</AlertTitle>
      {message}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
        {fromPack && !renaming && (
          <Button size="small" variant="contained" disabled={busy} onClick={() => onChoose({ adopt_pack_slug: true })}>
            Create it as the pack's item
          </Button>
        )}
        <Button size="small" variant="outlined" color="warning" disabled={busy} onClick={() => onChoose({ allow_duplicate: true })}>
          {renaming ? 'Rename it anyway' : 'Create a separate one anyway'}
        </Button>
        <Button size="small" disabled={busy} onClick={onDismiss}>
          Go back
        </Button>
      </Box>
    </Alert>
  );
}

/** One sentence under the name field of an existing row. */
export function slugStaysNote(slug: string): string {
  return (
    `Rename it freely. Its internal slug (${slug}) is set once and never changes: ` +
    'starter-pack updates, supplier packets and saved links find it by that slug, whatever it is called.'
  );
}
