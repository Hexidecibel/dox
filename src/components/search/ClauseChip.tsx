import { forwardRef } from 'react';
import { Box, ButtonBase, Tooltip } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import type { Clause } from '../../../shared/searchQuery';
import type { SearchConstraint } from '../../../shared/types';
import { chipParts, chipSentence } from '../../lib/searchChips';

/**
 * One clause of the query, as a chip that says how it was read (search
 * redesign Phase 2). Clicking it opens the clause editor; its × removes it.
 *
 *   live       read from what is still in the box — dashed, not yet kept
 *   pending    the browser's own reading while the server is still asked
 *   ai         the AI's reading — violet, marked ✦, never mistaken for the
 *              person's own words
 *   ambiguous  a phrase that fits several products — nothing was picked
 *   exclude    a scope filter turned inside out ("not supplier")
 */
export interface ClauseChipProps {
  clause: Clause;
  labels?: Record<string, string>;
  constraint?: SearchConstraint | null;
  live?: boolean;
  pending?: boolean;
  selected?: boolean;
  onOpen?: (anchor: HTMLElement) => void;
  onRemove?: () => void;
}

type Tone = 'scope' | 'identifying' | 'text' | 'ai' | 'ambiguous';

function toneOf(c: Clause): Tone {
  if (c.ambiguous) return 'ambiguous';
  if (c.source === 'ai') return 'ai';
  if (c.field === 'text') return 'text';
  if (['supplier', 'document_type', 'product', 'status', 'uploaded'].includes(c.field)) return 'scope';
  return 'identifying';
}

export const AI_VIOLET = '#6c45d4';

function toneColors(t: Theme, tone: Tone): { fg: string; bg: string; line: string } {
  switch (tone) {
    case 'ai':
      return { fg: AI_VIOLET, bg: alpha(AI_VIOLET, 0.08), line: alpha(AI_VIOLET, 0.35) };
    case 'ambiguous':
      return { fg: t.palette.info.main, bg: alpha(t.palette.info.main, 0.08), line: alpha(t.palette.info.main, 0.35) };
    case 'text':
      return { fg: t.palette.text.secondary, bg: t.palette.background.paper, line: t.palette.divider };
    case 'scope':
      return { fg: t.palette.secondary.dark, bg: alpha(t.palette.secondary.main, 0.07), line: alpha(t.palette.secondary.main, 0.3) };
    default:
      return { fg: t.palette.primary.main, bg: alpha(t.palette.primary.main, 0.06), line: alpha(t.palette.primary.main, 0.28) };
  }
}

export const ClauseChip = forwardRef<HTMLButtonElement, ClauseChipProps>(function ClauseChip(
  { clause, labels = {}, constraint, live = false, pending = false, selected = false, onOpen, onRemove },
  ref,
) {
  const parts = chipParts(clause, labels, constraint);
  const tone = toneOf(clause);
  const sentence = chipSentence(parts);
  return (
    <Tooltip title={clause.note ?? ''} disableHoverListener={!clause.note} enterDelay={500}>
      <ButtonBase
        ref={ref}
        component="span"
        role="button"
        tabIndex={0}
        data-testid={`clause-chip-${clause.id}`}
        data-source={clause.source}
        data-field={clause.field}
        data-live={live ? '1' : undefined}
        data-pending={pending ? '1' : undefined}
        aria-label={`${sentence}${clause.source === 'ai' ? ' (AI reading)' : ''}. Edit how this was read.`}
        onClick={(e) => onOpen?.(e.currentTarget as HTMLElement)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.(e.currentTarget as HTMLElement);
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && onRemove) {
            e.preventDefault();
            onRemove();
          }
        }}
        sx={(t) => {
          const c = toneColors(t, tone);
          return {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            maxWidth: '100%',
            minHeight: 30,
            pl: 1.25,
            pr: onRemove ? 0.5 : 1.25,
            py: 0.25,
            borderRadius: 999,
            border: '1px solid',
            borderStyle: live ? 'dashed' : 'solid',
            borderColor: selected ? c.fg : c.line,
            bgcolor: live ? 'transparent' : c.bg,
            color: 'text.primary',
            fontSize: '0.8125rem',
            lineHeight: 1.25,
            cursor: 'pointer',
            opacity: pending ? 0.7 : 1,
            boxShadow: selected ? `0 0 0 3px ${alpha(c.fg, 0.18)}` : 'none',
            transition: 'box-shadow .15s, border-color .15s, background-color .15s, transform .12s',
            animation: 'doxChipIn .22s ease-out',
            '@keyframes doxChipIn': { from: { opacity: 0, transform: 'translateY(3px) scale(.97)' }, to: { opacity: pending ? 0.7 : 1, transform: 'none' } },
            '&:hover': { borderColor: c.fg, bgcolor: c.bg },
            '&:focus-visible': { outline: 'none', boxShadow: `0 0 0 3px ${alpha(c.fg, 0.28)}` },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', transition: 'none' },
          };
        }}
      >
        {tone === 'ai' && (
          <Box component="span" aria-hidden sx={{ color: AI_VIOLET, fontSize: '0.75rem', mr: -0.25 }}>✦</Box>
        )}
        <Box
          component="span"
          sx={(t) => ({
            fontSize: '0.6875rem',
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: toneColors(t, tone).fg,
            whiteSpace: 'nowrap',
            textDecoration: clause.exclude ? 'line-through' : 'none',
            textDecorationThickness: '1px',
          })}
        >
          {parts.key}
        </Box>
        <Box
          component="span"
          sx={{
            fontWeight: 600,
            fontFamily: parts.mono ? '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
            fontSize: parts.mono ? '0.78rem' : 'inherit',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {parts.value}
        </Box>
        {parts.note && (
          <Box
            component="span"
            sx={{ color: 'text.secondary', fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, display: { xs: 'none', sm: 'inline' } }}
          >
            {parts.note}
          </Box>
        )}
        {pending && (
          <Box component="span" aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.disabled', animation: 'doxPulse 1s ease-in-out infinite', '@keyframes doxPulse': { '50%': { opacity: 0.2 } } }} />
        )}
        {onRemove && (
          <Box
            component="span"
            role="button"
            aria-label={`Remove ${sentence}`}
            data-testid={`clause-chip-remove-${clause.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: '50%',
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
            }}
          >
            <CloseRoundedIcon sx={{ fontSize: 15 }} />
          </Box>
        )}
      </ButtonBase>
    </Tooltip>
  );
});
