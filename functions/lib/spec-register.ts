/**
 * Writing spec verdicts down, and telling the right person when one fails.
 *
 * The review-time warning (`spec-warnings.ts`) is where an out-of-spec result
 * gets CAUGHT. This module is where it becomes a record: what was judged, which
 * limit it was judged against, who approved it anyway, and who was told.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. RECOMPUTE, NEVER TRUST THE CLIENT. Verdicts are derived server-side from
 *     the values the reviewer actually submitted. A browser must not be able to
 *     post "in_spec" for a 40 CFU/g coliform.
 *  2. FREEZE THE LIMIT. Each row stores the numbers it was judged against, so
 *     tightening a threshold next month cannot silently rewrite what happened
 *     this month.
 *  3. ONE EMAIL PER DOCUMENT. A twelve-record COA with a failing analyte in each
 *     is one event, not twelve. Alert fatigue is how a safety signal stops being
 *     read at all.
 *
 * NEVER BLOCKS, NEVER THROWS UPWARD. Registering a result and notifying about it
 * are strictly best-effort: an approval that already succeeded must not fail
 * because an email bounced.
 */

import { generateId } from './db';
import { sendEmail, buildSpecAlertEmail } from './email';
import { mintAlertLink, alertLinkUrl } from './alert-links';
import { resolveAlertRouting } from './alert-routing';
import { isModuleEnabledForTenant } from './module-access';
import { MODULES } from '../../shared/modules';
import type { AlertRecipient } from './alert-routing';
import type { SpecVerdict } from '../../shared/specCheck';
import type { ConfiguredLimit } from '../../shared/specCheck';
import { buildLimitSnapshot } from '../../shared/specSnapshot';
import { compareSpecCriticality } from '../../shared/specCriticality';

export interface RegisterContext {
  tenantId: string;
  documentId: string;
  versionNumber?: number | null;
  queueItemId?: string | null;
  /** Set when a reviewer approved a document that already carried a failure. */
  acknowledgedBy?: string | null;
  acknowledgementNote?: string | null;
}

/**
 * The frozen copy of a limit stored alongside a verdict now lives in
 * shared/specSnapshot.ts, because `bin/backfill-spec-register` writes register
 * rows too and a backfilled row has to freeze the limit on exactly the same
 * terms as an approval-written one. See that file for the argument about unit
 * equivalence (0093) and criticality (0095) belonging inside the snapshot.
 */

/**
 * Persist a document's spec verdicts. Returns the rows written, so the caller
 * can pass the failures straight to `notifySpecFailures` without re-reading.
 *
 * Existing rows for this document+version are cleared first: re-approving or
 * re-checking a document replaces its results rather than accumulating
 * duplicates that would each look like a separate event.
 */
export async function registerSpecChecks(
  db: D1Database,
  ctx: RegisterContext,
  verdicts: SpecVerdict[],
  limits: ConfiguredLimit[]
): Promise<{ written: number; failures: SpecVerdict[] }> {
  const failures = verdicts.filter((v) => v.verdict === 'out_of_spec');
  if (verdicts.length === 0) return { written: 0, failures };

  try {
    await db
      .prepare(
        `DELETE FROM document_spec_checks
          WHERE document_id = ?
            AND (version_number IS ? OR version_number = ?)`
      )
      .bind(ctx.documentId, ctx.versionNumber ?? null, ctx.versionNumber ?? -1)
      .run();

    // `judgement_origin` is the literal 'approval' and not a parameter (0103).
    // This function IS the approval-time writer: it is reached from the queue
    // approval route with a reviewer's id in hand. The other producer of
    // register rows, `bin/backfill-spec-register`, is a Node CLI that renders
    // its own SQL and stamps 'bulk_recheck' + `bulk_run_at` itself, so an
    // origin parameter here would be a setting nobody could ever pass. Anything
    // that DID pass it would be claiming a human judgement it did not make.
    const stmt = db.prepare(
      `INSERT INTO document_spec_checks
         (id, tenant_id, document_id, version_number, queue_item_id,
          spec_test_id, test_name_raw, value_raw, value_num, unit_raw,
          verdict, reason, source, limit_id, limit_snapshot,
          acknowledged_by, acknowledged_at, acknowledgement_note,
          judgement_origin, bulk_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval', NULL)`
    );

    // An approval that goes ahead over a failing result IS the acknowledgement.
    // Recording it here is what makes "a human saw this and accepted it"
    // answerable later, which is the difference between a warning and an audit
    // trail.
    const ackAt = ctx.acknowledgedBy ? new Date().toISOString() : null;

    const batch = verdicts.map((v) =>
      stmt.bind(
        generateId(),
        ctx.tenantId,
        ctx.documentId,
        ctx.versionNumber ?? null,
        ctx.queueItemId ?? null,
        v.spec_test_id ?? null,
        v.test_name_raw,
        v.value_raw ?? null,
        v.value_num ?? null,
        v.unit_raw ?? null,
        v.verdict,
        v.reason ?? null,
        v.source,
        v.limit_id ?? null,
        buildLimitSnapshot(v, limits),
        v.verdict === 'out_of_spec' ? ctx.acknowledgedBy ?? null : null,
        v.verdict === 'out_of_spec' ? ackAt : null,
        v.verdict === 'out_of_spec' ? ctx.acknowledgementNote ?? null : null
      )
    );

    await db.batch(batch);
    return { written: batch.length, failures };
  } catch (err) {
    console.error(
      '[spec-register] writing spec checks failed:',
      err instanceof Error ? err.message : String(err)
    );
    return { written: 0, failures };
  }
}

export type { AlertRecipient } from './alert-routing';

/**
 * Who hears about an out-of-spec result on this (supplier, document type).
 *
 * THIN SHIM as of migration 0091. The ladder now lives in
 * `functions/lib/alert-routing.ts` and is shared with the renewal path, so
 * there is one answer to "who owns this record" instead of two.
 *
 * `adminFallback: true` is passed DELIBERATELY and is the one place the spec
 * path differs from the renewal path. An out-of-spec analytical result is a
 * one-shot food-safety event: if nobody is assigned, telling the tenant's
 * org_admins is better than telling nobody. The renewal digest makes the
 * opposite call, because it runs every day and the admin pool would be the
 * standing recipient of everything — see alert-routing.ts for the full
 * argument.
 *
 * `ownerLabel` is optional and threads `documents.owner` in where the caller
 * has it, so a record that names its own owner routes there first.
 */
export async function resolveAlertRecipients(
  db: D1Database,
  tenantId: string,
  supplierId: string | null,
  documentTypeId: string | null,
  ownerLabel?: string | null
): Promise<AlertRecipient[]> {
  const { recipients } = await resolveAlertRouting(db, {
    tenantId,
    ownerLabel: ownerLabel ?? null,
    supplierId,
    documentTypeId,
    adminFallback: true,
  });
  return recipients;
}

export interface NotifyContext {
  tenantId: string;
  tenantName: string;
  documentId: string;
  documentTitle: string;
  supplierId: string | null;
  supplierName: string | null;
  documentTypeId: string | null;
  /** documents.owner, when the caller has it. Routes ahead of `assignments`. */
  ownerLabel?: string | null;
  appUrl?: string;
}

/**
 * Send ONE email per document listing every failing result, to the people who
 * own that queue. Returns how many recipients were mailed.
 *
 * Silently does nothing when email is not configured — a tenant without Resend
 * still gets the in-app register and the review-queue banner, which are the
 * parts that cannot be missed.
 */
export async function notifySpecFailures(
  db: D1Database,
  apiKey: string | undefined,
  ctx: NotifyContext,
  failures: SpecVerdict[]
): Promise<number> {
  if (failures.length === 0) return 0;
  if (!apiKey) return 0;

  // MODULE FILTER — compute and store, but do not send.
  //
  // The register is EVIDENCE attached to a document: what was judged, against
  // which limit, and who approved it anyway. That has to be written whatever a
  // tenant has switched on, or turning a module off would quietly create a gap
  // in a compliance record. `registerSpecChecks` has already run by the time
  // anything reaches here, and it is not gated.
  //
  // The EMAIL is the part a tenant switched off. Approvals happen on machine
  // paths with no signed-in caller (an ingest, a queue approval), so the
  // middleware gate cannot reach this send — the check has to be here. Fails
  // OPEN, like every other module read: a safety alert is not the thing to
  // drop because a lookup failed.
  if (!(await isModuleEnabledForTenant(db, ctx.tenantId, MODULES.compliance.key))) {
    return 0;
  }

  try {
    const recipients = await resolveAlertRecipients(
      db,
      ctx.tenantId,
      ctx.supplierId,
      ctx.documentTypeId,
      ctx.ownerLabel ?? null
    );
    if (recipients.length === 0) return 0;

    // A fresh, expiring, token-gated landing page per alert. Best-effort: if
    // minting fails the email still goes out, just without the no-login link.
    // A new link every time so an old forwarded one never widens its scope.
    const alertToken = await mintAlertLink(db, {
      tenantId: ctx.tenantId,
      kind: 'spec_alert',
      documentId: ctx.documentId,
    });

    // Critical parameters first inside the one email. Nothing is dropped and
    // nothing is added — a tracked deviation still gets listed — but a reader
    // skimming on a phone sees the load-stopping analyte before the four
    // parameters the plant tracks and rarely acts on. Ordering is the only
    // lever criticality is allowed to pull here; WHICH failures are reported
    // stays exactly what the engine judged.
    const ranked = [...failures].sort((a, b) =>
      compareSpecCriticality(a.criticality, b.criticality)
    );

    const { subject, html } = buildSpecAlertEmail({
      tenantName: ctx.tenantName,
      documentTitle: ctx.documentTitle,
      documentId: ctx.documentId,
      supplierName: ctx.supplierName,
      failures: ranked.map((f) => ({
        test: f.test_name_raw,
        value: f.value_raw,
        limit: f.limit_text,
        source: f.source,
      })),
      appUrl: ctx.appUrl,
      alertUrl: alertLinkUrl(ctx.appUrl, alertToken),
    });

    // One send, all recipients — never one email per failure.
    await sendEmail(apiKey, {
      to: recipients.map((r) => r.email),
      subject,
      html,
    });

    await db
      .prepare(
        `UPDATE document_spec_checks
            SET notified_at = datetime('now')
          WHERE document_id = ? AND verdict = 'out_of_spec' AND notified_at IS NULL`
      )
      .bind(ctx.documentId)
      .run();

    return recipients.length;
  } catch (err) {
    console.error(
      '[spec-register] notifying spec failures failed:',
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}

/**
 * Register + notify for one approved COA, in the one place where the mapping
 * from a verdict to a document is exact.
 *
 * A records-mode COA becomes N documents, one per approved record, and a
 * verdict addressed to `record[3]` belongs to the document produced from record
 * 3 — not to "the first document", which is the kind of shortcut that files a
 * failing lot's result against a clean lot. `documentsByRecord` carries that
 * mapping from the producer's own result, so no guessing is involved.
 *
 * Verdicts whose record has no document (held or rejected records) are dropped:
 * nothing was filed, so there is nothing to file a result against.
 *
 * Entirely best-effort. The approval has already happened and must stand.
 */
export async function registerAndNotifyForApproval(
  db: D1Database,
  apiKey: string | undefined,
  base: {
    tenantId: string;
    tenantName: string;
    queueItemId: string;
    supplierId: string | null;
    supplierName: string | null;
    documentTypeId: string | null;
    approvedBy: string;
    appUrl?: string;
  },
  verdicts: SpecVerdict[],
  limits: ConfiguredLimit[],
  documentsByRecord: Array<{ documentId: string; title: string; recordIndex: number | null }>
): Promise<void> {
  if (verdicts.length === 0 || documentsByRecord.length === 0) return;

  try {
    // 'ai_fields' verdicts come from the flat path, which produces exactly one
    // document; records-mode verdicts carry their record index in the scope.
    const byRecord = new Map<number | null, typeof documentsByRecord>();
    for (const d of documentsByRecord) {
      const list = byRecord.get(d.recordIndex) ?? [];
      list.push(d);
      byRecord.set(d.recordIndex, list);
    }
    const flatTarget = documentsByRecord.length === 1 ? documentsByRecord[0] : null;

    const grouped = new Map<string, { doc: (typeof documentsByRecord)[number]; verdicts: SpecVerdict[] }>();
    for (const v of verdicts) {
      const m = /^record\[(\d+)\]$/.exec(v.scope);
      const target = m ? (byRecord.get(Number(m[1])) ?? [])[0] : flatTarget;
      if (!target) continue;
      const entry = grouped.get(target.documentId) ?? { doc: target, verdicts: [] };
      entry.verdicts.push(v);
      grouped.set(target.documentId, entry);
    }

    for (const { doc, verdicts: docVerdicts } of grouped.values()) {
      const { failures } = await registerSpecChecks(
        db,
        {
          tenantId: base.tenantId,
          documentId: doc.documentId,
          versionNumber: 1,
          queueItemId: base.queueItemId,
          // The reviewer approved with these failures in front of them, so the
          // approval itself is the acknowledgement.
          acknowledgedBy: base.approvedBy,
          acknowledgementNote: 'Approved from the review queue with this result showing.',
        },
        docVerdicts,
        limits
      );

      await notifySpecFailures(db, apiKey, {
        tenantId: base.tenantId,
        tenantName: base.tenantName,
        documentId: doc.documentId,
        documentTitle: doc.title,
        supplierId: base.supplierId,
        supplierName: base.supplierName,
        documentTypeId: base.documentTypeId,
        appUrl: base.appUrl,
      }, failures);
    }
  } catch (err) {
    console.error(
      '[spec-register] register/notify for approval failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}
