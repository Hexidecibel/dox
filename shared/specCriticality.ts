/**
 * Criticality — how much a spec limit MATTERS, as opposed to what it says.
 *
 * WHY THIS EXISTS (AJ Conner, 2026-09-02). Food companies write specs tighter
 * than they can consistently hit batch to batch, because the numbers have to
 * support a nutrition-panel claim. So most parameters on a spec sheet are
 * TRACKED, not ACTED ON — only a few would ever stop a load. A limits screen
 * that renders all of them flat trains the reviewer to skim past every one,
 * which costs us the few that matter. A limit therefore carries its own rank.
 *
 * THIS NEVER CHANGES A VERDICT. `shared/specCheck.ts` decides
 * in_spec / out_of_spec / not_checked from the numbers, and nothing in this
 * file is an input to that. Criticality orders and colours what a human sees
 * afterwards, and travels with a verdict only so the UI does not have to
 * re-resolve a limit it never loaded. Keeping that line sharp is the same
 * argument specCheck's own header makes: a ranking that could suppress a check
 * would be a false negative with a priority badge on it.
 *
 * DISTINCT FROM `spec_limits.severity`, which is already on the row and answers
 * a different question. `severity` routes the notification ('alert' mails the
 * combo owner, 'warn' stays in the queue); criticality ranks the finding for
 * whoever reads it. A tenant can reasonably want a tracked parameter to still
 * email someone while routing is being set up, or a critical one to stay
 * in-app.
 *
 * ── OPEN QUESTION: THE WORDS ARE NOT SETTLED ──────────────────────────────
 * AJ has not chosen between `low`/`medium`/`high` and
 * `essential`/`warn`/`ignore`. low/medium/high is what ships, for one concrete
 * reason beyond taste: `severity` on the same table already stores the literal
 * 'warn', and two columns using one word for two different things is a trap for
 * whoever reads a frozen `limit_snapshot` in a year.
 *
 * RENAMING IS A SINGLE-SITE EDIT — this file (values, default, labels, help,
 * chip colours) plus a NEW migration restating the CHECK constraint from 0095,
 * because SQLite cannot alter a CHECK in place. No literal from this vocabulary
 * may be written anywhere else in the codebase: every other module imports
 * `SpecCriticality`, `DEFAULT_SPEC_CRITICALITY` or the maps below, so a rename
 * fails to compile rather than silently splitting the vocabulary in two.
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * The tiers, MOST CRITICAL FIRST. The order is load-bearing: `specCriticalityRank`
 * is the index into this array, which is what every sort in the UI uses.
 */
export const SPEC_CRITICALITY_VALUES = ['high', 'medium', 'low'] as const;

export type SpecCriticality = (typeof SPEC_CRITICALITY_VALUES)[number];

/**
 * THE MIDDLE TIER, and that is the whole point. Defaulting to the top one
 * recreates the flat screen in a new costume — everything critical carries the
 * same information as nothing critical. Defaulting to the bottom one silently
 * demotes limits a tenant wrote deliberately. The middle says the honest thing:
 * we are watching this, and nobody has told us yet how much it matters.
 *
 * This is also what a client who never touches the control gets, forever, so it
 * has to be the tier that is safe to leave alone.
 */
export const DEFAULT_SPEC_CRITICALITY: SpecCriticality = 'medium';

export function isSpecCriticality(value: unknown): value is SpecCriticality {
  return (
    typeof value === 'string' &&
    (SPEC_CRITICALITY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Coerce a stored / transported value to a tier.
 *
 * Falls back to the default rather than throwing, because the callers are read
 * paths: a row written before migration 0095, or a `limit_snapshot` frozen
 * before it, legitimately carries nothing here and must still render. WRITE
 * paths do not use this — the API rejects an unrecognised tier with a 400, so a
 * typo cannot quietly demote a limit somebody meant to mark critical.
 */
export function parseSpecCriticality(value: unknown): SpecCriticality {
  return isSpecCriticality(value) ? value : DEFAULT_SPEC_CRITICALITY;
}

/** Sort key: 0 is the most critical. */
export function specCriticalityRank(value: unknown): number {
  return SPEC_CRITICALITY_VALUES.indexOf(parseSpecCriticality(value));
}

/** Comparator putting the load-stopping parameters at the top of a list. */
export function compareSpecCriticality(a: unknown, b: unknown): number {
  return specCriticalityRank(a) - specCriticalityRank(b);
}

/**
 * What a person is told each tier means. The words are deliberately about
 * CONSEQUENCE, not about the number — the tier is a business judgement, and
 * "high/medium/low" on its own would leave every tenant guessing at ours.
 */
export const SPEC_CRITICALITY_LABELS: Record<SpecCriticality, string> = {
  high: 'Critical',
  medium: 'Tracked',
  low: 'Informational',
};

export const SPEC_CRITICALITY_HELP: Record<SpecCriticality, string> = {
  high: 'Would stop a load. Show it first and loudest.',
  medium: 'Watched batch to batch. Flagged, but it is not a hold.',
  low: 'Recorded for the file. Rarely acted on.',
};

/**
 * MUI-compatible chip/text colour per tier, named here rather than in each
 * component so a rename stays a one-file edit. Plain strings on purpose — this
 * module is imported by the Workers runtime too and must not pull in MUI.
 */
export const SPEC_CRITICALITY_COLOR: Record<SpecCriticality, 'error' | 'warning' | 'default'> = {
  high: 'error',
  medium: 'warning',
  low: 'default',
};
