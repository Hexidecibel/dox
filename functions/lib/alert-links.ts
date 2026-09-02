/**
 * Alert links — a token-gated, read-only landing page for people who are not
 * portal users.
 *
 * WHY THIS EXISTS
 * ---------------
 * A meaningful share of the people who must ACT on an alert do not have and
 * will never have an account: the plant QA lead who renews one certificate a
 * year, the person on the out-of-spec distribution list. Their entire
 * experience is the email plus one link. Before this module the out-of-spec
 * email pointed at /documents/<id>, which sits behind ProtectedRoute, so that
 * person landed on a login form; the renewal email had no link at all.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a second portal. There is no navigation, no search, no download, and no
 * way to reach a second document from the first. One link, one alert, read
 * only. If you find yourself adding a route here, the answer is a portal login.
 *
 * THE ALLOW-LIST IS THE POINT
 * ---------------------------
 * `buildAlertLandingView` constructs the response field by field from named
 * columns. It never spreads a database row and never deletes fields from a
 * wider object, because the failure mode — an internal note or a configured
 * threshold reaching a vendor — is not recoverable by apologising. In
 * particular OUR acceptance limits are withheld even though the alert email
 * itself prints them: the email has an addressed recipient list, this page is
 * whoever holds the URL, and a supplier who can read the threshold can certify
 * to it.
 *
 * Token shape and entropy follow the existing precedent in this codebase
 * (records update requests, workflow approvals): 32 random bytes -> base64url.
 */

import { generateId } from './db';
import { computeExpirations, DEFAULT_WINDOW_DAYS, isAlertStatus } from './expirations';
import type { AlertLandingView, AlertLandingSpecFailure, AlertLinkKind } from '../../shared/types';

/**
 * Default lifetime of an alert link.
 *
 * Thirty days, matching the records update-request window. Long enough that a
 * person who is on holiday when the alert fires can still act on it; short
 * enough that a forwarded email found in an archive two years later opens
 * nothing. Every link expires — there is no "no expiry" option, because a
 * permanent unauthenticated read of a compliance record is not a link, it is a
 * disclosure.
 */
export const ALERT_LINK_TTL_DAYS = 30;

/** 32 random bytes -> base64url, ~43 chars. Same entropy as /a/ and /u/. */
export function generateAlertToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export interface AlertLinkRow {
  id: string;
  token: string;
  tenant_id: string;
  kind: AlertLinkKind;
  document_id: string | null;
  subject_ids: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

export interface MintAlertLinkInput {
  tenantId: string;
  kind: AlertLinkKind;
  /** Set for spec_alert. */
  documentId?: string | null;
  /** Set for renewal_alert — the exact document set the email listed. */
  subjectIds?: string[] | null;
  ttlDays?: number;
}

/**
 * Create a link for one alert event and return its token.
 *
 * BEST-EFFORT, LIKE EVERYTHING ELSE ON THE NOTIFY PATH. If minting fails the
 * caller sends the email without a link rather than not sending the email — a
 * safety alert that never arrives is worse than one that makes the recipient
 * log in.
 *
 * A new link every time, deliberately: reusing an old row would let a link
 * forwarded last month silently widen to cover a document that was not in the
 * email it came from.
 */
export async function mintAlertLink(
  db: D1Database,
  input: MintAlertLinkInput
): Promise<string | null> {
  try {
    const token = generateAlertToken();
    const ttl = input.ttlDays ?? ALERT_LINK_TTL_DAYS;
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + ttl);

    await db
      .prepare(
        `INSERT INTO alert_links
           (id, token, tenant_id, kind, document_id, subject_ids, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generateId(),
        token,
        input.tenantId,
        input.kind,
        input.documentId ?? null,
        input.subjectIds && input.subjectIds.length > 0 ? JSON.stringify(input.subjectIds) : null,
        expires.toISOString()
      )
      .run();

    return token;
  } catch (err) {
    console.error(
      '[alert-links] minting a link failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/** The URL an email should point at. Returns null when either half is missing. */
export function alertLinkUrl(appUrl: string | undefined, token: string | null): string | null {
  if (!appUrl || !token) return null;
  return `${appUrl.replace(/\/$/, '')}/alert/${token}`;
}

/**
 * Look a token up and decide whether it is still usable.
 *
 * Returns null for EVERY unusable case — unknown, expired, revoked — so the
 * endpoint can answer 404 uniformly and a token cannot be probed for existence.
 */
export async function loadUsableAlertLink(
  db: D1Database,
  token: string
): Promise<AlertLinkRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await db
    .prepare('SELECT * FROM alert_links WHERE token = ?')
    .bind(token)
    .first<AlertLinkRow>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.expires_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/** Parse the JSON subject_ids column into a string[]. Tolerant. */
export function parseSubjectIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The printed limit, and ONLY when it was printed.
 *
 * A 'printed' verdict was judged against text on the supplier's own document,
 * so showing it back is showing them their own certificate. A 'limit' verdict
 * was judged against a threshold we configured, and that number does not leave
 * the portal.
 */
function printedLimitOf(source: string, limitSnapshot: string | null): string | null {
  if (source !== 'printed') return null;
  if (!limitSnapshot) return null;
  try {
    const parsed = JSON.parse(limitSnapshot) as { printed?: unknown };
    return typeof parsed.printed === 'string' ? parsed.printed : null;
  } catch {
    return null;
  }
}

interface SpecCheckRow {
  test_name_raw: string;
  value_raw: string | null;
  unit_raw: string | null;
  source: string;
  limit_snapshot: string | null;
}

/**
 * Project one alert into the exact payload a non-portal recipient may see.
 *
 * Every field below is named on purpose. Things intentionally NOT here, because
 * a vendor holding a forwarded link must never see them:
 *
 *   - any internal id (document, tenant, supplier, limit, queue item)
 *   - our configured acceptance limits, in any form: value_min/value_max,
 *     operator, severity, limit_id, spec_test_id, limit_snapshot
 *   - classification status or the reasoning behind it
 *   - extraction confidence, model names, queue/processing state
 *   - internal routing: assignment owners, reviewer identities, notes,
 *     acknowledgements, audit
 *   - the file itself; there is no download and no R2 key
 *   - anything belonging to another supplier, document, or tenant
 */
export async function buildAlertLandingView(
  db: D1Database,
  link: AlertLinkRow
): Promise<AlertLandingView | null> {
  const tenant = await db
    .prepare('SELECT name FROM tenants WHERE id = ?')
    .bind(link.tenant_id)
    .first<{ name: string }>();
  if (!tenant) return null;

  const base = {
    kind: link.kind,
    tenant_name: tenant.name,
    expires_at: link.expires_at,
  };

  if (link.kind === 'spec_alert') {
    if (!link.document_id) return null;

    // Tenant-scoped on purpose: a link's tenant is fixed at mint time, so a
    // document that somehow moved cannot be read through an old token.
    const doc = await db
      .prepare(
        `SELECT d.title       AS title,
                s.name        AS supplier_name,
                dt.name       AS document_type_name,
                d.created_at  AS received_date
           FROM documents d
           LEFT JOIN suppliers s      ON s.id  = d.supplier_id
           LEFT JOIN document_types dt ON dt.id = d.document_type_id
          WHERE d.id = ? AND d.tenant_id = ? AND d.status != 'deleted'`
      )
      .bind(link.document_id, link.tenant_id)
      .first<{
        title: string;
        supplier_name: string | null;
        document_type_name: string | null;
        received_date: string | null;
      }>();
    if (!doc) return null;

    const res = await db
      .prepare(
        `SELECT test_name_raw, value_raw, unit_raw, source, limit_snapshot
           FROM document_spec_checks
          WHERE document_id = ? AND tenant_id = ? AND verdict = 'out_of_spec'
          ORDER BY created_at ASC`
      )
      .bind(link.document_id, link.tenant_id)
      .all<SpecCheckRow>();

    const failures: AlertLandingSpecFailure[] = (res.results ?? []).map((r) => ({
      test: r.test_name_raw,
      value: r.value_raw ?? null,
      unit: r.unit_raw ?? null,
      judged_against: r.source === 'printed' ? 'printed' : 'internal',
      printed_limit: printedLimitOf(r.source, r.limit_snapshot),
    }));

    return {
      ...base,
      document: {
        title: doc.title,
        supplier_name: doc.supplier_name,
        document_type_name: doc.document_type_name,
        received_date: doc.received_date,
      },
      failures,
      renewals: [],
    };
  }

  // ── renewal digest ──────────────────────────────────────────────────────
  const subjectIds = new Set(parseSubjectIds(link.subject_ids));
  if (subjectIds.size === 0) return null;

  // Recomputed live rather than frozen at send time: the whole point of the
  // page is to show the CURRENT state of the thing needing action. Filtered to
  // the exact set the email named, so an old link never widens.
  const asOf = new Date().toISOString().slice(0, 10);
  const { rows } = await computeExpirations(db, link.tenant_id, asOf, DEFAULT_WINDOW_DAYS);
  const renewals = rows
    .filter((r) => subjectIds.has(r.id) && isAlertStatus(r.status))
    .map((r) => ({
      title: r.title,
      category: r.primary_category_name,
      due_date: r.renewal_due_date,
      days_until: r.days_until,
      status: r.status as string,
    }));

  return { ...base, document: null, failures: [], renewals };
}

/**
 * Record that a link was opened. Best-effort counter; the authoritative record
 * of the view is the audit_log row the endpoint writes.
 */
export async function recordAlertLinkView(db: D1Database, linkId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE alert_links
            SET view_count = view_count + 1, last_viewed_at = datetime('now')
          WHERE id = ?`
      )
      .bind(linkId)
      .run();
  } catch (err) {
    console.error(
      '[alert-links] recording a view failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}
