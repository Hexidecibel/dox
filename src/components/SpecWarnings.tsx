import type { ReactElement } from 'react';
import { Alert, Box, Chip, Tooltip, Typography } from '@mui/material';
import {
  ErrorOutline as OutOfSpecIcon,
  HelpOutline as NotCheckedIcon,
  RemoveCircleOutline as NoLimitIcon,
  PlaylistRemove as MissingIcon,
  Visibility as WatchIcon,
} from '@mui/icons-material';
import type {
  SpecVerdict,
  UnjudgedResult,
  MissingRequiredAnalyte,
  OverdueWatchSummary,
} from '../lib/types';
import {
  SPEC_CRITICALITY_COLOR,
  SPEC_CRITICALITY_LABELS,
  compareSpecCriticality,
  parseSpecCriticality,
} from '../../shared/specCriticality';
import type { SpecCriticality } from '../../shared/specCriticality';
import { formatUnitConversion, NO_LIMIT_CONFIGURED_LABEL, watchEndedLabel } from '../../shared/specCheck';
import type { UnitConversion } from '../../shared/specCheck';

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
  // Could-not-check is blue, not grey: grey is "No limit configured", and the
  // two must never be mistaken for each other — one asks for a person to
  // verify, the other says nothing was judged at all.
  if (v.verdict === 'not_checked') return 'info.main';
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

/**
 * "Converted: cfu/mL → CFU/g (tenant setting)" — the conversion a comparison
 * rested on, as a visible attribute of the value rather than a clause buried in
 * a sentence (SME ruling, 2026-09-14). Rendered wherever a judged value is, so
 * the review queue, the register and the document view all read the same
 * words, which come from `formatUnitConversion`.
 */
export function ConversionChip({ conversion }: { conversion: UnitConversion | null | undefined }) {
  if (!conversion) return null;
  const label = formatUnitConversion(conversion);
  const title =
    conversion.rule === 'tenant_volume_mass'
      ? "Judged across per-volume and per-mass because this tenant's Spec Limits setting says they are the same number for its products."
      : 'The printed sample basis was converted to the basis the limit is written in before comparing.';
  return (
    <Tooltip arrow title={title}>
      <Chip
        size="small"
        variant="outlined"
        color={conversion.rule === 'tenant_volume_mass' ? 'secondary' : 'default'}
        label={label}
        data-testid="spec-conversion-chip"
        sx={{ height: 20, fontSize: 11, ml: 0.5, verticalAlign: 'middle' }}
      />
    </Tooltip>
  );
}

/**
 * The conversion a REGISTER row was judged under, read from its frozen
 * snapshot. A row written before `conversion` was frozen but under the 0093
 * equivalence still says so — its snapshot carries `unit_equivalence` — and is
 * rebuilt from the printed unit and the limit's unit rather than shown bare.
 */
export function conversionFromSnapshot(
  snapshot: string | null | undefined,
  unitRaw: string | null | undefined
): UnitConversion | null {
  if (!snapshot) return null;
  try {
    const s = JSON.parse(snapshot) as {
      conversion?: UnitConversion;
      unit_equivalence?: string;
      unit?: string | null;
    };
    if (s.conversion && typeof s.conversion === 'object' && s.conversion.rule) return s.conversion;
    if (s.unit_equivalence === 'volume_mass') {
      return {
        from: unitRaw || 'the printed unit',
        to: s.unit || 'the limit unit',
        rule: 'tenant_volume_mass',
        factor: 1,
        operation: '1:1',
      };
    }
  } catch {
    // A corrupt snapshot shows no chip; the reason text still carries the note.
  }
  return null;
}

/** Row/cell-level marker: a small icon plus the sentence, in error colour. */
export function SpecRowMarker({
  verdicts,
  unjudged,
}: {
  verdicts: SpecVerdict[] | undefined;
  /** "No limit configured" results on this row (0107 rulings). */
  unjudged?: UnjudgedResult[];
}) {
  const live = liveSpecVerdicts(verdicts);
  const noLimit = unjudged || [];
  if (live.length === 0 && noLimit.length === 0) return null;
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
                  while scanning a results table. A result we could not check
                  says "verify" on the line, so it is never read as a failure
                  (AJ, 2026-09-14). */}
              {critical && <strong>{SPEC_CRITICALITY_LABELS.high}: </strong>}
              {!bad && <strong>{COULD_NOT_CHECK_LABEL}: </strong>}
              {v.message}
              <ConversionChip conversion={v.conversion} />
              {v.watch?.review_overdue && <WatchEndedChip reviewBy={v.watch.review_by} />}
            </Typography>
          </Box>
        );
      })}
      {noLimit.map((u, i) => (
        <Box key={`u${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <NoLimitChip unjudged={u} />
        </Box>
      ))}
    </Box>
  );
}

/** The one label for a result we held a limit for and could not apply. */
export const COULD_NOT_CHECK_LABEL = 'Could not check — verify';

/**
 * "No limit configured" — a printed result nothing judged. Deliberately the
 * quietest thing on the screen and deliberately NOT green: the danger this
 * guards against is a reviewer (or a buyer) reading an unflagged value as a
 * checked one. Grey, dashed, labelled in words, with the rule in the tooltip.
 */
export function NoLimitChip({ unjudged }: { unjudged: UnjudgedResult }) {
  const printed = `${unjudged.value_raw}${unjudged.unit_raw ? ` ${unjudged.unit_raw}` : ''}`;
  return (
    <Tooltip arrow title={`${unjudged.test_name_raw} ${printed}: ${unjudged.reason}. Add a limit in Settings › Spec Limits to judge it.`}>
      <Chip
        size="small"
        variant="outlined"
        icon={<NoLimitIcon sx={{ fontSize: 14 }} />}
        label={`${unjudged.test_name_raw}: ${NO_LIMIT_CONFIGURED_LABEL}`}
        data-testid="spec-no-limit-chip"
        sx={{
          height: 20,
          fontSize: 11,
          borderStyle: 'dashed',
          color: 'text.secondary',
          borderColor: 'grey.400',
          bgcolor: 'grey.50',
        }}
      />
    </Tooltip>
  );
}

/** "Watch period ended 2026-10-01 — review", beside the value a watch judged. */
export function WatchEndedChip({ reviewBy }: { reviewBy: string }) {
  return (
    <Tooltip
      arrow
      title="This supplier-specific limit or requirement is past its review-by date. It still applies — extend it or remove it in Settings › Spec Limits."
    >
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        icon={<WatchIcon sx={{ fontSize: 14 }} />}
        label={watchEndedLabel(reviewBy)}
        data-testid="spec-watch-ended-chip"
        sx={{ height: 20, fontSize: 11, ml: 0.5, verticalAlign: 'middle' }}
      />
    </Tooltip>
  );
}

/** Unjudged results for one table row, keyed by row index. */
export function unjudgedForTableRow(
  unjudged: UnjudgedResult[] | undefined,
  scope: string,
  tableIndex: number
): Record<number, UnjudgedResult[]> {
  const out: Record<number, UnjudgedResult[]> = {};
  for (const u of unjudged || []) {
    if (u.scope !== scope || u.target.kind !== 'table' || u.target.table_index !== tableIndex) continue;
    (out[u.target.row_index] ||= []).push(u);
  }
  return out;
}

/** Unjudged results for one structured group, keyed by cell name. */
export function unjudgedForGroup(
  unjudged: UnjudgedResult[] | undefined,
  scope: string,
  group: string
): Record<string, UnjudgedResult[]> {
  const out: Record<string, UnjudgedResult[]> = {};
  for (const u of unjudged || []) {
    if (u.scope !== scope || u.target.kind !== 'group' || u.target.group !== group) continue;
    (out[u.target.cell] ||= []).push(u);
  }
  return out;
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
  unjudged,
  missingRequired,
  watchOverdue,
}: {
  verdicts: SpecVerdict[] | undefined;
  /** Server-side counts, including the `unmatched` total the array cannot carry. */
  summary?: { out_of_spec: number; not_checked: number; unmatched: number };
  /** "No limit configured" results (0107 rulings). */
  unjudged?: UnjudgedResult[];
  /** Required analytes for this supplier the certificate did not report. */
  missingRequired?: MissingRequiredAnalyte[];
  /** Watches in force for this document past their review-by date. */
  watchOverdue?: OverdueWatchSummary[];
}) {
  const { outOfSpec, criticalOutOfSpec, notChecked } = countSpecVerdicts(verdicts);
  const noLimit = unjudged || [];
  const missing = missingRequired || [];
  const watches = watchOverdue || [];
  // Unjudged results alone do NOT open the alert: a tenant with three limits
  // sees eleven of them on every fourteen-row COA, and an alert on every single
  // document is how a reviewer learns to skip this component. They still get a
  // quiet, always-visible line of their own (below) — the SME's ruling is that
  // the portal must never imply it judged a value it did not.
  if (outOfSpec === 0 && notChecked === 0 && missing.length === 0 && watches.length === 0) {
    return noLimit.length > 0 ? <NoLimitPanel unjudged={noLimit} /> : null;
  }
  const unmatched = noLimit.length > 0 ? 0 : (summary?.unmatched ?? 0);
  const live = liveSpecVerdicts(verdicts);
  const failures = live.filter((v) => v.verdict === 'out_of_spec');
  const unchecked = live.filter((v) => v.verdict === 'not_checked');
  const missingByAnalyte = groupMissing(missing);

  // Red is reserved for a failure on a limit somebody marked as load-stopping.
  // A batch of tracked deviations is amber: still unmissable, still listed in
  // full, but it does not spend the reviewer's alarm on parameters the plant
  // knowingly writes tighter than it can hit.
  const tone = criticalOutOfSpec > 0 ? 'error' : outOfSpec > 0 || missing.length > 0 ? 'warning' : 'info';
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
            : missingByAnalyte.length > 0
              ? `This COA is incomplete — ${missingByAnalyte.length} required ${missingByAnalyte.length === 1 ? 'analyte is' : 'analytes are'} not reported`
              : notChecked > 0
                ? `${notChecked} ${notChecked === 1 ? 'result' : 'results'} could not be checked — verify by hand`
                : 'A supplier watch on this COA is past its review-by date'}
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
              <ConversionChip conversion={v.conversion} />
            </Typography>
          ))}
        </Box>
      )}
      {missingByAnalyte.length > 0 && (
        <Box sx={{ mt: failures.length ? 1 : 0.5 }} data-testid="spec-missing-required">
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'secondary.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <MissingIcon sx={{ fontSize: 14 }} />
            Incomplete — required for this supplier, not reported
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {missingByAnalyte.map((m) => (
              <Typography component="li" variant="caption" key={m.spec_test_id} sx={{ display: 'list-item' }}>
                {m.message}
                {m.records > 1 && ` (${m.records} records)`}
                {m.watch?.review_overdue && <WatchEndedChip reviewBy={m.watch.review_by} />}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      {unchecked.length > 0 && (
        <Box sx={{ mt: failures.length || missingByAnalyte.length ? 1 : 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'info.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <NotCheckedIcon sx={{ fontSize: 14 }} />
            {COULD_NOT_CHECK_LABEL} — a limit applies but could not be compared; this is not a failure and not a pass
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {unchecked.map((v, i) => (
              <Typography
                component="li"
                variant="caption"
                key={i}
                color="text.secondary"
                sx={{ display: 'list-item' }}
              >
                {v.message}
                <ConversionChip conversion={v.conversion} />
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      {watches.length > 0 && (
        <Box sx={{ mt: 1 }} data-testid="spec-watch-overdue">
          {watches.map((w) => (
            <Typography key={`${w.kind}:${w.id}`} variant="caption" sx={{ display: 'block' }}>
              <WatchEndedChip reviewBy={w.review_by} />{' '}
              {w.kind === 'limit'
                ? `The supplier-specific ${w.analyte_name} limit still applies.`
                : `${w.analyte_name} is still required from this supplier.`}{' '}
              Extend or remove it in Settings › Spec Limits.
            </Typography>
          ))}
        </Box>
      )}
      {noLimit.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <NoLimitPanel unjudged={noLimit} inline />
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

/** One line per missing analyte, however many records of the COA miss it. */
function groupMissing(
  missing: MissingRequiredAnalyte[]
): Array<MissingRequiredAnalyte & { records: number }> {
  const by = new Map<string, MissingRequiredAnalyte & { records: number }>();
  for (const m of missing) {
    const prev = by.get(m.spec_test_id);
    if (prev) prev.records += 1;
    else by.set(m.spec_test_id, { ...m, records: 1 });
  }
  return [...by.values()];
}

/**
 * The printed results nothing judged, as grey "No limit configured" chips — on
 * its own when there is nothing else to say, or inline at the foot of the
 * alert. Never coloured like a pass.
 */
export function NoLimitPanel({ unjudged, inline = false }: { unjudged: UnjudgedResult[]; inline?: boolean }) {
  if (unjudged.length === 0) return null;
  const unique = [...new Map(unjudged.map((u) => [u.test_name_raw.toLowerCase(), u])).values()];
  return (
    <Box
      data-testid="spec-no-limit-panel"
      sx={
        inline
          ? undefined
          : { mb: 2, p: 1, border: '1px dashed', borderColor: 'grey.400', borderRadius: 1, bgcolor: 'grey.50' }
      }
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        <strong>Not judged:</strong> {unique.length} {unique.length === 1 ? 'result on this COA has' : 'results on this COA have'} no
        limit configured and no printed specification. {unique.length === 1 ? 'It is' : 'They are'} shown, not checked.
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {unique.map((u, i) => (
          <NoLimitChip key={i} unjudged={u} />
        ))}
      </Box>
    </Box>
  );
}

/**
 * One-glance chip for the COLLAPSED queue row. A reviewer working a long list
 * must be able to see which COA has a failing result without opening any of them.
 */
export function SpecAlertChip({
  verdicts,
  missingRequired,
}: {
  verdicts: SpecVerdict[] | undefined;
  missingRequired?: MissingRequiredAnalyte[];
}) {
  const { outOfSpec, criticalOutOfSpec, notChecked } = countSpecVerdicts(verdicts);
  const missing = groupMissing(missingRequired || []);
  const chips: ReactElement[] = [];
  if (outOfSpec > 0 || notChecked > 0) {
    const live = liveSpecVerdicts(verdicts);
    // The COUNT stays the honest total of failures; the word "critical" is
    // added only when at least one of them is on a load-stopping limit. A
    // reviewer working a long list is choosing which COA to open first, and
    // that is exactly the choice the rank exists to inform.
    const label =
      outOfSpec > 0
        ? `${outOfSpec} out of spec${criticalOutOfSpec > 0 ? ' (critical)' : ''}`
        : `${notChecked} could not check`;
    chips.push(
      <Tooltip
        key="verdicts"
        arrow
        title={live
          .slice(0, 4)
          .map((v) => v.message)
          .join('\n')}
      >
        <Chip
          size="small"
          color={criticalOutOfSpec > 0 ? 'error' : outOfSpec > 0 ? 'warning' : 'info'}
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
  if (missing.length > 0) {
    chips.push(
      <Tooltip key="missing" arrow title={missing.map((m) => m.message).join('\n')}>
        <Chip
          size="small"
          color="secondary"
          variant="outlined"
          icon={<MissingIcon sx={{ fontSize: 14 }} />}
          label={`incomplete: ${missing.length} required`}
          sx={{ whiteSpace: 'pre-line', ml: 0.5 }}
        />
      </Tooltip>
    );
  }
  return chips.length ? <>{chips}</> : null;
}
