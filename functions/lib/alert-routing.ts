/**
 * Alert routing — the ONE place that answers "who hears about this record?".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this, routing lived in exactly one private helper
 * (`resolveAlertRecipients` in spec-register.ts) with its own fallback baked
 * in, and the renewal path had no routing at all — it selected every
 * org_admin of the tenant plus every super_admin and sent them one email. Two
 * alert paths, two different answers to the same question, and one of them was
 * "everybody".
 *
 * Now there is one ladder, and the rung a message came down is part of the
 * result rather than something the caller has to infer.
 *
 * THE LADDER
 * ----------
 *   1. owner_route   — `documents.owner` (free text: 'QA', 'Insurance', ...)
 *                      mapped through `owner_routes` (migration 0091) to real
 *                      people or addresses. This is the rung the client asked
 *                      for: the record's own owner.
 *   2. assignment    — `assignments` (migration 0071), the owner of a
 *                      (supplier, document_type) review queue. Applies where a
 *                      record HAS a supplier, which registry documents (a
 *                      business licence, a certificate of insurance) usually
 *                      do not.
 *   3. tenant_admins — every org_admin of the tenant. OPT-IN per caller, and
 *                      the calling code has to ask for it by name.
 *   4. unrouted      — nobody. Returned as a first-class result, never as an
 *                      empty list the caller might mistake for success.
 *
 * WHY `adminFallback` IS A PARAMETER AND NOT A DEFAULT
 * ---------------------------------------------------
 * The two callers genuinely want different things, and the difference is worth
 * stating rather than hiding:
 *
 *   - SPEC alerts (out-of-spec analytical result) pass adminFallback: true.
 *     These are one-shot, event-driven, and food-safety-shaped. An out-of-spec
 *     result that reaches nobody because a combo was never assigned is a worse
 *     outcome than an admin getting mail they did not need. This preserves the
 *     behaviour that shipped with 0085 rather than quietly narrowing it.
 *
 *   - RENEWAL alerts pass adminFallback: false. These are recurring and
 *     scheduled. Falling back to the admin pool here is precisely the bug
 *     being fixed: it turns "this tenant has not configured ownership" into a
 *     daily broadcast, which trains everyone to ignore the mail. Unrouted
 *     records surface as a visible routing GAP instead — a separate,
 *     differently-worded message plus a count in the API response — so nobody
 *     can mistake it for the alert having been delivered.
 *
 * Everything here is best-effort read-only and swallows its own errors: a
 * routing lookup that throws must not take down an ingest or a cron tick.
 */

import type { D1Database } from '@cloudflare/workers-types';

export interface AlertRecipient {
  email: string;
  name: string | null;
}

/** Which rung of the ladder produced the recipients. */
export type RoutingVia = 'owner_route' | 'assignment' | 'tenant_admins' | 'unrouted';

export interface RoutingResult {
  recipients: AlertRecipient[];
  via: RoutingVia;
  /** The owner label that was looked up, as stored on the document. */
  owner_label: string | null;
}

export interface RoutingQuery {
  tenantId: string;
  /** documents.owner — free text. Null/blank means the record names no owner. */
  ownerLabel?: string | null;
  supplierId?: string | null;
  documentTypeId?: string | null;
  /**
   * Whether to fall back to the tenant's org_admins when neither an owner
   * route nor an assignment resolves. NO DEFAULT ON PURPOSE — see the module
   * comment. Callers state which failure mode they are choosing.
   */
  adminFallback: boolean;
}

/**
 * Normalize an owner label into its match key.
 *
 * Lower-case, trim, collapse internal whitespace. Deliberately conservative:
 * no stemming, no punctuation stripping, no synonym table. 'QA' and 'qa' are
 * the same owner; 'QA' and 'Quality Assurance' are not, because guessing that
 * they are would route a compliance alert on a hunch. A tenant that wants both
 * spellings creates two routes.
 */
export function normalizeOwnerKey(label: string | null | undefined): string | null {
  if (label == null) return null;
  const key = String(label).trim().toLowerCase().replace(/\s+/g, ' ');
  return key.length > 0 ? key : null;
}

function dedupe(rows: AlertRecipient[]): AlertRecipient[] {
  const seen = new Map<string, AlertRecipient>();
  for (const r of rows) {
    const email = (r.email || '').trim();
    if (!email) continue;
    const k = email.toLowerCase();
    if (!seen.has(k)) seen.set(k, { email, name: r.name ?? null });
  }
  return [...seen.values()];
}

/**
 * Rung 1 — the record's own owner label, mapped through `owner_routes`.
 *
 * A route pointing at a portal user resolves through `users` so a deactivated
 * account stops receiving mail without anyone editing the route. A route
 * holding a bare address is used as-is; there is no account to deactivate, so
 * `active = 0` on the route row is the off switch.
 */
export async function resolveOwnerRoute(
  db: D1Database,
  tenantId: string,
  ownerLabel: string | null | undefined
): Promise<AlertRecipient[]> {
  const key = normalizeOwnerKey(ownerLabel);
  if (!key) return [];
  try {
    const res = await db
      .prepare(
        `SELECT COALESCE(u.email, r.email) AS email,
                COALESCE(u.name, r.owner_label) AS name
           FROM owner_routes r
           LEFT JOIN users u ON u.id = r.user_id
          WHERE r.tenant_id = ?
            AND r.owner_key = ?
            AND r.active = 1
            AND (r.user_id IS NULL OR (u.id IS NOT NULL AND u.active = 1))
            AND COALESCE(u.email, r.email) IS NOT NULL`
      )
      .bind(tenantId, key)
      .all<{ email: string; name: string | null }>();
    return dedupe(res.results ?? []);
  } catch (err) {
    console.error(
      '[alert-routing] owner route lookup failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/** Rung 2 — the owner of the (supplier, document_type) review queue. */
export async function resolveAssignmentOwners(
  db: D1Database,
  tenantId: string,
  supplierId: string | null | undefined,
  documentTypeId: string | null | undefined
): Promise<AlertRecipient[]> {
  if (!supplierId || !documentTypeId) return [];
  try {
    const res = await db
      .prepare(
        `SELECT u.email, u.name
           FROM assignments a
           JOIN users u ON u.id = a.owner_user_id
          WHERE a.tenant_id = ? AND a.supplier_id = ? AND a.document_type_id = ?
            AND u.active = 1 AND u.email IS NOT NULL`
      )
      .bind(tenantId, supplierId, documentTypeId)
      .all<{ email: string; name: string | null }>();
    return dedupe(res.results ?? []);
  } catch (err) {
    console.error(
      '[alert-routing] assignment lookup failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Rung 3 — the tenant's org_admins.
 *
 * NOTE what is NOT here: super_admins. The old renewal recipient query pulled
 * in every super_admin across the whole install, which means an operator of a
 * multi-tenant deployment received every tenant's renewal mail. That is the
 * "alert everyone receives" failure at its most literal.
 */
export async function resolveTenantAdmins(
  db: D1Database,
  tenantId: string
): Promise<AlertRecipient[]> {
  try {
    const res = await db
      .prepare(
        `SELECT email, name FROM users
          WHERE tenant_id = ? AND role = 'org_admin' AND active = 1 AND email IS NOT NULL`
      )
      .bind(tenantId)
      .all<{ email: string; name: string | null }>();
    return dedupe(res.results ?? []);
  } catch (err) {
    console.error(
      '[alert-routing] tenant admin lookup failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Walk the ladder and report which rung answered.
 *
 * A caller that wants "was this actually routed to an owner" checks
 * `via === 'owner_route' || via === 'assignment'`. A caller that wants "did
 * this reach anybody at all" checks `recipients.length`. Those are different
 * questions and the renewal digest asks both.
 */
export async function resolveAlertRouting(
  db: D1Database,
  q: RoutingQuery
): Promise<RoutingResult> {
  const ownerLabel = q.ownerLabel ?? null;

  const owned = await resolveOwnerRoute(db, q.tenantId, ownerLabel);
  if (owned.length > 0) return { recipients: owned, via: 'owner_route', owner_label: ownerLabel };

  const assigned = await resolveAssignmentOwners(db, q.tenantId, q.supplierId, q.documentTypeId);
  if (assigned.length > 0) {
    return { recipients: assigned, via: 'assignment', owner_label: ownerLabel };
  }

  if (q.adminFallback) {
    const admins = await resolveTenantAdmins(db, q.tenantId);
    if (admins.length > 0) {
      return { recipients: admins, via: 'tenant_admins', owner_label: ownerLabel };
    }
  }

  return { recipients: [], via: 'unrouted', owner_label: ownerLabel };
}
