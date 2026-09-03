import { Alert, Box, Chip, Tooltip, Typography } from '@mui/material';
import {
  ErrorOutline as OutOfSpecIcon,
  HelpOutline as NotCheckedIcon,
} from '@mui/icons-material';
import type { SpecVerdict } from '../lib/types';
import {
  SPEC_CRITICALITY_COLOR,
  SPEC_CRITICALITY_LABELS,
  compareSpecCriticality,
  parseSpecCriticality,
} from '../../shared/specCriticality';
import type { SpecCriticality } from '../../shared/specCriticality';

/**
 * Conformance warnings on a COA's TEST RESULTS, rendered where the reviewer is
 * already looking.
 *
 * WHY THIS IS NOT `InvariantWarnings.tsx`: those say "the extraction looks
 * wrong" — a data-quality chore, warning-coloured, dismissible in one click.
 * These say "the RESULT looks wrong", which is a food-safety event. An
 * out-of-spec coliform count is the single most consequential thing the portal
 * can tell a QA reviewer, and burying it in the same yellow stack as a
 * mis-parsed date would be a design failure. So:
 *
 *  1. ERROR COLOUR, not warning colour. Distinct from every extraction hint.
 *  2. NOT DISMISSIBLE. An extraction hint can be wrong about the document; a
 *     spec verdict is arithmetic against a stated limit. The reviewer's escape
 *     hatch is to approve anyway — which is recorded — not to hide the finding.
 *  3. STILL NEVER BLOCKS. Nothing here disables Approve. Same house rule.
 *
 * THREE-STATE. `not_checked` is rendered, quietly but visibly, and it is the
 * point of the whole design: it means we HAD a limit and could not honestly
 * apply it (a censored "<50" against a ≤10 limit, a CFU/mL result against a
 * CFU/g limit). Hiding those would manufacture exactly the false negative this
 * feature exists to prevent — a reviewer concluding "no flag, so it passed".
 *
 * NOT EVERY FAILURE IS THE SAME SIZE (migration 0095). Food companies write
 * specs tighter than they can consistently hit, to support a nutrition-panel
 * claim, so most parameters are TRACKED rather than acted on and only a few
 * would stop a load. Rendering all of them in the same red is how a reviewer
 * learns to ignore the red. So a failure on a CRITICAL limit keeps the full
 * error treatment and sorts first, and a tracked one is rendered as the
 * deviation it is.
 *
 * WHAT CRITICALITY MUST NOT DO, and this is the line: it never hides a result,
 * never changes a verdict, and never makes a finding dismissible. Everything
 * judged is still listed, in full, on the same screen — the rank decides ORDER
 * and COLOUR, nothing else. A tier that could suppress a check would be the
 * same false negative in a costume.
 */

export type { SpecVerdict };

/**
 * The tier behind a verdict. A `printed` verdict carries none — it was judged
 * against the COA's own text, and we hold no configured limit to rank it by —
 * so it lands on the default tier rather than being invented into or out of
 * importance.
 */
export function specCriticalityOf(v: SpecVerdict): SpecCriticality {
  return parseSpecCriticality(v.criticality);
}

/**
 * Only the verdicts worth a reviewer's attention (`in_spec` is silence),
 * ordered so the ones that would stop a load are read first.
 *
 * Failures outrank unjudgeable results, and within each the critical tier
 * outranks the tracked one. NOTHING IS FILTERED OUT here — the sort is the only
 * thing criticality does to this list.
 */
export function liveSpecVerdicts(verdicts: SpecVerdict[] | undefined): SpecVerdict[] {
  return (verdicts || [])
    .filter((v) => v.verdict !== 'in_spec')
    .sort((a, b) => {
      const weight = (v: SpecVerdict) => (v.verdict === 'out_of_spec' ? 0 : 1);
      return (
        weight(a) - weight(b) || compareSpecCriticality(specCriticalityOf(a), specCriticalityOf(b))
      );
    });
}

export function countSpecVerdicts(verdicts: SpecVerdict[] | undefined) {
  const live = liveSpecVerdicts(verdicts);
  const failures = live.filter((v) => v.verdict === 'out_of_spec');
  return {
    outOfSpec: failures.length,
    /** Failures on a limit the tenant marked as load-stopping. */
    criticalOutOfSpec: failures.filter((v) => specCriticalityOf(v) === 'high').length,
    notChecked: live.filter((v) => v.verdict === 'not_checked').length,
    total: live.length,
  };
}

/**
 * MUI palette path for a verdict's text/icon. A critical failure stays the
 * error red it has always been; a tracked deviation is amber — visible,
 * unmissable, and distinguishable at a glance from the one that holds a load.
 */
function verdictColor(v: SpecVerdict): string {
  if (v.verdict !== 'out_of_spec') return 'text.secondary';
  const color = SPEC_CRITICALITY_COLOR[specCriticalityOf(v)];
  return color === 'error' ? 'error.main' : 'warning.main';
}

/**
 * Verdicts for one scope, indexed so a table row or a group cell can find its
 * own. Mirrors `warningsByField` in InvariantWarnings.tsx.
 */
export function specVerdictsForTableRow(
  verdicts: SpecVerdict[] | undefined,
  scope: string,
  tableIndex: number
): Record<number, SpecVerdict[]> {
  const out: Record<number, SpecVerdict[]> = {};
  for (const v of verdicts || []) {
    if (v.scope !== scope || v.target.kind !== 'table') continue;
    if (v.target.table_index !== tableIndex) continue;
    (out[v.target.row_index] ||= []).push(v);
  }
  return out;
}

/** Verdicts for one structured group, keyed by cell name. */
export function specVerdictsForGroup(
  verdicts: SpecVerdict[] | undefined,
  scope: string,
  group: string
): Record<string, SpecVerdict[]> {
  const out: Record<string, SpecVerdict[]> = {};
  for (const v of verdicts || []) {
    if (v.scope !== scope || v.target.kind !== 'group') continue;
    if (v.target.group !== group) continue;
    (out[v.target.cell] ||= []).push(v);
  }
  return out;
}

/** Row/cell-level marker: a small icon plus the sentence, in error colour. */
export function SpecRowMarker({ verdicts }: { verdicts: SpecVerdict[] | undefined }) {
  const live = liveSpecVerdicts(verdicts);
  if (live.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {live.map((v, i) => {
        const bad = v.verdict === 'out_of_spec';
        const Icon = bad ? OutOfSpecIcon : NotCheckedIcon;
        const critical = bad && specCriticalityOf(v) === 'high';
        return (
          <Box
            key={i}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.5,
              color: verdictColor(v),
            }}
          >
            <Icon sx={{ fontSize: 14, mt: '2px', flexShrink: 0 }} />
            <Typography variant="caption" sx={{ lineHeight: 1.35, fontWeight: bad ? 600 : 400 }}>
              {/* The tier is named on the failing line itself, not only in the
                  banner — this marker is often the only thing a reviewer reads
                  while scanning a results table. */}
              {critical && <strong>{SPEC_CRITICALITY_LABELS.high}: </strong>}
              {v.message}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** MUI `sx` tinting a table row that carries a CRITICAL out-of-spec result. */
export const outOfSpecRowSx = {
  backgroundColor: 'error.light',
  opacity: 0.95,
} as const;

/** The same idea, one notch down, for a deviation on a tracked parameter. */
export const trackedDeviationRowSx = {
  backgroundColor: 'warning.light',
  opacity: 0.9,
} as const;

/**
 * Row tint for whatever verdicts a table row carries: red for a critical
 * failure, amber for a tracked one, nothing otherwise. Both remain unmissable —
 * the distinction is what stops fourteen amber rows from making the one red row
 * invisible.
 */
export function specRowSx(
  verdicts: SpecVerdict[] | undefined
): typeof outOfSpecRowSx | typeof trackedDeviationRowSx | undefined {
  const failures = (verdicts || []).filter((v) => v.verdict === 'out_of_spec');
  if (failures.length === 0) return undefined;
  return failures.some((v) => specCriticalityOf(v) === 'high')
    ? outOfSpecRowSx
    : trackedDeviationRowSx;
}

/**
 * Document-level banner, shown above everything else in an expanded item — a
 * reviewer must not have to scroll to a table to learn a result failed.
 */
export function SpecWarningBanner({
  verdicts,
  summary,
}: {
  verdicts: SpecVerdict[] | undefined;
  /** Server-side counts, including the `unmatched` total the array cannot carry. */
  summary?: { out_of_spec: number; not_checked: number; unmatched: number };
}) {
  const { outOfSpec, criticalOutOfSpec, notChecked } = countSpecVerdicts(verdicts);
  const unmatched = summary?.unmatched ?? 0;
  // `unmatched` alone never opens the banner. A tenant with three limits sees
  // eleven unmatched tests on every fourteen-row COA, and an info bar on every
  // single document is how a reviewer learns to skip past this component. It is
  // reported only alongside a finding the reviewer is already reading.
  if (outOfSpec === 0 && notChecked === 0) return null;
  const live = liveSpecVerdicts(verdicts);
  const failures = live.filter((v) => v.verdict === 'out_of_spec');
  const unchecked = live.filter((v) => v.verdict === 'not_checked');

  // Red is reserved for a failure on a limit somebody marked as load-stopping.
  // A batch of tracked deviations is amber: still unmissable, still listed in
  // full, but it does not spend the reviewer's alarm on parameters the plant
  // knowingly writes tighter than it can hit.
  const tone = criticalOutOfSpec > 0 ? 'error' : outOfSpec > 0 ? 'warning' : 'info';
  const trackedFailures = outOfSpec - criticalOutOfSpec;

  return (
    <Alert severity={tone} sx={{ mb: 2 }} variant={tone === 'info' ? 'outlined' : 'standard'}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {criticalOutOfSpec > 0
          ? criticalOutOfSpec === 1
            ? 'This COA fails a critical limit'
            : `This COA fails ${criticalOutOfSpec} critical limits`
          : outOfSpec > 0
            ? outOfSpec === 1
              ? 'This COA has an out-of-spec result on a tracked parameter'
              : `This COA has ${outOfSpec} out-of-spec results on tracked parameters`
            : `${notChecked} ${notChecked === 1 ? 'result' : 'results'} could not be checked`}
      </Typography>
      {criticalOutOfSpec > 0 && trackedFailures > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {trackedFailures} further {trackedFailures === 1 ? 'result is' : 'results are'} outside a
          tracked limit — listed below, under the critical ones.
        </Typography>
      )}
      {failures.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {/* Already ordered critical-first by `liveSpecVerdicts`; the tier is
              named on each line so the ranking is legible rather than implied
              by position alone. */}
          {failures.map((v, i) => (
            <Typography component="li" variant="caption" key={i} sx={{ display: 'list-item' }}>
              <Box
                component="span"
                sx={{ fontWeight: 700, color: verdictColor(v), mr: 0.5 }}
              >
                {SPEC_CRITICALITY_LABELS[specCriticalityOf(v)]}:
              </Box>
              {v.message}
            </Typography>
          ))}
        </Box>
      )}
      {unchecked.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: failures.length ? 1 : 0.5, pl: 2.5 }}>
          {unchecked.map((v, i) => (
            <Typography
              component="li"
              variant="caption"
              key={i}
              color="text.secondary"
              sx={{ display: 'list-item' }}
            >
              {v.message}
            </Typography>
          ))}
        </Box>
      )}
      {unmatched > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {unmatched} other {unmatched === 1 ? 'test on this COA has' : 'tests on this COA have'} no
          limit configured, so {unmatched === 1 ? 'it was' : 'they were'} not checked.
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Compared against the limits on file and the one printed on this COA — no
        AI, no guessing. This does not block approval; it asks for your eyes. A
        result listed as &quot;could not be judged&quot; was <strong>not</strong>
        checked, and is not a pass. Critical / tracked comes from how each limit
        is ranked in Settings › Spec Limits, and changes nothing about the
        result — every judged result is shown either way.
      </Typography>
    </Alert>
  );
}

/**
 * One-glance chip for the COLLAPSED queue row. A reviewer working a long list
 * must be able to see which COA has a failing result without opening any of them.
 */
export function SpecAlertChip({ verdicts }: { verdicts: SpecVerdict[] | undefined }) {
  const { outOfSpec, criticalOutOfSpec, notChecked } = countSpecVerdicts(verdicts);
  if (outOfSpec === 0 && notChecked === 0) return null;
  const live = liveSpecVerdicts(verdicts);
  // The COUNT stays the honest total of failures; the word "critical" is added
  // only when at least one of them is on a load-stopping limit. A reviewer
  // working a long list is choosing which COA to open first, and that is
  // exactly the choice the rank exists to inform.
  const label =
    outOfSpec > 0
      ? `${outOfSpec} out of spec${criticalOutOfSpec > 0 ? ' (critical)' : ''}`
      : `${notChecked} not checked`;
  return (
    <Tooltip
      arrow
      title={live
        .slice(0, 4)
        .map((v) => v.message)
        .join('\n')}
    >
      <Chip
        size="small"
        color={criticalOutOfSpec > 0 ? 'error' : outOfSpec > 0 ? 'warning' : 'default'}
        variant={outOfSpec > 0 ? 'filled' : 'outlined'}
        icon={
          outOfSpec > 0 ? (
            <OutOfSpecIcon sx={{ fontSize: 14 }} />
          ) : (
            <NotCheckedIcon sx={{ fontSize: 14 }} />
          )
        }
        label={label}
        sx={{ whiteSpace: 'pre-line', ml: 0.5 }}
      />
    </Tooltip>
  );
}
