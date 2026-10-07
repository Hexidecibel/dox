import { forwardRef } from 'react';
import { Box, ButtonBase, CircularProgress, InputBase, LinearProgress, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import type { Clause } from '../../../shared/searchQuery';
import type { SearchConstraint } from '../../../shared/types';
import { AI_VIOLET, ClauseChip } from './ClauseChip';
import { Kbd } from './AnswerCard';

/**
 * The Easy omnibox (search redesign Phase 2): one wide input, and under it the
 * query as chips.
 *
 *   kept chips   the clauses in the query (solid) — from Enter, a facet, the
 *                AI, a saved search or a shared link;
 *   live chips   how what is STILL IN THE BOX reads right now (dashed). The
 *                browser shows its own reading at once and the server's
 *                tenant-aware one replaces it within the same request. They
 *                are already part of the search; Enter keeps them.
 *
 * Every chip opens the clause editor. Keys: Enter keeps, ⌘/Ctrl+Enter asks
 * the AI, Backspace in an empty box removes the last kept chip.
 */
export interface OmniboxProps {
  text: string;
  onTextChange: (text: string) => void;
  kept: Clause[];
  live: Clause[];
  /** The live chips are the browser's reading; the server's is on its way. */
  livePending?: boolean;
  labels?: Record<string, string>;
  constraintFor?: (clauseId: string) => SearchConstraint | null;
  onCommit: () => void;
  onBackspaceEmpty: () => void;
  onOpenChip: (id: string, live: boolean, anchor: HTMLElement) => void;
  onRemoveChip: (id: string, live: boolean) => void;
  registerChip?: (id: string, el: HTMLElement | null) => void;
  selectedChipId?: string | null;
  onAskAi: () => void;
  aiBusy?: boolean;
  busy?: boolean;
  placeholder?: string;
  modKey: string;
}

export const Omnibox = forwardRef<HTMLInputElement, OmniboxProps>(function Omnibox(
  {
    text,
    onTextChange,
    kept,
    live,
    livePending = false,
    labels = {},
    constraintFor,
    onCommit,
    onBackspaceEmpty,
    onOpenChip,
    onRemoveChip,
    registerChip,
    selectedChipId,
    onAskAi,
    aiBusy = false,
    busy = false,
    placeholder = 'butter produced Sep 2 · PO 4500123 · lot 20726114-02',
    modKey,
  },
  inputRef,
) {
  const hasChips = kept.length + live.length > 0;
  return (
    <Box
      data-testid="omnibox"
      sx={(t) => ({
        position: 'relative',
        borderRadius: 4,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        boxShadow: '0 1px 2px rgba(15,26,46,.05), 0 14px 34px -18px rgba(15,26,46,.28)',
        transition: 'border-color .15s, box-shadow .15s',
        overflow: 'hidden',
        '&:focus-within': {
          borderColor: alpha(t.palette.primary.main, 0.55),
          boxShadow: `0 0 0 4px ${alpha(t.palette.primary.main, 0.1)}, 0 14px 34px -18px rgba(15,26,46,.28)`,
        },
      })}
    >
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: { xs: 1.5, sm: 2 }, py: { xs: 1, sm: 1.25 } }}>
        <SearchRoundedIcon sx={{ color: 'text.secondary', fontSize: 24, flexShrink: 0 }} />
        <InputBase
          inputRef={inputRef}
          value={text}
          autoFocus
          fullWidth
          placeholder={placeholder}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onAskAi();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onCommit();
            } else if (e.key === 'Backspace' && !text && kept.length > 0) {
              e.preventDefault();
              onBackspaceEmpty();
            }
          }}
          inputProps={{
            'aria-label': 'Search documents',
            'data-testid': 'omnibox-input',
            autoComplete: 'off',
            spellCheck: false,
          }}
          sx={{ fontSize: { xs: '1rem', sm: '1.125rem' }, '& input::placeholder': { color: 'text.disabled', opacity: 1 } }}
        />
        <ButtonBase
          onClick={onAskAi}
          disabled={aiBusy}
          data-testid="ask-ai"
          title="Read this as a question with AI"
          sx={{
            flexShrink: 0,
            gap: 0.75,
            px: 1.5,
            py: 0.75,
            borderRadius: 999,
            border: '1px solid',
            borderColor: alpha(AI_VIOLET, 0.35),
            color: AI_VIOLET,
            bgcolor: alpha(AI_VIOLET, 0.05),
            fontWeight: 600,
            fontSize: '0.85rem',
            whiteSpace: 'nowrap',
            transition: 'background-color .15s, border-color .15s',
            '&:hover': { bgcolor: alpha(AI_VIOLET, 0.1), borderColor: AI_VIOLET },
          }}
        >
          {aiBusy ? <CircularProgress size={14} sx={{ color: AI_VIOLET }} /> : <span aria-hidden>✦</span>}
          {aiBusy ? 'Reading…' : 'Ask AI'}
          {!aiBusy && (
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
              <Kbd>{modKey}↵</Kbd>
            </Box>
          )}
        </ButtonBase>
      </Stack>
      {hasChips && (
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          alignItems="center"
          sx={{ flexWrap: 'wrap', px: { xs: 1.5, sm: 2 }, pb: 1.25, pt: 0.25 }}
          aria-live="polite"
          data-testid="omnibox-chips"
        >
          {kept.map((c) => (
            <ClauseChip
              key={`k-${c.id}`}
              ref={(el) => registerChip?.(c.id, el)}
              clause={c}
              labels={labels}
              constraint={constraintFor?.(c.id)}
              selected={selectedChipId === c.id}
              onOpen={(el) => onOpenChip(c.id, false, el)}
              onRemove={() => onRemoveChip(c.id, false)}
            />
          ))}
          {live.map((c) => (
            <ClauseChip
              key={`l-${c.id}-${c.field}-${c.values.join(',')}`}
              clause={c}
              labels={labels}
              constraint={constraintFor?.(c.id)}
              live
              pending={livePending}
              onOpen={(el) => onOpenChip(c.id, true, el)}
              onRemove={() => onRemoveChip(c.id, true)}
            />
          ))}
          {live.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5, display: { xs: 'none', md: 'inline' } }}>
              <Kbd>↵</Kbd> to keep · click a chip to change how it was read
            </Typography>
          )}
        </Stack>
      )}
      {(busy || aiBusy) && (
        <LinearProgress
          sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, bgcolor: 'transparent', ...(aiBusy ? { '& .MuiLinearProgress-bar': { bgcolor: AI_VIOLET } } : {}) }}
          data-testid="omnibox-busy"
        />
      )}
    </Box>
  );
});
