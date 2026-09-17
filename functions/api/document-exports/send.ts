/**
 * POST /api/document-exports/send
 *
 * Mail the selected documents to somebody — the "on behalf of" path.
 *
 * WHY IT IS A LINK AND NOT ATTACHMENTS. Attachments blow mail size limits the
 * moment a dozen certificates are selected, and once one is in an inbox nobody
 * can say whether it was opened and nobody can withdraw it. What goes out is a
 * list of what was sent plus ONE token-gated link (migration 0115) that
 * expires, can be revoked, and writes an audit row every time it is opened.
 *
 * NOBODY IS IMPERSONATED. The mail comes from the portal's own sender with a
 * REPLY-TO of the person who pressed send. `on_behalf_of` is free text printed
 * as context ("Sent by Dana on behalf of Marco in Sales"), never a from
 * address: sending as a customer's domain is impersonation and fails their SPF
 * besides.
 *
 * THE LINK IS MINTED BEFORE THE SEND AND REVOKED IF THE SEND FAILS, so there
 * is never a live unauthenticated link to documents nobody was told about.
 *
 * WHY THIS ONE TAKES A ROLE CHECK AND THE ZIP DOES NOT. Downloading a ZIP is
 * the same act a `reader` can already perform one file at a time, so ./zip.ts
 * deliberately has no role gate. SENDING is a different act: it mints an
 * unauthenticated URL to as many as 50 documents, mails it to as many as 10
 * addresses outside the organization, and may be repeated 30 times an hour.
 * That is publishing, not reading, and the read-only role is named for what it
 * is. `user` and above, matching every other outbound surface.
 */
import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  errorToResponse,
  BadRequestError,
} from '../../lib/permissions';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit';
import { validateEmail } from '../../lib/validation';
import { sendEmail, buildDocumentExportEmail } from '../../lib/email';
import {
  EXPORT_MAX_DOCUMENTS,
  EXPORT_MAX_RECIPIENTS,
  EXPORT_LINK_TTL_DAYS,
  exportLinkUrl,
  exportSizeRefusal,
  loadExportDocuments,
  mintExportLink,
  normalizeExportIds,
  revokeExportLink,
} from '../../lib/document-export';
import type { DocumentExportSendResponse } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

/**
 * Sends per user per hour. Generous for the job (AJ answers document requests
 * for one to three hours a day) and tight enough that a compromised session
 * cannot mail a customer list. Keyed on the USER, not the IP: the abuse this
 * guards against is an account, and one office shares an IP.
 */
const SEND_RATE_LIMIT_PER_HOUR = 30;
const SEND_RATE_WINDOW_SECONDS = 60 * 60;

/** A message longer than this is a document, not a covering note. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_ON_BEHALF_CHARS = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeRecipients(raw: unknown): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,;\s]+/)
      : [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const addr = v.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (validateEmail(addr)) ok.push(addr);
    else bad.push(addr);
  }
  return { ok, bad };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    // See the module header: a reader may take documents out for themselves,
    // not publish them to addresses outside the organization.
    requireRole(user, 'super_admin', 'org_admin', 'user');
    const body = (await context.request.json()) as {
      document_ids?: unknown;
      recipients?: unknown;
      on_behalf_of?: unknown;
      message?: unknown;
      tenant_id?: unknown;
    };

    const ids = normalizeExportIds(body.document_ids);
    if (ids.length === 0) throw new BadRequestError('Select at least one document to send.');
    if (ids.length > EXPORT_MAX_DOCUMENTS) {
      return json(
        {
          error:
            `One export covers at most ${EXPORT_MAX_DOCUMENTS} documents, and ` +
            `this selection is larger. Send it in smaller batches.`,
          code: 'export_too_many_documents',
          limit: EXPORT_MAX_DOCUMENTS,
        },
        413,
      );
    }

    const { ok: recipients, bad } = normalizeRecipients(body.recipients);
    if (bad.length > 0) {
      throw new BadRequestError(`Not a valid email address: ${bad.join(', ')}`);
    }
    if (recipients.length === 0) throw new BadRequestError('Enter at least one recipient.');
    if (recipients.length > EXPORT_MAX_RECIPIENTS) {
      throw new BadRequestError(
        `One send reaches at most ${EXPORT_MAX_RECIPIENTS} addresses.`,
      );
    }

    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim().slice(0, MAX_MESSAGE_CHARS)
        : null;
    const onBehalfOf =
      typeof body.on_behalf_of === 'string' && body.on_behalf_of.trim()
        ? body.on_behalf_of.trim().slice(0, MAX_ON_BEHALF_CHARS)
        : null;

    const tenantId =
      typeof body.tenant_id === 'string' && body.tenant_id ? body.tenant_id : user.tenant_id;
    if (!tenantId) throw new BadRequestError('No organization selected for this export.');
    requireTenantAccess(user, tenantId);

    const rlKey = `document_export_send:${user.id}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      SEND_RATE_LIMIT_PER_HOUR,
      SEND_RATE_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return json(
        {
          error:
            `That is ${SEND_RATE_LIMIT_PER_HOUR} sends in an hour, which is the limit. ` +
            `Try again a little later.`,
          code: 'rate_limited',
        },
        429,
      );
    }
    await recordAttempt(context.env.DB, rlKey, SEND_RATE_WINDOW_SECONDS);

    const { rows, missing_ids } = await loadExportDocuments(context.env.DB, tenantId, ids);
    if (rows.length === 0) {
      return json({ error: 'None of those documents are available to send.' }, 404);
    }

    // The same ceiling as the direct download, checked HERE rather than when
    // the recipient clicks: an email promising files that refuse to assemble
    // is worse than a refusal the sender can act on.
    const refusal = exportSizeRefusal(rows);
    if (refusal) return json({ error: refusal, code: 'export_too_large' }, 413);

    if (!context.env.RESEND_API_KEY) {
      return json(
        {
          error:
            'Email is not configured for this portal, so nothing was sent. ' +
            'Download the ZIP instead, or ask an administrator to set up email.',
          code: 'email_not_configured',
        },
        503,
      );
    }

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ name: string }>();

    const link = await mintExportLink(context.env.DB, {
      tenantId,
      documentIds: rows.map((r) => r.document_id),
      createdBy: user.id,
      recipients,
      onBehalfOf,
      message,
      ttlDays: EXPORT_LINK_TTL_DAYS,
    });

    const url = new URL(context.request.url);
    const linkUrl = exportLinkUrl(url.origin, link.token);
    const email = buildDocumentExportEmail({
      tenantName: tenant?.name ?? 'Documents',
      senderName: user.name || user.email,
      senderEmail: user.email,
      onBehalfOf,
      message,
      documents: rows.map((r) => ({
        title: r.title,
        supplier_name: r.supplier_name,
        document_type_name: r.document_type_name,
        lot_label: r.lot_label,
      })),
      linkUrl: linkUrl ?? '',
      expiresAt: link.expires_at,
    });

    const sent = await sendEmail(context.env.RESEND_API_KEY, {
      to: recipients,
      subject: email.subject,
      html: email.html,
      // The portal sends it; the human who pressed send answers for it.
      replyTo: user.email,
    });

    if (!sent) {
      await revokeExportLink(context.env.DB, link.id);
      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'document_export.send_failed',
        'document_export_link',
        link.id,
        JSON.stringify({ recipients, document_ids: rows.map((r) => r.document_id) }),
        getClientIp(context.request),
      );
      return json(
        { error: 'The email could not be sent. Nothing was shared.', code: 'email_send_failed' },
        502,
      );
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_export.sent',
      'document_export_link',
      link.id,
      JSON.stringify({
        recipients,
        on_behalf_of: onBehalfOf,
        document_ids: rows.map((r) => r.document_id),
        document_count: rows.length,
        requested_ids: ids,
        missing_ids,
        expires_at: link.expires_at,
      }),
      getClientIp(context.request),
    );

    const response: DocumentExportSendResponse = {
      sent: true,
      recipients,
      document_count: rows.length,
      missing_ids,
      expires_at: link.expires_at,
    };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Document export send error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
