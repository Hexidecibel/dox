import { Box, Button, ButtonBase, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import type { SearchCoverage, SearchDroppedConstraint, SearchUnreviewedCandidate, UniversalSearchDocument } from '../../../shared/types';
import { lotRowLine } from './CoverageResults';

/**
 * The answer, first (search redesign Phase 2) — lifted out of
 * `CoverageResults`' banners into one card that leads the page, so a near miss
 * can never be read as the answer:
 *
 *   Covered          N documents cover it — with the matched lot row named.
 *   Likely · confirm would cover it on evidence nobody confirmed; the reason.
 *   Nothing covers   "No COA on file covers production date Sep 2." The nearest
 *                    document is named as nearby and NOT the answer.
 *   Could mean N     a phrase that fits several products: counts per product,
 *                    nothing picked, one click to choose.
 *
 * With nothing identifying asked there is no claim to make: a slim count line.
 * The headline is the server's own `coverage_summary`, so the words match
 * what the judge decided, never a client paraphrase of it.
 */
export type AnswerKind = 'ready' | 'loading' | 'covered' | 'likely' | 'none' | 'ambiguous' | 'browse';

export interface AmbiguousProduct {
  phrase: string;
  candidates: Array<{ id: string; label: string; count: number }>;
  countNoun: string;
  onPick: (productId: string) => void;
}

export interface AnswerCardProps {
  coverage?: SearchCoverage;
  coverage_summary?: string | null;
  documents: UniversalSearchDocument[];
  dropped_constraints?: SearchDroppedConstraint[];
  unreviewed_candidates?: SearchUnreviewedCandidate[];
  coverage_scan_truncated?: boolean;
  total?: number;
  /** Nothing typed and nothing chosen. */
  empty?: boolean;
  loading?: boolean;
  ambiguous?: AmbiguousProduct | null;
  /** Browse line: what the list is ("from Darigold · mentioning butter"). */
  browseWords?: string | null;
  onPreview?: (doc: UniversalSearchDocument) => void;
  /** Present when export is on: selects the covering set. */
  onSelectCovering?: (docs: UniversalSearchDocument[]) => void;
  onAskAi?: () => void;
  /** Keyboard hint for the palette ("⌘K" / "Ctrl K"). */
  paletteKey?: string;
  empties?: React.ReactNode;
}

const INK = {
  covered: (t: Theme) => t.palette.success.main,
  likely: (t: Theme) => t.palette.warning.main,
  none: (t: Theme) => t.palette.text.secondary,
  ambiguous: (t: Theme) => t.palette.info.main,
  ready: (t: Theme) => t.palette.primary.main,
} as const;

const EYEBROW: Record<'covered' | 'likely' | 'none' | 'ambiguous' | 'ready', string> = {
  covered: 'Covered',
  likely: 'Likely · confirm',
  none: 'Nothing covers',
  ambiguous: 'Could mean several products',
  ready: 'Ready',
};

const TESTID: Record<'covered' | 'likely' | 'none' | 'ambiguous' | 'ready', string> = {
  covered: 'covered-banner',
  likely: 'likely-coverage-banner',
  none: 'no-coverage-banner',
  ambiguous: 'ambiguous-coverage-banner',
  ready: 'answer-ready',
};

/** Splits "… Searched within: Supplier: Darigold." off the headline. */
export function splitScope(summary: string | null | undefined): { headline: string; scope: string | null } {
  const s = (summary ?? '').trim();
  const i = s.indexOf(' Searched within: ');
  if (i < 0) return { headline: s, scope: null };
  return { headline: s.slice(0, i), scope: s.slice(i + ' Searched within: '.length).replace(/\.$/, '') };
}

export function answerKind(p: Pick<AnswerCardProps, 'coverage' | 'empty' | 'loading' | 'ambiguous'>): AnswerKind {
  if (p.empty) return 'ready';
  if (p.ambiguous || p.coverage === 'ambiguous') return 'ambiguous';
  if (p.coverage === 'covered') return 'covered';
  if (p.coverage === 'likely') return 'likely';
  if (p.coverage === 'none') return 'none';
  if (p.loading && !p.coverage) return 'loading';
  return 'browse';
}

function Frame({ kind, children }: { kind: 'covered' | 'likely' | 'none' | 'ambiguous' | 'ready'; children: React.ReactNode }) {
  return (
    <Paper
      elevation={0}
      data-testid={TESTID[kind]}
      data-answer={kind}
      sx={(t) => {
        const ink = INK[kind](t);
        return {
          position: 'relative',
          overflow: 'hidden',
          mb: 2,
          p: { xs: 2, sm: 2.5 },
          pl: { xs: 2.5, sm: 3 },
          borderRadius: 3,
          border: '1px solid',
          borderColor: alpha(ink, kind === 'none' ? 0.25 : 0.3),
          bgcolor: alpha(ink, kind === 'none' ? 0.035 : 0.05),
          boxShadow: '0 1px 2px rgba(15,26,46,.04), 0 10px 28px -18px rgba(15,26,46,.25)',
          animation: 'doxAnswerIn .28s ease-out',
          '@keyframes doxAnswerIn': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          '&::before': { content: '""', position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, bgcolor: ink },
        };
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.75 }}>
        <Box sx={(t) => ({ width: 7, height: 7, borderRadius: '50%', bgcolor: INK[kind](t) })} />
        <Typography
          variant="overline"
          sx={(t) => ({ lineHeight: 1.4, fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.1em', color: INK[kind](t) })}
        >
          {EYEBROW[kind]}
        </Typography>
      </Stack>
      {children}
    </Paper>
  );
}

function Headline({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      component="h2"
      sx={{
        fontFamily: "'Newsreader', Georgia, 'Times New Roman', serif",
        fontWeight: 500,
        fontSize: { xs: '1.3rem', sm: '1.55rem' },
        lineHeight: 1.25,
        letterSpacing: '-0.01em',
        color: 'text.primary',
      }}
    >
      {children}
    </Typography>
  );
}

function Sub({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }} data-testid={testId}>
      {children}
    </Typography>
  );
}

function Evidence({ doc }: { doc: UniversalSearchDocument }) {
  const lot = doc.matched_lot;
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ mt: 1.25, flexWrap: 'wrap' }}>
      {doc.supplier_name && <Typography variant="body2" sx={{ fontWeight: 600 }}>{doc.supplier_name}</Typography>}
      {doc.title && <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 360 }}>{doc.title}</Typography>}
      {lot && (
        <Box
          component="span"
          sx={{ fontSize: '0.8rem', px: 1, py: 0.25, borderRadius: 1, bgcolor: '#fff0b0', boxShadow: 'inset 0 0 0 1px #e3bd3c', fontWeight: 600 }}
          data-testid="answer-lot"
        >
          {lotRowLine(lot)}
        </Box>
      )}
    </Stack>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.75, flexWrap: 'wrap' }}>
      {children}
    </Stack>
  );
}

const btn = { textTransform: 'none', borderRadius: 2, fontWeight: 600 } as const;

export function AnswerCard(props: AnswerCardProps) {
  const {
    coverage_summary,
    documents,
    dropped_constraints = [],
    unreviewed_candidates = [],
    coverage_scan_truncated,
    total = 0,
    ambiguous,
    browseWords,
    onPreview,
    onSelectCovering,
    onAskAi,
    paletteKey = 'Ctrl K',
    empties,
  } = props;
  const kind = answerKind(props);
  const covering = documents.filter((d) => d.match_status === 'covering');
  const likely = documents.filter((d) => d.match_status === 'likely_covering');
  const nearby = documents.filter((d) => d.match_status === 'candidate_not_matching');
  const { headline, scope } = splitScope(coverage_summary);

  const footnotes = (
    <>
      {scope && <Sub testId="answer-scope">Searched within: {scope}.</Sub>}
      {dropped_constraints.length > 0 && (
        <Sub testId="answer-dropped">
          Part of your search could not be applied — {dropped_constraints.map((d) => `“${d.label}”: ${d.reason}`).join(' ')} Because of that, nothing below can be confirmed as covering it.
        </Sub>
      )}
      {coverage_scan_truncated && (
        <Sub>This workspace has more documents than one coverage check reads, so the oldest were not checked.</Sub>
      )}
    </>
  );

  switch (kind) {
    case 'ready':
      return (
        <Frame kind="ready">
          <Headline>Ask for a document the way you would say it.</Headline>
          <Sub>
            A lot, a production or best-by date, a PO, an invoice or an order — and it tells you whether a document on file actually covers it.
            Press <Kbd>{paletteKey}</Kbd> from anywhere.
          </Sub>
          {empties}
        </Frame>
      );
    case 'loading':
      return (
        <Box sx={{ mb: 2 }} data-testid="answer-loading">
          <Skeleton variant="rounded" height={112} sx={{ borderRadius: 3 }} />
        </Box>
      );
    case 'covered': {
      const first = covering[0];
      return (
        <Frame kind="covered">
          <Headline>{headline}</Headline>
          {first && <Evidence doc={first} />}
          {covering.length > 1 && <Sub>{covering.length - 1} more covering below.</Sub>}
          {footnotes}
          <Actions>
            {first && onPreview && (
              <Button variant="contained" disableElevation size="small" sx={btn} onClick={() => onPreview(first)} data-testid="answer-preview">
                Preview certificate
              </Button>
            )}
            {onSelectCovering && covering.length > 0 && (
              <Button variant="outlined" size="small" sx={btn} onClick={() => onSelectCovering(covering)} data-testid="answer-select-covering">
                Select {covering.length === 1 ? 'it' : `all ${covering.length}`} for export
              </Button>
            )}
          </Actions>
        </Frame>
      );
    }
    case 'likely': {
      const first = likely[0];
      const reason = first?.match_checks?.find((c) => c.outcome === 'likely')?.message;
      return (
        <Frame kind="likely">
          <Headline>{headline}</Headline>
          {reason && <Sub testId="answer-likely-reason">{reason}</Sub>}
          {first && <Evidence doc={first} />}
          {footnotes}
          {first && onPreview && (
            <Actions>
              <Button variant="contained" color="warning" disableElevation size="small" sx={btn} onClick={() => onPreview(first)}>
                Open to confirm
              </Button>
            </Actions>
          )}
        </Frame>
      );
    }
    case 'none': {
      const near = nearby[0];
      const waiting = unreviewed_candidates.filter((u) => u.matches_all_constraints);
      return (
        <Frame kind="none">
          <Headline>{headline}</Headline>
          {near && (
            <Sub testId="answer-nearest">
              Nearest on file: {near.title ?? 'a document'}
              {near.matched_lot ? ` (${lotRowLine(near.matched_lot)})` : ''}. It is listed below as nearby. It does not answer the question.
            </Sub>
          )}
          {waiting.length > 0 && (
            <Sub testId="answer-waiting">
              {waiting.length} file{waiting.length === 1 ? '' : 's'} in the Review Queue might cover it. {waiting.length === 1 ? 'It is' : 'They are'} not an answer until someone approves {waiting.length === 1 ? 'it' : 'them'}.
            </Sub>
          )}
          {footnotes}
          {onAskAi && (
            <Actions>
              <Button size="small" variant="outlined" onClick={onAskAi} sx={{ ...btn, color: '#6c45d4', borderColor: alpha('#6c45d4', 0.4) }}>
                ✦ Ask AI to read it as a question
              </Button>
            </Actions>
          )}
        </Frame>
      );
    }
    case 'ambiguous': {
      if (!ambiguous) {
        return (
          <Frame kind="ambiguous">
            <Headline>{headline}</Headline>
            {footnotes}
          </Frame>
        );
      }
      return (
        <Frame kind="ambiguous">
          <Headline>“{ambiguous.phrase}” fits {ambiguous.candidates.length} products. Nothing was picked.</Headline>
          <Sub>Counts are per product. Choose one to get a single answer.</Sub>
          <Box sx={{ mt: 1.5, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fill, minmax(220px, 1fr))' } }}>
            {ambiguous.candidates.map((c) => (
              <ButtonBase
                key={c.id}
                onClick={() => ambiguous.onPick(c.id)}
                data-testid={`answer-pick-${c.id}`}
                sx={(t) => ({
                  display: 'block',
                  textAlign: 'left',
                  p: 1.5,
                  borderRadius: 2,
                  border: '1px solid',
                  borderColor: alpha(t.palette.info.main, 0.3),
                  bgcolor: 'background.paper',
                  transition: 'border-color .15s, box-shadow .15s',
                  '&:hover': { borderColor: t.palette.info.main, boxShadow: `0 0 0 3px ${alpha(t.palette.info.main, 0.12)}` },
                })}
              >
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{c.label}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {c.count} {ambiguous.countNoun}
                </Typography>
                <Typography variant="caption" sx={{ color: 'info.main', fontWeight: 600 }}>Use this product →</Typography>
              </ButtonBase>
            ))}
          </Box>
          {footnotes}
        </Frame>
      );
    }
    default:
      return (
        <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1.5, px: 0.5 }} data-testid="answer-browse">
          <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}</Typography>
          <Typography variant="body2" color="text.secondary">
            document{total === 1 ? '' : 's'}{browseWords ? ` · ${browseWords}` : ''}
          </Typography>
        </Stack>
      );
  }
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: 'inline-block',
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.7rem',
        lineHeight: 1.5,
        px: 0.6,
        mx: 0.25,
        borderRadius: 0.75,
        border: '1px solid',
        borderColor: 'divider',
        borderBottomWidth: 2,
        bgcolor: 'background.paper',
        color: 'text.secondary',
        verticalAlign: 'baseline',
      }}
    >
      {children}
    </Box>
  );
}
