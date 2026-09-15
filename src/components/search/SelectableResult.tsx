import { Box, Button, Checkbox, Tooltip } from '@mui/material';
import type { UniversalSearchDocument } from '../../../shared/types';

/**
 * Selection on a search result — the first half of "get the documents out".
 *
 * WHY A NON-MATCHING RESULT HAS NO CHECKBOX UNTIL YOU ASK FOR ONE.
 * The coverage view (v2.11–2.13) spent a lot of effort making "this covers
 * what you asked" and "this is nearby and does not" two different statements.
 * A checkbox on every row would quietly undo that: the whole point of sending
 * documents to a customer is that somebody stands behind the set. So a
 * covering result is selectable directly, and a likely / nearby one has to be
 * opted into with a button that says what it is — one click, never silent,
 * recorded in the person's own head as a decision rather than a default.
 *
 * An UNCONSTRAINED search (no coverage claim was made at all) is a plain list
 * and is selectable directly: there is no claim to undo.
 */
export interface SearchSelection {
  /** Ids currently selected, across every search this session. */
  selectedIds: Set<string>;
  /** Non-covering ids the person explicitly opted into. */
  includedAnyway: Set<string>;
  onToggle: (doc: UniversalSearchDocument) => void;
  /** Opt a non-covering result in: reveals its checkbox AND selects it. */
  onIncludeAnyway: (doc: UniversalSearchDocument) => void;
  onSelectMany: (docs: UniversalSearchDocument[]) => void;
}

export interface SelectableResultProps {
  doc: UniversalSearchDocument;
  selection?: SearchSelection;
  /** 'covering' and 'plain' select directly; 'opt_in' needs the button first. */
  mode: 'covering' | 'plain' | 'opt_in';
  children: React.ReactNode;
}

export function SelectableResult({ doc, selection, mode, children }: SelectableResultProps) {
  if (!selection) return <>{children}</>;

  const checked = selection.selectedIds.has(doc.id);
  const needsOptIn = mode === 'opt_in' && !checked && !selection.includedAnyway.has(doc.id);

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
      <Box sx={{ pt: 1.25, width: 42, flexShrink: 0 }}>
        {needsOptIn ? (
          <Tooltip title="This does not match everything you asked for. Include it anyway.">
            <Button
              size="small"
              onClick={() => selection.onIncludeAnyway(doc)}
              sx={{ textTransform: 'none', minWidth: 0, px: 0.5, fontSize: '0.7rem', lineHeight: 1.2 }}
              data-testid={`include-anyway-${doc.id}`}
            >
              Include anyway
            </Button>
          </Tooltip>
        ) : (
          <Checkbox
            size="small"
            checked={checked}
            onChange={() => selection.onToggle(doc)}
            inputProps={
              {
                'aria-label': `Select ${doc.title ?? 'document'}`,
                'data-testid': `select-${doc.id}`,
              } as React.InputHTMLAttributes<HTMLInputElement>
            }
          />
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}
