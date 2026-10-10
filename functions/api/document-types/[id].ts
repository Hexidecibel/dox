import { drainSoon } from '../../lib/search-reindex';
import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { parseRenewalIntervalMonths, parseTypeRenewalWindowSetting } from '../../lib/registry';
import { parseRenewalAlertLeadDays } from '../../../shared/renewalLeadTime';
import {
  defaultSharingRuleForTypeName,
  loosens,
  parseSharingRule,
  type SharingRule,
} from '../../../shared/sharingRule';
import {
  checkDuplicateConcept,
  duplicateConceptResponse,
  slugChangeRefusal,
} from '../../lib/duplicate-concepts';
import type { DuplicateConcept } from '../../../shared/duplicateConcept';
import type { Env, User } from '../../lib/types';

function parseExtractionFields(docType: Record<string, unknown>): void {
  if (docType.extraction_fields && typeof docType.extraction_fields === 'string') {
    try {
      docType.extraction_fields = JSON.parse(docType.extraction_fields as string);
    } catch {
      // leave as-is if invalid JSON
    }
  }
}

/**
 * GET /api/document-types/:id
 * Get a single document type. Must belong to user's tenant (or super_admin).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check
    requireTenantAccess(user, documentType.tenant_id as string);

    parseExtractionFields(documentType as Record<string, unknown>);

    return new Response(
      JSON.stringify({ documentType }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/document-types/:id
 * Update a document type. org_admin+ for own tenant.
 * Fields: name, description, active, and the renewal / sharing settings.
 *
 * A RENAME DOES NOT TOUCH THE SLUG (decision C-154). It used to: every rename
 * re-derived the slug from the new name, so a renamed type stopped being the
 * row a starter-pack update, the classifier's slug match or a saved
 * `?slug=` link was looking for. The slug is set once, at create. Sending a
 * different `slug` is a 400 that says so.
 *
 * Renaming INTO another concept's name (an existing type, or an item or alias
 * of the organisation's starter pack) is refused with 409 `duplicate_concept`;
 * `allow_duplicate: true` overrides, and is audited.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check (org_admin can only update their own tenant's types)
    requireTenantAccess(user, documentType.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      active?: number | boolean;
      supplier_id?: string | null;
      auto_ingest?: number;
      extract_tables?: number;
      renewal_interval_months?: number | null;
      /** 'inherit' | 'period' | 'none' — see migration 0097. */
      renewal_policy?: string | null;
      /** A fixed calendar renewal window (0125, G3); null clears it. */
      renewal_window?: unknown;
      /** 'free' / 'qa' / 'locked' (migration 0137). */
      sharing_rule?: string | null;
      /** Days of renewal-alert warning for this type; null = the organization's setting (0111). */
      renewal_alert_lead_days?: number | null;
      /** Refused unless it is the slug the type already has. */
      slug?: string;
      /** Rename although the new name is another concept's. Audited. */
      allow_duplicate?: boolean;
    };

    const slugRefusal = slugChangeRefusal(body.slug, documentType.slug as string);
    if (slugRefusal) return slugRefusal;
    let duplicateOverride: DuplicateConcept | null = null;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    /** Set when this request actually changes the alert lead time, for its own audit row. */
    let leadTimeChange: { from: number | null; to: number | null } | null = null;
    let sharingRuleChange: { from: SharingRule | null; from_effective: SharingRule; to: SharingRule } | null = null;

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) {
        return new Response(
          JSON.stringify({ error: 'name cannot be empty' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // THE SLUG STAYS. Only a name that actually changes is compared with
      // the other concepts, so re-saving the dialog is never refused.
      if (name !== documentType.name) {
        const dup = await checkDuplicateConcept(context.env.DB, {
          tenantId: documentType.tenant_id as string,
          vocabulary: 'document_types',
          name,
          slug: documentType.slug as string,
          excludeId: docTypeId,
        });
        if (dup) {
          if (body.allow_duplicate !== true) return duplicateConceptResponse(dup);
          duplicateOverride = dup.duplicate;
        }
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.active !== undefined) {
      // Coerce boolean to integer
      if (typeof body.active === 'boolean') {
        body.active = body.active ? 1 : 0;
      }
      if (body.active !== 0 && body.active !== 1) {
        return new Response(
          JSON.stringify({ error: 'active must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('active = ?');
      params.push(body.active);
    }

    if (body.auto_ingest !== undefined) {
      if (body.auto_ingest !== 0 && body.auto_ingest !== 1) {
        return new Response(
          JSON.stringify({ error: 'auto_ingest must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('auto_ingest = ?');
      params.push(body.auto_ingest);
    }

    if (body.extract_tables !== undefined) {
      if (body.extract_tables !== 0 && body.extract_tables !== 1) {
        return new Response(
          JSON.stringify({ error: 'extract_tables must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('extract_tables = ?');
      params.push(body.extract_tables);
    }

    // Renewal setting for documents of this type: the policy (0097) and, under
    // 'period' only, the interval (0096). Written as ONE update because they
    // are one setting with three states — 'inherit' is the annual default,
    // 'none' is "does not renew", and only 'period' gives the months column any
    // meaning. Sending months alone is still valid and means 'period', which is
    // exactly what a pre-0097 client does.
    if (
      body.renewal_interval_months !== undefined ||
      body.renewal_policy !== undefined ||
      body.renewal_window !== undefined
    ) {
      const parsedMonths = parseRenewalIntervalMonths(body.renewal_interval_months ?? null);
      if (!parsedMonths.ok) {
        return new Response(
          JSON.stringify({ error: parsedMonths.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const parsed = parseTypeRenewalWindowSetting(body.renewal_policy, parsedMonths.value, body.renewal_window);
      if (!parsed.ok) {
        return new Response(
          JSON.stringify({ error: parsed.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('renewal_interval_months = ?');
      params.push(parsed.months);
      updates.push('renewal_policy = ?');
      params.push(parsed.policy);
      // The window (0125) is written only when it changes state: a window
      // object sets it, null or a non-'period' policy clears it, and a PUT
      // that says nothing about it under 'period' leaves it alone.
      if (parsed.window !== undefined) {
        updates.push('renewal_window = ?');
        params.push(parsed.window === null ? null : JSON.stringify(parsed.window));
      }
    }

    // The sharing rule (migration 0137, decision C-003): may documents of this
    // type leave. Audited on its own, and only when the value CHANGES -- this
    // setting decides what an API key can read and what a reader can ZIP, so
    // "who loosened it and when" has to be one query.
    //
    // A type is never set back to "not stored": null is refused. The stored
    // value is the point -- it is what the Document Types screen shows.
    if (body.sharing_rule !== undefined) {
      const parsedRule = parseSharingRule(body.sharing_rule);
      if (!parsedRule) {
        return new Response(
          JSON.stringify({ error: 'sharing_rule must be one of: free, qa, locked' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const stored = parseSharingRule(documentType.sharing_rule);
      const effective = stored ?? defaultSharingRuleForTypeName(documentType.name as string);
      // AN API KEY NEVER LOOSENS A RULE, whoever owns it (C-041). A key reads
      // "send freely" documents only; a key that could first relabel a whole
      // type as "send freely" would read anything. Tightening is allowed.
      if (context.data.authMethod === 'api_key' && loosens(effective, parsedRule)) {
        return new Response(
          JSON.stringify({
            error: 'An API key cannot loosen a sharing rule; a person has to.',
            code: 'sharing_rule_change_refused',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (stored !== parsedRule) {
        sharingRuleChange = { from: stored, from_effective: effective, to: parsedRule };
        updates.push('sharing_rule = ?');
        params.push(parsedRule);
      }
    } else if (
      body.name !== undefined &&
      parseSharingRule(documentType.sharing_rule) === null &&
      defaultSharingRuleForTypeName(sanitizeString(body.name)) !==
        defaultSharingRuleForTypeName(documentType.name as string)
    ) {
      // A RENAME MUST NOT MOVE THE RULE. A type that predates 0137 has no
      // stored rule and is read from its NAME, so renaming "Vendor Form" to
      // "Certificate of Analysis" would have re-read every document of the
      // type as "send freely" without anybody deciding that. The rule the type
      // was read as until now is written down first; changing it is its own,
      // audited, edit of `sharing_rule`.
      const pinned = defaultSharingRuleForTypeName(documentType.name as string);
      sharingRuleChange = { from: null, from_effective: pinned, to: pinned };
      updates.push('sharing_rule = ?');
      params.push(pinned);
    }

    // Renewal alert lead time override (migration 0111). Stamped and audited
    // on its own only when the value CHANGES, so re-saving the dialog does
    // not leave a trail of no-op "changes" to a setting that decides when
    // suppliers get chased.
    if (body.renewal_alert_lead_days !== undefined) {
      const parsedLead = parseRenewalAlertLeadDays(body.renewal_alert_lead_days);
      if (!parsedLead.ok) {
        return new Response(
          JSON.stringify({ error: parsedLead.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const previous = (documentType.renewal_alert_lead_days as number | null | undefined) ?? null;
      if (previous !== parsedLead.value) {
        leadTimeChange = { from: previous, to: parsedLead.value };
        updates.push('renewal_alert_lead_days = ?');
        params.push(parsedLead.value);
        updates.push("renewal_alert_lead_updated_at = datetime('now')");
        updates.push('renewal_alert_lead_updated_by = ?');
        params.push(user.id);
      }
    }

    // supplier_id: present in body sets ownership; null/"" clears to global.
    if (body.supplier_id !== undefined) {
      const supplierId = body.supplier_id ? body.supplier_id : null;
      if (supplierId) {
        const supplier = await context.env.DB.prepare(
          'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?'
        )
          .bind(supplierId, documentType.tenant_id)
          .first();
        if (!supplier) {
          return new Response(
            JSON.stringify({ error: 'supplier_id does not reference a supplier in this tenant' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      updates.push('supplier_id = ?');
      params.push(supplierId);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(docTypeId);

    await context.env.DB.prepare(
      `UPDATE document_types SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      documentType.tenant_id as string,
      'document_type_updated',
      'document_type',
      docTypeId,
      JSON.stringify({
        changes: body,
        ...(body.renewal_window !== undefined || body.renewal_policy !== undefined
          ? { previous_renewal_window: documentType.renewal_window ?? null }
          : {}),
        ...(body.name !== undefined && body.name !== documentType.name
          ? { previous_name: documentType.name, slug_unchanged: documentType.slug }
          : {}),
        ...(duplicateOverride ? { duplicate_override: duplicateOverride } : {}),
      }),
      getClientIp(context.request)
    );

    if (sharingRuleChange) {
      await logAudit(
        context.env.DB,
        user.id,
        documentType.tenant_id as string,
        'document_type.sharing_rule_updated',
        'document_type',
        docTypeId,
        JSON.stringify({
          sharing_rule: sharingRuleChange.to,
          previous_sharing_rule: sharingRuleChange.from,
          previous_effective_rule: sharingRuleChange.from_effective,
          ...(sharingRuleChange.to === sharingRuleChange.from_effective
            ? { note: 'Pinned on rename: the rule this type was read as from its old name.' }
            : {}),
        }),
        getClientIp(context.request)
      );
    }

    if (leadTimeChange) {
      await logAudit(
        context.env.DB,
        user.id,
        documentType.tenant_id as string,
        'document_type.renewal_alert_lead_time_updated',
        'document_type',
        docTypeId,
        JSON.stringify({
          renewal_alert_lead_days: leadTimeChange.to,
          previous_renewal_alert_lead_days: leadTimeChange.from,
        }),
        getClientIp(context.request)
      );
    }

    const updated = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (updated) {
      parseExtractionFields(updated as Record<string, unknown>);
    }

    drainSoon(context, context.env.DB);
    return new Response(
      JSON.stringify({ documentType: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/document-types/:id
 * Soft-delete a document type (set active=0). org_admin+ for own tenant.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check
    requireTenantAccess(user, documentType.tenant_id as string);

    // Soft-delete
    await context.env.DB.prepare(
      "UPDATE document_types SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(docTypeId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      documentType.tenant_id as string,
      'document_type_deleted',
      'document_type',
      docTypeId,
      JSON.stringify({ name: documentType.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
