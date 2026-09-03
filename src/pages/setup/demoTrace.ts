/**
 * Screen 6's trace and its failure states, as pure functions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE IS SIMULATED, AND A STAGE THAT CANNOT BE OBSERVED IS OMITTED
 * ═══════════════════════════════════════════════════════════════════════════
 * Every line this module emits is derived from something actually read back
 * from the server: the queue row the real pipeline is writing, this tenant's
 * type → checklist mapping, its type-level reading instructions, its owner
 * routes. There is no timer that advances a checklist, no "usually takes about
 * ten seconds" animation, and no line that appears because the previous one
 * did. A demo that narrates stages it did not watch proves nothing, and it will
 * narrate them just as confidently on the day the pipeline is broken.
 *
 * So the rule is: if the evidence for a line is absent, the line is absent.
 * The one deliberate exception is a line that reports a CONFIGURATION GAP —
 * "no reading instructions for this type yet", "this type is not mapped to any
 * checklist item" — which is not a stage we are pretending happened but a fact
 * we read out of the tenant, and is exactly what somebody setting a tenant up
 * needs to be told.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FAILURE STATES ARE A UNION AND NOT A BOOLEAN
 * ═══════════════════════════════════════════════════════════════════════════
 * The extraction worker runs on a machine at the client's house and the model
 * behind it cold-starts with a 502 — a named, recurring failure in `todo.md`,
 * not a hypothetical. Three different things go wrong and they need three
 * different sentences, because the action is different in each:
 *
 *   worker_silent  nobody picked the item up. The fix is to start the worker;
 *                  retrying achieves nothing because nothing is running.
 *   failed         the worker picked it up and the model refused. The fix IS
 *                  a retry, and `POST /api/queue/:id/reprocess` exists for
 *                  exactly this (it zeroes `attempts` past the retry cap).
 *   timed_out      something is running and has not finished. Neither fix
 *                  applies; the honest thing is to stop watching and say so.
 *
 * A single `error: boolean` would collapse all three into "something went
 * wrong, try again", which is wrong advice in two cases out of three.
 *
 * Pure and React-free so every one of those states can be asserted without
 * rendering a page or standing up a worker — which matters, because the
 * failure paths are the ones a demo actually hits.
 */

import type {
  DocumentTypeRequirementRow,
  ProcessingQueueItem,
} from '../../lib/types';

/**
 * How long an item may sit `queued` before we say the worker is not running.
 *
 * `bin/process-worker` polls every POLL_INTERVAL, which DEFAULTS TO 30 SECONDS
 * (the file's own header says 3000, the code says 30000 — the code wins). So a
 * perfectly healthy pipeline routinely leaves an item untouched for most of a
 * minute, and a threshold under that would accuse a working system.
 *
 * 75s is two and a half poll intervals: long enough that a healthy worker has
 * had more than two chances, short enough that nobody stands in front of a
 * customer watching a spinner. The state is not terminal either way — polling
 * continues, and the message says the page will pick up where it left off.
 */
export const WORKER_SILENT_MS = 75_000;

/**
 * When to stop watching altogether.
 *
 * The worker resets an item stuck in `processing` after ten minutes, which is
 * the right number for a background sweep and far too long for somebody
 * standing at a screen. Five minutes gives a slow real extraction (OCR on a
 * scanned certificate runs to a minute or two) room to finish and still ends
 * the wait while the person is present. Giving up is not a failure of the
 * document: it stays in the review queue and the copy says so.
 */
export const DEMO_TIMEOUT_MS = 300_000;

/**
 * Where the demo has got to.
 *
 * `lastStatus` on `timed_out` is carried because "still queued after five
 * minutes" and "still extracting after five minutes" are different problems —
 * the first is a worker that never arrived, the second is one that is stuck.
 */
export type DemoState =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'upload_failed'; message: string }
  | { kind: 'queued' }
  | { kind: 'worker_silent' }
  | { kind: 'extracting' }
  | { kind: 'failed'; message: string; coldStart: boolean }
  | { kind: 'timed_out'; lastStatus: 'queued' | 'processing' }
  | { kind: 'ready' };

export interface ClassifyDemoInput {
  /** The queue row, as last polled. Null before the upload is accepted. */
  item: ProcessingQueueItem | null;
  /** Milliseconds since the upload was accepted. */
  elapsedMs: number;
  /** Set when the upload itself failed — before any queue row exists. */
  uploadError?: string | null;
  /** True between submitting the file and getting a queue id back. */
  uploading?: boolean;
}

/**
 * Does this error message describe the model being cold or absent, rather than
 * the document being bad?
 *
 * Matched against what `bin/process-worker` actually writes:
 *   "Qwen call failed: Qwen HTTP 502: …"   — the cold-start 502 itself
 *   "No available model for tag \"best\"…" — bin/lib/models.js, chain empty
 * plus the ordinary network shapes a fetch to a sleeping machine produces.
 *
 * It decides ADVICE, never severity: a cold start says "retry, this is the
 * machine waking up", anything else says "here is what it said". Both offer the
 * retry button — misclassifying is a worse sentence, never a dead end.
 */
export function isColdStartError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /\bhttp\s*(50[0-4]|429)\b/.test(m) ||
    m.includes('no available model') ||
    m.includes('cold') ||
    m.includes('econnrefused') ||
    m.includes('fetch failed') ||
    m.includes('socket hang up') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('aborted')
  );
}

/** Where the demo is, from the evidence. Total: every input maps to a state. */
export function classifyDemo({
  item,
  elapsedMs,
  uploadError,
  uploading,
}: ClassifyDemoInput): DemoState {
  if (uploadError) return { kind: 'upload_failed', message: uploadError };
  if (uploading) return { kind: 'uploading' };
  if (!item) return { kind: 'idle' };

  // A real error beats the clock. An item that failed at four minutes is
  // `failed`, not `timed_out`: we know what went wrong and can say so.
  if (item.processing_status === 'error') {
    const message = item.error_message ?? 'The extraction worker reported an error.';
    return { kind: 'failed', message, coldStart: isColdStartError(item.error_message) };
  }

  if (item.processing_status === 'ready') return { kind: 'ready' };

  if (elapsedMs >= DEMO_TIMEOUT_MS) {
    return {
      kind: 'timed_out',
      lastStatus: item.processing_status === 'processing' ? 'processing' : 'queued',
    };
  }

  if (item.processing_status === 'processing') return { kind: 'extracting' };

  // Still queued. Past the threshold, nobody has picked it up.
  return elapsedMs >= WORKER_SILENT_MS ? { kind: 'worker_silent' } : { kind: 'queued' };
}

/** Is the demo still worth polling for? */
export function isWatching(state: DemoState): boolean {
  return state.kind === 'queued' || state.kind === 'worker_silent' || state.kind === 'extracting';
}

/**
 * One line of the trace.
 *
 * `tone` is about what the reader should DO, not about how the pipeline feels:
 * `ok` is a stage that happened, `warn` is a finding that wants a human, `info`
 * is a configuration gap this tenant could close. There is no `error` tone —
 * a failure is not a trace line, it is a state, and it gets its own panel.
 */
export interface TraceLine {
  key: string;
  tone: 'ok' | 'warn' | 'info';
  text: string;
  /** A second line, where the first would otherwise have to carry two facts. */
  detail?: string;
}

export interface BuildTraceInput {
  item: ProcessingQueueItem | null;
  /**
   * This tenant's type → checklist mapping for the type the item resolved to.
   * `null` means NOT READ (or the read failed) and produces no line at all;
   * an empty array is a real answer — the type closes nothing — and produces
   * the configuration-gap line.
   */
  typeRequirements: DocumentTypeRequirementRow[] | null;
  /**
   * Whether type-level reading instructions exist for the resolved type
   * (migration 0098). `null` means not read.
   */
  hasTypeInstructions: boolean | null;
  /**
   * The department that owns renewals for the resolved type
   * (`document_types.default_owner`) and who, if anyone, that label routes to.
   * `null` means the type names no owner, which is itself worth omitting
   * rather than reporting — a type with no owner has made no claim to break.
   */
  renewalOwner: { label: string; recipients: string[] } | null;
}

/** Three names is what a line fits; the count carries the rest. */
function firstThree(names: string[]): string {
  const head = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${head}, and ${names.length - 3} more` : head;
}

/**
 * The LLM's self-rated confidence, or the deterministic heuristic when it did
 * not emit one, as a word.
 *
 * Same thresholds the Review Queue buckets its chips at (0.8 / 0.5), so a
 * document that reads "high" here is a document that shows green there. Returns
 * null when there is no signal at all — "confidence: unknown" is noise, and the
 * caller drops the parenthetical rather than printing it.
 */
export function confidenceBand(item: ProcessingQueueItem): 'high' | 'medium' | 'low' | null {
  const score = item.confidence ?? item.confidence_score;
  if (score === null || score === undefined) return null;
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/**
 * The trace, in pipeline order.
 *
 * Order is the order the pipeline actually works in — queued, classified,
 * extracted, supplier resolved, consequences computed — so a reader watching
 * lines appear is watching the document move, not watching a list fill up.
 */
export function buildTrace({
  item,
  typeRequirements,
  hasTypeInstructions,
  renewalOwner,
}: BuildTraceInput): TraceLine[] {
  const lines: TraceLine[] = [];
  if (!item) return lines;

  lines.push({ key: 'queued', tone: 'ok', text: 'Queued', detail: item.file_name });

  // ── what it IS ────────────────────────────────────────────────────────────
  // `document_type_name` is joined by the queue endpoints when the classifier
  // matched an existing type. `document_type_guess` is the model's raw label
  // when it matched nothing, and it is reported AS a guess: an unmatched guess
  // means this tenant has no such type, which is a real and fixable finding.
  const typeName = item.document_type_name ?? null;
  if (typeName) {
    const band = confidenceBand(item);
    lines.push({
      key: 'classified',
      tone: 'ok',
      text: `Read as a ${typeName}`,
      detail: band ? `confidence: ${band}` : undefined,
    });
  } else if (item.document_type_guess) {
    lines.push({
      key: 'classified',
      tone: 'info',
      text: `Read as a ${item.document_type_guess} — no document type of that name here yet`,
      detail: 'Approving it will ask you which type it is.',
    });
  }

  // ── how it was read ───────────────────────────────────────────────────────
  if (typeName && hasTypeInstructions === true) {
    lines.push({
      key: 'instructions',
      tone: 'ok',
      text: `Extracted using your ${typeName} instructions`,
    });
  } else if (typeName && hasTypeInstructions === false) {
    lines.push({
      key: 'instructions',
      tone: 'info',
      text: `No reading instructions for ${typeName} yet — the general prompt was used`,
      detail: 'Settings ▸ Document Types is where a type learns how it should be read.',
    });
  }

  // ── who it came from ──────────────────────────────────────────────────────
  // Nothing is created here. The supplier row appears when a human approves the
  // document, which is why the unmatched case says so out loud rather than
  // claiming a creation that has not happened.
  if (item.supplier) {
    lines.push(
      item.supplier_id
        ? { key: 'supplier', tone: 'ok', text: `Supplier “${item.supplier}” recognised` }
        : {
            key: 'supplier',
            tone: 'ok',
            text: `Supplier “${item.supplier}” read from the document`,
            detail: 'New to this tenant — the supplier is created when you approve it.',
          },
    );
  }

  // ── what approving it would close ─────────────────────────────────────────
  // The payoff of the teaching screen, and the reason it is phrased in the
  // future tense: `functions/lib/requirement-defaults.ts` writes the links when
  // the `documents` row appears, which is at approve time. Saying "3 items
  // proposed" now would describe rows that do not exist.
  if (typeRequirements !== null && typeName) {
    if (typeRequirements.length > 0) {
      lines.push({
        key: 'requirements',
        tone: 'ok',
        text: `${typeRequirements.length} checklist item${typeRequirements.length === 1 ? '' : 's'} will be proposed when you approve it`,
        detail: firstThree(typeRequirements.map((r) => r.requirement_name)),
      });
    } else {
      lines.push({
        key: 'requirements',
        tone: 'info',
        text: `${typeName} is not mapped to any checklist item, so approving it closes nothing`,
        detail: 'One document can satisfy several line items — that mapping is what makes it count.',
      });
    }
  }

  // ── what the results say ──────────────────────────────────────────────────
  // One line per out-of-spec result, carrying the engine's own reviewer
  // sentence verbatim. Not summarized into "2 problems": the number is not the
  // finding, the analyte and the limit are.
  for (const [index, verdict] of (item.spec_results ?? []).entries()) {
    if (verdict.verdict !== 'out_of_spec') continue;
    lines.push({
      key: `spec-${index}`,
      tone: 'warn',
      text: verdict.message,
      detail: verdict.limit_text
        ? `${verdict.source === 'printed' ? 'The certificate’s own limit' : 'Your limit'}: ${verdict.limit_text}`
        : undefined,
    });
  }

  // `not_checked` is never a silent pass, and `unmatched` is the gap between
  // what the certificate printed and what this tenant holds a limit for. Both
  // are quiet counts rather than a line each — a fourteen-row certificate
  // against three limits would otherwise bury everything above.
  const summary = item.spec_summary;
  if (summary && (summary.not_checked > 0 || summary.unmatched > 0)) {
    const parts: string[] = [];
    if (summary.not_checked > 0) {
      parts.push(`${summary.not_checked} could not be judged against a limit we hold`);
    }
    if (summary.unmatched > 0) {
      parts.push(`${summary.unmatched} we hold no limit for`);
    }
    lines.push({
      key: 'spec-summary',
      tone: 'info',
      text: `Results not given a verdict: ${parts.join('; ')}`,
      detail: 'Neither is a pass. Settings ▸ Spec Limits is where a limit is added.',
    });
  }

  // ── who hears about it next year ──────────────────────────────────────────
  if (renewalOwner) {
    lines.push(
      renewalOwner.recipients.length > 0
        ? {
            key: 'owner',
            tone: 'ok',
            text: `Renewal owner: ${renewalOwner.label} → ${firstThree(renewalOwner.recipients)}`,
          }
        : {
            key: 'owner',
            tone: 'warn',
            // The renewal path passes `adminFallback: false` on purpose, so an
            // unrouted label really does mean nobody is told. Saying "will be
            // reported as a routing gap" is the literal behaviour, not a
            // softened one.
            text: `Renewal owner: ${renewalOwner.label} — nobody is routed to that department`,
            detail:
              'Renewal alerts do not fall back to the admin pool. This record would be reported as a routing gap instead of emailing anyone.',
          },
    );
  }

  const renewal = item.renewal_proposal;
  if (renewal && renewal.due_date) {
    lines.push({
      key: 'renewal',
      tone: 'ok',
      text: `Next due ${renewal.due_date}`,
      detail: renewal.reason,
    });
  }

  return lines;
}
