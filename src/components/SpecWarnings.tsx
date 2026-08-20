import { Alert, Box, Chip, Tooltip, Typography } from '@mui/material';
import {
  ErrorOutline as OutOfSpecIcon,
  HelpOutline as NotCheckedIcon,
} from '@mui/icons-material';
import type { SpecVerdict } from '../lib/types';

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
 */

export type { SpecVerdict };

/** Only the verdicts worth a reviewer's attention. `in_spec` is silence. */
export function liveSpecVerdicts(verdicts: SpecVerdict[] | undefined): SpecVerdict[] {
  return (verdicts || []).filter((v) => v.verdict !== 'in_spec');
}

export function countSpecVerdicts(verdicts: SpecVerdict[] | undefined) {
  const live = liveSpecVerdicts(verdicts);
  return {
    outOfSpec: live.filter((v) => v.verdict === 'out_of_spec').length,
    notChecked: live.filter((v) => v.verdict === 'not_checked').length,
    total: live.length,
  };
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
        return (
          <Box
            key={i}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.5,
              color: bad ? 'error.main' : 'text.secondary',
            }}
          >
            <Icon sx={{ fontSize: 14, mt: '2px', flexShrink: 0 }} />
            <Typography variant="caption" sx={{ lineHeight: 1.35, fontWeight: bad ? 600 : 400 }}>
              {v.message}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** MUI `sx` tinting a table row that carries an out-of-spec result. */
export const outOfSpecRowSx = {
  backgroundColor: 'error.light',
  opacity: 0.95,
} as const;

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
  const { outOfSpec, notChecked } = countSpecVerdicts(verdicts);
  const unmatched = summary?.unmatched ?? 0;
  // `unmatched` alone never opens the banner. A tenant with three limits sees
  // eleven unmatched tests on every fourteen-row COA, and an info bar on every
  // single document is how a reviewer learns to skip past this component. It is
  // reported only alongside a finding the reviewer is already reading.
  if (outOfSpec === 0 && notChecked === 0) return null;
  const live = liveSpecVerdicts(verdicts);
  const failures = live.filter((v) => v.verdict === 'out_of_spec');
  const unchecked = live.filter((v) => v.verdict === 'not_checked');

  return (
    <Alert severity={outOfSpec > 0 ? 'error' : 'info'} sx={{ mb: 2 }} variant={outOfSpec > 0 ? 'standard' : 'outlined'}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {outOfSpec > 0
          ? outOfSpec === 1
            ? 'This COA has an out-of-spec result'
            : `This COA has ${outOfSpec} out-of-spec results`
          : `${notChecked} ${notChecked === 1 ? 'result' : 'results'} could not be checked`}
      </Typography>
      {failures.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {failures.map((v, i) => (
            <Typography component="li" variant="caption" key={i} sx={{ display: 'list-item' }}>
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
        checked, and is not a pass.
      </Typography>
    </Alert>
  );
}

/**
 * One-glance chip for the COLLAPSED queue row. A reviewer working a long list
 * must be able to see which COA has a failing result without opening any of them.
 */
export function SpecAlertChip({ verdicts }: { verdicts: SpecVerdict[] | undefined }) {
  const { outOfSpec, notChecked } = countSpecVerdicts(verdicts);
  if (outOfSpec === 0 && notChecked === 0) return null;
  const live = liveSpecVerdicts(verdicts);
  const label =
    outOfSpec > 0
      ? outOfSpec === 1
        ? '1 out of spec'
        : `${outOfSpec} out of spec`
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
        color={outOfSpec > 0 ? 'error' : 'default'}
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
