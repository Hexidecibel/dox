/**
 * At approval: remember when each document ARRIVED, and tell the QA lane when a
 * certificate was already expired on that day (rules table G4, 2026-09-27).
 *
 * The pure rule is `shared/expiredOnArrival.ts`. This is the D1 half, called by
 * the Review Queue approve paths once the documents exist:
 *
 *   1. stamp `documents.arrived_at` (migration 0121) from the queue item's
 *      `created_at` — the day the file reached us, which the gap engine reads to
 *      decide whether the document can close its requirement at all;
 *   2. for each document whose approved `document_expires_on` is before that
 *      day, write a `document.expired_on_arrival` audit row;
 *   3. mail ONE notice per approval to the "QA" owner route through the shared
 *      ladder (`resolveAlertRouting`), with `adminFallback: false` — the renewal
 *      path's choice, not the spec path's. An expired certificate is a document
 *      to re-request, not a one-shot safety event, and a notice that falls back
 *      to the admin pool trains everyone to ignore it. When nothing resolves,
 *      it is the renewal routing gap: an audit row and a notice to org_admins
 *      that says, in words, that nobody was alerted.
 *
 * NEVER BLOCKS, NEVER THROWS UPWARD. The approval has already happened and must
 * stand; this is notification and bookkeeping. Nothing is held.
 */

import { logAudit } from './db';
import { sendEmail, buildExpiredOnArrivalEmail } from './email';
import { resolveAlertRouting, resolveTenantAdmins } from './alert-routing';
import {
  EXPIRED_ON_ARRIVAL_OWNER_LABEL,
  expiredOnArrival,
} from '../../shared/expiredOnArrival';
import type { ExpiredOnArrival } from '../../shared/expiredOnArrival';

export interface ArrivalCheckContext {
  tenantId: string;
  tenantName: string;
  queueItemId: string;
  /** processing_queue.created_at — the day the file reached us. */
  arrivedAt: string | null;
  supplierId: string | null;
  supplierName: string | null;
  documentTypeId: string | null;
  actorUserId: string;
  appUrl?: string;
}

export interface ArrivalCheckResult {
  expired: Array<{ documentId: string; title: string; finding: ExpiredOnArrival }>;
  via: 'owner_route' | 'assignment' | 'tenant_admins' | 'unrouted' | 'not_sent';
  notified: string[];
}

export async function recordArrivalAndCheckExpiry(
  db: D1Database,
  apiKey: string | undefined,
  ctx: ArrivalCheckContext,
  documentIds: string[]
): Promise<ArrivalCheckResult> {
  const result: ArrivalCheckResult = { expired: [], via: 'not_sent', notified: [] };
  if (documentIds.length === 0) return result;
  try {
    // 1. Arrival. Only where nothing is recorded: a document's arrival is a
    //    fact about its first appearance and a later approval must not move it.
    if (ctx.arrivedAt) {
      await db.batch(
        documentIds.map((id) =>
          db
            .prepare(
              `UPDATE documents SET arrived_at = ?
                WHERE id = ? AND tenant_id = ? AND arrived_at IS NULL`
            )
            .bind(ctx.arrivedAt, id, ctx.tenantId)
        )
      );
    }

    // 2. Judge each document on what was APPROVED (the reviewer may have
    //    corrected the printed expiry), against the arrival now on file.
    const placeholders = documentIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, title, arrived_at, created_at,
                CASE WHEN json_valid(primary_metadata)
                     THEN json_extract(primary_metadata, '$.document_expires_on') END AS expires_on
           FROM documents
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(ctx.tenantId, ...documentIds)
      .all<{ id: string; title: string; arrived_at: string | null; created_at: string | null; expires_on: string | null }>();

    for (const r of rows.results ?? []) {
      const finding = expiredOnArrival(r);
      if (!finding) continue;
      result.expired.push({ documentId: r.id, title: r.title, finding });
      await logAudit(
        db,
        ctx.actorUserId,
        ctx.tenantId,
        'document.expired_on_arrival',
        'document',
        r.id,
        JSON.stringify({ ...finding, queue_item_id: ctx.queueItemId }),
        null
      );
    }
    if (result.expired.length === 0) return result;

    // 3. Tell the QA lane.
    const routing = await resolveAlertRouting(db, {
      tenantId: ctx.tenantId,
      ownerLabel: EXPIRED_ON_ARRIVAL_OWNER_LABEL,
      supplierId: ctx.supplierId,
      documentTypeId: ctx.documentTypeId,
      adminFallback: false,
    });
    const documents = result.expired.map((e) => ({
      title: e.title,
      expires_on: e.finding.expires_on,
      arrived_on: e.finding.arrived_on,
      days_expired: e.finding.days_expired,
    }));

    if (routing.recipients.length === 0) {
      result.via = 'unrouted';
      await logAudit(
        db,
        ctx.actorUserId,
        ctx.tenantId,
        'document.expired_on_arrival.routing_gap',
        'document',
        null,
        JSON.stringify({
          owner_label: EXPIRED_ON_ARRIVAL_OWNER_LABEL,
          document_ids: result.expired.map((e) => e.documentId),
          queue_item_id: ctx.queueItemId,
        }),
        null
      );
      if (!apiKey) return result;
      const admins = await resolveTenantAdmins(db, ctx.tenantId);
      if (admins.length === 0) return result;
      const { subject, html } = buildExpiredOnArrivalEmail({
        tenantName: ctx.tenantName,
        supplierName: ctx.supplierName,
        documents,
        appUrl: ctx.appUrl,
        routingGap: true,
      });
      if (await sendEmail(apiKey, { to: admins.map((a) => a.email), subject, html })) {
        result.notified = admins.map((a) => a.email);
      }
      return result;
    }

    result.via = routing.via;
    if (!apiKey) return result;
    const { subject, html } = buildExpiredOnArrivalEmail({
      tenantName: ctx.tenantName,
      supplierName: ctx.supplierName,
      documents,
      appUrl: ctx.appUrl,
    });
    if (await sendEmail(apiKey, { to: routing.recipients.map((r) => r.email), subject, html })) {
      result.notified = routing.recipients.map((r) => r.email);
    }
    return result;
  } catch (err) {
    console.error(
      '[expired-on-arrival] check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return result;
  }
}
