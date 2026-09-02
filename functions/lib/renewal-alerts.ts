/**
 * The renewal alert engine — one implementation, two callers.
 *
 * `POST /api/expirations/notify` (a human presses a button) and
 * `POST /api/expirations/run-scheduled` (the dox-renewal-alerts Worker, once a
 * day) both come through here. They differ by exactly one flag, so the manual
 * button and the cron can never drift into sending different things to
 * different people.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED AND WHY
 * ---------------------------------------------------------------------------
 * The renewal alert used to select every org_admin of the tenant plus every
 * super_admin in the install and send them ONE email listing every alerting
 * document. The client's objection is the correct one: "An alert everyone
 * receives is an alert nobody acts on."
 *
 * Now the alerting set is GROUPED BY OWNER and each group gets its own email
 * containing only its own records, addressed only to the people that owner
 * label resolves to. See `functions/lib/alert-routing.ts` for the ladder.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY - why a daily job is not a daily email
 * ---------------------------------------------------------------------------
 * A certificate sits inside a 60-day look-ahead window for sixty days. Mailing
 * whatever is in the window every morning means mailing the same person about
 * the same certificate sixty times. By the fourth morning it is a filter rule,
 * and the fifty-ninth morning - the one that matters - is the one nobody
 * reads. A job like that is worse than no job.
 *
 * So `renewal_alert_state` (migration 0091) holds one row per document and a
 * document is only re-sent when there is something new to say:
 *
 *   never alerted        -> send        ("first")
 *   status escalated     -> send        ("escalated")  - cooldown IGNORED
 *   cooldown elapsed     -> send        ("cooldown_elapsed")
 *   otherwise            -> SKIP        ("suppressed")
 *
 * Escalation means expiring -> overdue/expired: the date actually passed,
 * which is new information and outranks any quiet period. The reverse (a due
 * date pushed out because somebody renewed) is NOT an escalation and correctly
 * goes quiet.
 *
 * The cooldown is 7 days, not 1 and not 30. A renewal is a task with weeks of
 * lead time, not an incident: daily is noise, monthly loses the item. Weekly
 * keeps an open item present without making the mailbox unusable - and the
 * escalation rule means the "it expired" mail arrives the morning it expires
 * regardless of where the week landed.
 *
 * The manual button passes `respectCooldown: false` - a human asking for the
 * digest now gets it now - but it still WRITES the ledger, so pressing the
 * button at 09:00 does not get repeated by the cron at 13:00.
 *
 * ---------------------------------------------------------------------------
 * UNROUTED RECORDS ARE A REPORTED FAILURE, NOT A SILENT BROADCAST
 * ---------------------------------------------------------------------------
 * If a record's owner does not resolve, it does NOT quietly go to the admin
 * pool as a renewal alert. It goes into the `unrouted` bucket, which produces:
 *   - a separately-worded routing-gap notice to the tenant's org_admins that
 *     says plainly that nobody was alerted (buildRenewalRoutingGapEmail),
 *   - an `expirations.routing_gap` audit_log row,
 *   - an `unrouted` block in the API response the caller can display.
 * Same suppression rules apply to it, so the gap notice is also not a daily
 * drumbeat.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  computeExpirations,
  alertingRows,
  daysBetween,
  DEFAULT_WINDOW_DAYS,
  type ExpirationRow,
} from './expirations';
import {
  resolveAlertRouting,
  resolveTenantAdmins,
  normalizeOwnerKey,
  type RoutingVia,
} from './alert-routing';
import { sendEmail, buildRenewalAlertEmail, buildRenewalRoutingGapEmail } from './email';
import { mintAlertLink, alertLinkUrl } from './alert-links';
import { generateId, logAudit } from './db';

/** Days of quiet between repeat alerts about the same unchanged record. */
export const DEFAULT_COOLDOWN_DAYS = 7;

/**
 * Escalation rank. Only an INCREASE re-alerts through a cooldown.
 * `overdue` and `expired` share a rank - they are the same severity expressed
 * by two different renewal_types, and a document does not move between them.
 */
const STATUS_RANK: Record<string, number> = {
  current: 0,
  stale: 0,
  expiring: 1,
  overdue: 2,
  expired: 2,
};

export function statusRank(status: string | null | undefined): number {
  return STATUS_RANK[status ?? ''] ?? 0;
}

export interface RenewalAlertStateRow {
  document_id: string;
  last_status: string;
  last_due_date: string | null;
  /** Wall-clock time of the last send. Forensics only. */
  last_notified_at: string;
  /** The `as_of` DATE the last send ran under. This is what the cooldown uses. */
  last_notified_as_of: string | null;
  notify_count: number;
}

export type SendDecision = 'first' | 'escalated' | 'cooldown_elapsed' | 'suppressed';

/**
 * Pure: should this document be included in today's send?
 *
 * Kept HTTP-free and DB-free so the two-consecutive-runs behaviour is testable
 * without a mail server or a clock.
 */
export function decideSend(
  row: Pick<ExpirationRow, 'status'>,
  state: RenewalAlertStateRow | null | undefined,
  asOf: string,
  cooldownDays: number = DEFAULT_COOLDOWN_DAYS,
): SendDecision {
  if (!state) return 'first';
  if (statusRank(row.status) > statusRank(state.last_status)) return 'escalated';

  // Measured in the run's own time base: `as_of` against the `as_of` of the
  // last send, never against the wall clock. A run that passes an explicit
  // as_of (an operator replaying a missed day) would otherwise compute a
  // negative elapsed time and suppress the record forever. Falls back to the
  // wall-clock stamp's date for rows written before that column existed.
  const lastDay = (state.last_notified_as_of || state.last_notified_at || '').slice(0, 10);
  const elapsed = daysBetween(lastDay, asOf);
  // An unparseable stamp must not mean permanent silence about a live record.
  if (elapsed === null) return 'cooldown_elapsed';
  return elapsed >= cooldownDays ? 'cooldown_elapsed' : 'suppressed';
}

export interface OwnerGroupResult {
  /** documents.owner as stored, or null for records that name no owner. */
  owner_label: string | null;
  /** Which rung of the routing ladder answered. */
  via: RoutingVia;
  recipients: string[];
  document_count: number;
  document_ids: string[];
  sent: boolean;
}

export interface UnroutedResult {
  count: number;
  /** Distinct owner labels that had no route; null entries mean "no owner set". */
  owner_labels: Array<string | null>;
  documents: Array<{ id: string; title: string; owner: string | null }>;
  /** Admins told about the GAP (not about the renewal). Empty if none exist. */
  notified: string[];
  /** Whether the gap notice actually went out. */
  notice_sent: boolean;
}

/**
 * Why nothing (or nothing more) went out. Distinct values on purpose: "there
 * was nothing to alert on" and "everything was held back" and "nobody owns any
 * of this" are three very different states of the world, and collapsing them
 * into one reason is how a routing failure gets read as a quiet day.
 */
export type RenewalNoSendReason =
  /** The alert set was empty - nothing expiring, overdue or expired. */
  | 'no_documents'
  /** There WERE alerting records; every one had been mailed about recently. */
  | 'all_suppressed'
  /** RESEND_API_KEY is unset. Routing was computed, nothing was sent. */
  | 'email_not_configured'
  /** Records were due but NOT ONE resolved to an owner. A configuration gap. */
  | 'all_unrouted'
  /** Groups resolved but every send failed / produced no address. */
  | 'no_recipients';

export interface RenewalAlertResult {
  tenant_id: string;
  tenant_name: string;
  sent: boolean;
  /** Everyone actually mailed a renewal digest, deduped. */
  recipients: string[];
  /** Documents included in a digest that was actually sent. */
  document_count: number;
  /** Documents in the alert set before suppression. */
  alerting_count: number;
  /** Held back by the cooldown because nothing about them changed. */
  suppressed_count: number;
  groups: OwnerGroupResult[];
  unrouted: UnroutedResult;
  reason?: RenewalNoSendReason;
}

export interface RunRenewalAlertsOptions {
  tenantId: string;
  asOf?: string;
  windowDays?: number;
  /** Origin used to build the /alert/<token> link. */
  appUrl?: string;
  /**
   * Scheduled runs honour the cooldown; a human pressing the button does not.
   * Either way the ledger is written, so a manual send suppresses the next
   * scheduled one.
   */
  respectCooldown: boolean;
  cooldownDays?: number;
  /** Attributed on the audit row. Null for the cron. */
  actorUserId?: string | null;
}

function emptyUnrouted(): UnroutedResult {
  return { count: 0, owner_labels: [], documents: [], notified: [], notice_sent: false };
}

/**
 * Load the ledger for a tenant, keyed by document id.
 * A missing table (an environment that has not run 0091) yields an empty map,
 * which degrades to "alert everything once" rather than to a 500.
 */
async function loadAlertState(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, RenewalAlertStateRow>> {
  try {
    const res = await db
      .prepare(
        `SELECT document_id, last_status, last_due_date, last_notified_at,
                last_notified_as_of, notify_count
           FROM renewal_alert_state WHERE tenant_id = ?`,
      )
      .bind(tenantId)
      .all<RenewalAlertStateRow>();
    return new Map((res.results ?? []).map((r) => [r.document_id, r]));
  } catch (err) {
    console.error(
      '[renewal-alerts] loading alert state failed:',
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

/**
 * Stamp the ledger for every document that was actually mailed about.
 *
 * Written AFTER the send, never before: a stamp for mail that never left would
 * suppress the next run's attempt at the same record, which is the one failure
 * mode worse than duplicate mail.
 */
async function recordNotified(
  db: D1Database,
  tenantId: string,
  asOf: string,
  rows: ExpirationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO renewal_alert_state
         (id, tenant_id, document_id, last_status, last_due_date,
          last_notified_at, last_notified_as_of, notify_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, 1)
       ON CONFLICT(tenant_id, document_id) DO UPDATE SET
         last_status         = excluded.last_status,
         last_due_date       = excluded.last_due_date,
         last_notified_at    = excluded.last_notified_at,
         last_notified_as_of = excluded.last_notified_as_of,
         notify_count        = renewal_alert_state.notify_count + 1`,
    );
    await db.batch(
      rows.map((r) =>
        stmt.bind(generateId(), tenantId, r.id, r.status, r.renewal_due_date ?? null, asOf),
      ),
    );
  } catch (err) {
    console.error(
      '[renewal-alerts] recording alert state failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface OwnerGrouping {
  key: string | null;
  label: string | null;
  rows: ExpirationRow[];
}

/**
 * Group the alerting rows by their owner label.
 *
 * Grouping is on the NORMALIZED key so 'QA' and 'qa' are one group, but the
 * label carried forward is the first as-typed spelling, because that is what
 * the recipient recognises. Records with no owner group under `null`, which
 * always routes nowhere and always lands in the gap bucket.
 */
export function groupByOwner(rows: ExpirationRow[]): OwnerGrouping[] {
  // Keyed on `string | null` directly rather than on a sentinel string: a
  // sentinel would collide with a real owner label literally named after it.
  const groups = new Map<string | null, OwnerGrouping>();
  for (const r of rows) {
    const key = normalizeOwnerKey(r.owner);
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(r);
    } else {
      groups.set(key, { key, label: key ? r.owner : null, rows: [r] });
    }
  }
  return [...groups.values()];
}

/**
 * Run the renewal alert for ONE tenant.
 *
 * The caller (cron) walks every tenant, so this is written to degrade rather
 * than throw: a tenant with a broken config must not stop the rest of the run.
 */
export async function runRenewalAlerts(
  db: D1Database,
  resendApiKey: string | undefined,
  opts: RunRenewalAlertsOptions,
): Promise<RenewalAlertResult> {
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cooldownDays = opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;

  const tenantRow = await db
    .prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(opts.tenantId)
    .first<{ name: string }>();
  const tenantName = tenantRow?.name ?? 'your organization';

  const base: RenewalAlertResult = {
    tenant_id: opts.tenantId,
    tenant_name: tenantName,
    sent: false,
    recipients: [],
    document_count: 0,
    alerting_count: 0,
    suppressed_count: 0,
    groups: [],
    unrouted: emptyUnrouted(),
  };

  const { rows } = await computeExpirations(db, opts.tenantId, asOf, windowDays);
  const alerts = alertingRows(rows);
  base.alerting_count = alerts.length;
  if (alerts.length === 0) {
    return { ...base, reason: 'no_documents' };
  }

  // -- suppression ----------------------------------------------------------
  const state = await loadAlertState(db, opts.tenantId);
  const due: ExpirationRow[] = [];
  for (const r of alerts) {
    const decision = opts.respectCooldown
      ? decideSend(r, state.get(r.id), asOf, cooldownDays)
      : 'first';
    if (decision === 'suppressed') base.suppressed_count += 1;
    else due.push(r);
  }
  if (due.length === 0) {
    // Everything in the window has already been said recently. A successful
    // run with nothing new to send, which is what most mornings look like.
    return { ...base, reason: 'all_suppressed' };
  }

  // -- routing --------------------------------------------------------------
  const groups: OwnerGroupResult[] = [];
  const unroutedRows: ExpirationRow[] = [];
  const routed: Array<{ group: OwnerGroupResult; rows: ExpirationRow[] }> = [];

  for (const g of groupByOwner(due)) {
    // adminFallback: false - the whole point. See alert-routing.ts.
    const routing = await resolveAlertRouting(db, {
      tenantId: opts.tenantId,
      ownerLabel: g.label,
      supplierId: null,
      documentTypeId: null,
      adminFallback: false,
    });

    if (routing.recipients.length === 0) {
      unroutedRows.push(...g.rows);
      continue;
    }

    const group: OwnerGroupResult = {
      owner_label: g.label,
      via: routing.via,
      recipients: routing.recipients.map((r) => r.email),
      document_count: g.rows.length,
      document_ids: g.rows.map((r) => r.id),
      sent: false,
    };
    groups.push(group);
    routed.push({ group, rows: g.rows });
  }

  base.groups = groups;

  if (!resendApiKey) {
    // Report the routing we WOULD have used - a tenant without Resend still
    // gets to see whether its ownership config resolves - but change nothing.
    return {
      ...base,
      document_count: 0,
      unrouted: {
        count: unroutedRows.length,
        owner_labels: [...new Set(unroutedRows.map((r) => r.owner ?? null))],
        documents: unroutedRows.map((r) => ({ id: r.id, title: r.title, owner: r.owner })),
        notified: [],
        notice_sent: false,
      },
      reason: 'email_not_configured',
    };
  }

  // -- one digest per owner group -------------------------------------------
  const mailed: ExpirationRow[] = [];
  const allRecipients = new Set<string>();

  for (const { group, rows: groupRows } of routed) {
    // A fresh link per group, scoped to exactly that owner's records - so a
    // forwarded QA link never opens Accounting's list, and never widens later.
    const token = await mintAlertLink(db, {
      tenantId: opts.tenantId,
      kind: 'renewal_alert',
      subjectIds: groupRows.map((r) => r.id),
    });

    const { subject, html } = buildRenewalAlertEmail(
      groupRows,
      tenantName,
      alertLinkUrl(opts.appUrl, token),
      group.owner_label,
    );

    const ok = await sendEmail(resendApiKey, { to: group.recipients, subject, html });
    group.sent = ok;
    if (ok) {
      mailed.push(...groupRows);
      for (const e of group.recipients) allRecipients.add(e);
    }
  }

  // -- the routing gap ------------------------------------------------------
  const unrouted = await reportRoutingGap(
    db,
    resendApiKey,
    opts.tenantId,
    tenantName,
    unroutedRows,
    opts.actorUserId ?? null,
  );

  // Gap-notice records are stamped too: the notice IS what was said about them
  // this cycle, so it obeys the same weekly quiet period. Records for which
  // NOTHING went out (no admins, notice failed) are deliberately left
  // unstamped, so the next run tries again.
  await recordNotified(db, opts.tenantId, asOf, [
    ...mailed,
    ...(unrouted.notice_sent ? unroutedRows : []),
  ]);

  return {
    ...base,
    sent: mailed.length > 0,
    recipients: [...allRecipients],
    document_count: mailed.length,
    groups,
    unrouted,
    reason: noSendReason(mailed.length, groups.length, unrouted.count),
  };
}

/**
 * Name the failure precisely when a run sends no digest.
 *
 * `all_unrouted` is the one that matters: it means the records were real, they
 * were due, and NOBODY was told - which the caller must be able to show
 * without inferring it from a zero.
 */
function noSendReason(
  mailedCount: number,
  groupCount: number,
  unroutedCount: number,
): RenewalNoSendReason | undefined {
  if (mailedCount > 0) return undefined;
  if (groupCount === 0 && unroutedCount > 0) return 'all_unrouted';
  return 'no_recipients';
}

/**
 * Make the routing gap loud.
 *
 * Always writes the audit row, even when there is no admin to email and even
 * when the notice fails to send - the record of "these went unalerted" must
 * not depend on the mail path that already failed.
 */
async function reportRoutingGap(
  db: D1Database,
  resendApiKey: string | undefined,
  tenantId: string,
  tenantName: string,
  rows: ExpirationRow[],
  actorUserId: string | null,
): Promise<UnroutedResult> {
  const result: UnroutedResult = {
    count: rows.length,
    owner_labels: [...new Set(rows.map((r) => r.owner ?? null))],
    documents: rows.map((r) => ({ id: r.id, title: r.title, owner: r.owner })),
    notified: [],
    notice_sent: false,
  };
  if (rows.length === 0) return result;

  try {
    await logAudit(
      db,
      actorUserId,
      tenantId,
      'expirations.routing_gap',
      'document',
      null,
      JSON.stringify({
        unrouted_count: rows.length,
        owner_labels: result.owner_labels,
        document_ids: rows.map((r) => r.id),
      }),
      null,
    );
  } catch (err) {
    console.error(
      '[renewal-alerts] audit for routing gap failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!resendApiKey) return result;

  // The gap notice is the ONLY thing that reaches the admin pool, and it is
  // explicitly not a renewal alert. Tenant org_admins only - never every
  // super_admin in the install, which is what the old broadcast did.
  const admins = await resolveTenantAdmins(db, tenantId);
  result.notified = admins.map((a) => a.email);
  if (admins.length === 0) return result;

  const { subject, html } = buildRenewalRoutingGapEmail(rows, tenantName);
  result.notice_sent = await sendEmail(resendApiKey, {
    to: result.notified,
    subject,
    html,
  });
  return result;
}
