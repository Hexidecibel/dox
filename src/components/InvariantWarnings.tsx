import { useMemo } from 'react';
import { Alert, Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import { WarningAmberOutlined as WarnIcon } from '@mui/icons-material';
import type { InvariantFailure } from '../lib/types';

/**
 * Review-time extraction warnings, rendered where the reviewer is already
 * looking: under the specific field the warning is about.
 *
 * WHY THIS EXISTS: the 2026-08-01 corpus study found more extraction error
 * inside APPROVED documents (37% of all corpus error) than inside rejected ones
 * (24%) — 5 of 12 hand-checked approvals carried a material defect, including
 * two COAs approved with 3M lab reagent lot numbers in `plant_number`. The
 * server already knows how to spot a machine-detectable slice of that from the
 * document's own text; it just never told anyone until after the fact.
 *
 * DESIGN RULES, in priority order:
 *  1. WARN, NEVER BLOCK. Nothing here disables Approve. The checks have real
 *     false positives (`net_weight` = "300 Gallon Tote" reads oddly and
 *     reviewers correctly accept it), and a reviewer who cannot overrule the
 *     tool learns to fight it instead of reading it.
 *  2. THE REASON IS THE UI. We render the full sentence inline — never a check
 *     id, never a code, never a tooltip the reviewer has to hunt for. If it
 *     can't be said in one line, the check shouldn't ship.
 *  3. DISMISSIBLE. Disagreeing is a first-class action, so a wrong warning
 *     costs one click instead of eroding trust in all of them.
 */

/** Stable identity for a warning, so a dismissal survives re-render/refetch. */
export function warningKey(w: InvariantFailure): string {
  return `${w.scope}::${w.field}::${w.check}`;
}

/** Warnings for one scope ('ai_fields', 'page_metadata', 'record[0]'), by field. */
export function warningsByField(
  warnings: InvariantFailure[] | undefined,
  scope: string
): Record<string, InvariantFailure[]> {
  const out: Record<string, InvariantFailure[]> = {};
  for (const w of warnings || []) {
    if (w.scope !== scope) continue;
    (out[w.field] ||= []).push(w);
  }
  return out;
}

/**
 * The warnings attached to one field, minus the ones this reviewer dismissed.
 * Renders nothing when there is nothing to say.
 */
export function FieldWarnings({
  warnings,
  dismissed,
  onDismiss,
}: {
  warnings: InvariantFailure[] | undefined;
  dismissed?: Set<string>;
  onDismiss?: (key: string) => void;
}) {
  const live = useMemo(
    () => (warnings || []).filter((w) => !dismissed?.has(warningKey(w))),
    [warnings, dismissed]
  );
  if (live.length === 0) return null;

  return (
    <Box sx={{ mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {live.map((w) => (
        <Box
          key={warningKey(w)}
          sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, color: 'warning.dark' }}
        >
          <WarnIcon sx={{ fontSize: 14, mt: '2px', flexShrink: 0 }} />
          <Typography variant="caption" sx={{ lineHeight: 1.35, flex: 1 }}>
            {w.message}
          </Typography>
          {onDismiss && (
            <Button
              size="small"
              onClick={() => onDismiss(warningKey(w))}
              sx={{
                textTransform: 'none',
                minWidth: 0,
                p: 0,
                fontSize: '0.7rem',
                lineHeight: 1.35,
                color: 'text.secondary',
              }}
            >
              Dismiss
            </Button>
          )}
        </Box>
      ))}
    </Box>
  );
}

/**
 * MUI `sx` that tints a field's outline when it carries a live warning. Warning
 * colour, never error colour — this is advice, not a validation failure.
 */
export const warnedFieldSx = {
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'warning.main' },
} as const;

/**
 * Document-level banner shown at the top of an expanded review item, so a
 * reviewer knows something wants their eyes BEFORE they scroll (or before they
 * one-click approve). Deliberately states that these are hints, so nobody reads
 * it as "the system blocked this".
 */
export function InvariantWarningBanner({
  warnings,
  dismissed,
}: {
  warnings: InvariantFailure[] | undefined;
  dismissed?: Set<string>;
}) {
  const live = (warnings || []).filter((w) => !dismissed?.has(warningKey(w)));
  if (live.length === 0) return null;
  const fields = [...new Set(live.map((w) => w.field))];
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {live.length === 1
          ? '1 field looks wrong against the document itself'
          : `${live.length} fields look wrong against the document itself`}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Checked against this document&apos;s own text — no AI, no guessing. These
        are hints, not blockers: read them, fix or dismiss, then approve as
        normal. Affected: {fields.map((f) => f.replace(/_/g, ' ')).join(', ')}.
      </Typography>
    </Alert>
  );
}

/**
 * One-glance chip for the COLLAPSED queue row, so a reviewer working a long
 * list can see which items deserve a careful look before opening any of them.
 */
export function InvariantWarningChip({ warnings }: { warnings: InvariantFailure[] | undefined }) {
  const n = warnings?.length || 0;
  if (n === 0) return null;
  return (
    <Tooltip
      arrow
      title={(warnings || [])
        .slice(0, 4)
        .map((w) => w.message)
        .join('\n')}
    >
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        icon={<WarnIcon sx={{ fontSize: 14 }} />}
        label={n === 1 ? '1 check flagged' : `${n} checks flagged`}
        sx={{ whiteSpace: 'pre-line' }}
      />
    </Tooltip>
  );
}
