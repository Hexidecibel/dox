import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { computeDiff } from '../../lib/diff';
import { findOrCreateSupplier } from '../../lib/suppliers';
import {
  validateCategoryIds,
  resolvePrimaryCategoryId,
  syncDocumentCategories,
  parseFacetLinks,
  validateDocumentFacets,
  syncDocumentFacets,
  listDocumentFacet,
  isValidRenewalType,
} from '../../lib/registry';
import type { DocumentFacetInput } from '../../lib/registry';
import { applyDocumentTypeRequirementDefaults } from '../../lib/requirement-defaults';
import { recordClassification } from '../../lib/classification';
import {
  describeDocumentSharing,
  auditRuleChange,
  planDocumentRuleChange,
  ruleChangeActor,
  type DocumentRuleChange,
} from '../../lib/sharing-rule';
import { documentHoldState } from '../../lib/holds';
import type { Env, User, Document } from '../../lib/types';
import type { RenewalType } from '../../../shared/types';
import {
  normalizeRenewalDate,
  postApprovalRenewalEdit,
  type PostApprovalRenewalEdit,
} from '../../lib/renewal-proposal';

/**
 * GET /api/documents/:id
 * Get a single document with its current version info.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    const doc = await context.env.DB.prepare(
      `SELECT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name, t.slug as tenant_slug,
              dt.name as document_type_name, dt.slug as document_type_slug,
              s.name as supplier_name
       FROM documents d
       LEFT JOIN users u ON d.created_by = u.id
       LEFT JOIN tenants t ON d.tenant_id = t.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       LEFT JOIN suppliers s ON d.supplier_id = s.id
       WHERE d.id = ? AND d.status != 'deleted'`
    )
      .bind(docId)
      .first();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id as string);

    // Full multi-category set (migration 0076), primary first. Attached to the
    // document so the registry editor can render + edit every mapping.
    const categories = await context.env.DB.prepare(
      `SELECT dc.id, dc.document_id, dc.document_type_id, dc.is_primary, dc.created_at,
              dt.name AS document_type_name, dt.slug AS document_type_slug
       FROM document_categories dc
       JOIN document_types dt ON dt.id = dc.document_type_id
       WHERE dc.document_id = ?
       ORDER BY dc.is_primary DESC, dt.name ASC`
    )
      .bind(docId)
      .all();
    (doc as Record<string, unknown>).categories = categories.results;

    // Registry facets (migration 0080): what this document SATISFIES (layer 2)
    // and what it TRIGGERS (layer 3), vocabulary joined in.
    (doc as Record<string, unknown>).requirements = await listDocumentFacet(
      context.env.DB,
      'requirement',
      docId,
    );
    (doc as Record<string, unknown>).claims = await listDocumentFacet(
      context.env.DB,
      'claim',
      docId,
    );

    // The sharing rule in force (migration 0137): may this document leave,
    // where the answer comes from, and whether this caller may change it.
    (doc as Record<string, unknown>).sharing = await describeDocumentSharing(
      context.env.DB,
      user,
      doc.tenant_id as string,
      docId,
    );

    // Active holds (migration 0139): is this certificate on hold, on which lot
    // rows, and may this caller place or release one.
    (doc as Record<string, unknown>).holds = await documentHoldState(
      context.env.DB,
      context.data,
      user,
      doc.tenant_id as string,
      docId,
    );

    // Get current version info if one exists
    let currentVersion = null;
    if ((doc.current_version as number) > 0) {
      currentVersion = await context.env.DB.prepare(
        `SELECT dv.*, u.name as uploader_name
         FROM document_versions dv
         LEFT JOIN users u ON dv.uploaded_by = u.id
         WHERE dv.document_id = ? AND dv.version_number = ?`
      )
        .bind(docId, doc.current_version)
        .first();
    }

    // Get linked products with expiration info
    const linkedProducts = await context.env.DB.prepare(
      `SELECT dp.*, p.name as product_name, p.slug as product_slug
       FROM document_products dp
       INNER JOIN products p ON dp.product_id = p.id
       WHERE dp.document_id = ?
       ORDER BY p.name ASC`
    )
      .bind(docId)
      .all();

    // Linked lots (Option B sublot split): a COA may link to N lots, one per
    // sublot. Surface lot_number / sub_lot_code / lot_key so the detail page can
    // show the combined match key (e.g. "lot 10426110 · sublot 05 → 1042611005").
    const linkedLots = await context.env.DB.prepare(
      `SELECT l.id, l.lot_number, l.sub_lot_code, l.lot_key,
              p.name AS product_name, s.name AS supplier_name
       FROM document_lots dl
       INNER JOIN lots l ON dl.lot_id = l.id
       LEFT JOIN products p ON l.product_id = p.id
       LEFT JOIN suppliers s ON l.supplier_id = s.id
       WHERE dl.document_id = ?
       ORDER BY l.lot_number ASC, l.sub_lot_code ASC`
    )
      .bind(docId)
      .all();

    return new Response(
      JSON.stringify({
        document: doc,
        currentVersion,
        products: linkedProducts.results,
        lots: linkedLots.results,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/documents/:id
 * Update document metadata (title, description, category, tags, status).
 * Requires user (own tenant) or admin.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    const body = (await context.request.json()) as {
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      status?: 'active' | 'archived';
      document_type_id?: string | null;
      supplier_id?: string | null;
      /**
       * Optional human-typed supplier name. When provided and `supplier_id` is
       * NOT, it is resolved (and created if needed) via the alias-aware helper
       * and the resulting id is applied to supplier_id. Lets the frontend send
       * either a chosen id or a free-typed name.
       */
      supplier_name?: string;
      primary_metadata?: Record<string, string | null> | null;
      extended_metadata?: Record<string, string | null> | null;
      // IDP Document Registry fields (migrations 0076/0077).
      categories?: string[];
      primary_category_id?: string | null;
      // Registry facets (migration 0080). Accept bare ids or full link objects.
      requirements?: unknown[];
      claims?: unknown[];
      aliases?: string[];
      criteria?: string[];
      applies_to?: string[];
      owner?: string | null;
      renewal_type?: RenewalType | null;
      renewal_interval_months?: number | null;
      renewal_due_date?: string | null;
      /**
       * Why the renewal date is being changed after approval (D-041). The
       * screen requires it; the API records it when given and does not refuse
       * its absence -- the spec-rationale precedent: a write that is refused
       * for a missing sentence is worse than one whose reason reads "none
       * recorded".
       */
      renewal_reason?: string | null;
      /**
       * This document's own sharing rule (migration 0137): 'free' / 'qa' /
       * 'locked', or null to go back to its type's rule. An admin or a QA
       * releaser only, and `sharing_rule_reason` is REQUIRED when it changes.
       */
      sharing_rule_override?: string | null;
      sharing_rule_reason?: string | null;
    };

    // A renewal date edited HERE is a decision made after approval, and is
    // recorded as one (see `postApprovalRenewalEdit`). Only a real change
    // counts: the registry editor sends the field on every save.
    let renewalEdit: PostApprovalRenewalEdit | null = null;
    if (body.renewal_due_date !== undefined) {
      const stored = doc as unknown as { renewal_due_date: string | null; renewal_snapshot: string | null };
      const next = normalizeRenewalDate(body.renewal_due_date);
      if (next === undefined) {
        return new Response(
          JSON.stringify({ error: 'renewal_due_date must be a date (YYYY-MM-DD) or null' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      body.renewal_due_date = next;
      const previous = normalizeRenewalDate(stored.renewal_due_date) ?? null;
      if (next !== previous) {
        renewalEdit = postApprovalRenewalEdit({
          previous,
          next,
          reason: body.renewal_reason,
          snapshot: stored.renewal_snapshot,
          userId: user.id,
        });
      }
    }

    // Validate renewal_type up front against the CHECK set.
    if (
      body.renewal_type !== undefined &&
      body.renewal_type !== null &&
      !isValidRenewalType(body.renewal_type)
    ) {
      return new Response(
        JSON.stringify({
          error:
            'renewal_type must be one of: renewal_application, hard_expiry, keep_current, review_cycle',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // When a category set is provided it REPLACES the doc's mappings and its
    // primary becomes document_type_id. Validate tenant ownership first.
    let primaryCatId: string | null | undefined;
    if (body.categories !== undefined) {
      await validateCategoryIds(context.env.DB, doc.tenant_id, body.categories);
      primaryCatId = resolvePrimaryCategoryId(body.categories, body.primary_category_id);
    }

    // THE SHARING RULE, decided before anything is written (migration 0137).
    //
    // Three fields of this request can move a document's effective rule: its
    // override, its `document_type_id`, and its `categories` (whose primary
    // becomes the type). All three go through ONE decision, which computes the
    // rule before and after the whole edit: tightening is open to whoever may
    // edit the document; LOOSENING needs an administrator (off "locked") or a
    // QA releaser ("needs QA" to "send freely"), and is never done by an API
    // key. Without this, re-typing a W-9 as a certificate of analysis was a
    // way to walk it out. The type must also be this organization's own.
    //
    // A refused change refuses the WHOLE request: nothing half-applied.
    const requestedTypeId: string | null | undefined =
      body.categories !== undefined
        ? (primaryCatId ?? null)
        : body.document_type_id !== undefined
          ? (body.document_type_id || null)
          : undefined;
    let ruleChange: DocumentRuleChange | null = null;
    if (requestedTypeId !== undefined || body.sharing_rule_override !== undefined) {
      const plan = await planDocumentRuleChange(
        context.env.DB,
        ruleChangeActor(context.data, user),
        doc.tenant_id,
        docId,
        {
          documentTypeId: requestedTypeId,
          override: body.sharing_rule_override,
          reason: body.sharing_rule_reason,
        },
      );
      if (!plan.ok) {
        return new Response(JSON.stringify({ error: plan.error, ...(plan.code ? { code: plan.code } : {}) }), {
          status: plan.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      ruleChange = plan;
    }
    const sharingChange = ruleChange?.override ?? null;

    // Registry facet link sets. An omitted key leaves the document's existing
    // links alone; a supplied array (including []) REPLACES that facet's set.
    const facetInput: DocumentFacetInput = {
      requirements:
        body.requirements !== undefined
          ? parseFacetLinks(body.requirements, 'requirements')
          : undefined,
      claims: body.claims !== undefined ? parseFacetLinks(body.claims, 'claims') : undefined,
    };
    const hasFacetWrite = facetInput.requirements !== undefined || facetInput.claims !== undefined;
    await validateDocumentFacets(context.env.DB, doc.tenant_id, facetInput);

    // Resolve a typed supplier name into a supplier_id when no explicit id was
    // given. Mutates the local body so the existing supplier_id update + audit
    // diff logic below picks it up unchanged.
    if (body.supplier_id === undefined && body.supplier_name && body.supplier_name.trim()) {
      try {
        const r = await findOrCreateSupplier(context.env.DB, doc.tenant_id, body.supplier_name, {
          userId: user.id,
          ip: getClientIp(context.request),
        });
        body.supplier_id = r.id;
      } catch {
        // Implausible name or resolve failure — leave supplier_id untouched.
      }
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      params.push(sanitizeString(body.title));
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(sanitizeString(body.description));
    }
    if (body.category !== undefined) {
      updates.push('category = ?');
      params.push(sanitizeString(body.category));
    }
    if (body.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(body.tags));
    }
    if (body.status !== undefined) {
      if (!['active', 'archived'].includes(body.status)) {
        return new Response(
          JSON.stringify({ error: 'status must be active or archived' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('status = ?');
      params.push(body.status);
    }
    if (body.document_type_id !== undefined) {
      updates.push('document_type_id = ?');
      params.push(body.document_type_id || null);
    }
    if (body.supplier_id !== undefined) {
      updates.push('supplier_id = ?');
      params.push(body.supplier_id);
    }
    if (body.primary_metadata !== undefined) {
      updates.push('primary_metadata = ?');
      params.push(body.primary_metadata ? JSON.stringify(body.primary_metadata) : null);
    }
    if (body.extended_metadata !== undefined) {
      updates.push('extended_metadata = ?');
      params.push(body.extended_metadata ? JSON.stringify(body.extended_metadata) : null);
    }
    // Registry fields.
    if (body.aliases !== undefined) {
      updates.push('aliases = ?');
      params.push(JSON.stringify(body.aliases));
    }
    if (body.criteria !== undefined) {
      updates.push('criteria = ?');
      params.push(JSON.stringify(body.criteria));
    }
    if (body.applies_to !== undefined) {
      updates.push('applies_to = ?');
      params.push(JSON.stringify(body.applies_to));
    }
    if (body.owner !== undefined) {
      updates.push('owner = ?');
      params.push(body.owner ? sanitizeString(body.owner) : null);
    }
    if (body.renewal_type !== undefined) {
      updates.push('renewal_type = ?');
      params.push(body.renewal_type ?? null);
    }
    if (body.renewal_interval_months !== undefined) {
      updates.push('renewal_interval_months = ?');
      params.push(body.renewal_interval_months ?? null);
    }
    if (body.renewal_due_date !== undefined) {
      updates.push('renewal_due_date = ?');
      params.push(body.renewal_due_date ?? null);
    }
    if (renewalEdit) {
      updates.push('renewal_decision = ?', 'renewal_snapshot = ?', 'renewal_decided_at = ?', 'renewal_decided_by = ?');
      params.push(renewalEdit.decision, renewalEdit.snapshot, renewalEdit.decided_at, user.id);
    }
    // When categories is provided, keep document_type_id = the primary.
    if (body.categories !== undefined) {
      updates.push('document_type_id = ?');
      params.push(primaryCatId ?? null);
    }
    if (sharingChange) {
      // Clearing the override clears who / when / why with it: those three
      // describe an override, and there is none. The audit row keeps them.
      updates.push(
        'sharing_rule_override = ?',
        'sharing_rule_override_by = ?',
        'sharing_rule_override_at = ?',
        'sharing_rule_override_reason = ?',
      );
      const cleared = sharingChange.value === null;
      params.push(
        sharingChange.value,
        cleared ? null : user.id,
        cleared ? null : new Date().toISOString(),
        cleared ? null : sharingChange.reason,
      );
    }

    // A facet-only edit ("this document also satisfies X") touches no documents
    // column, so it must not be rejected as an empty update. Bump updated_at so
    // the row still reflects that the document changed.
    // A sharing override sent with the value already in force is a no-op, not
    // an empty update: the editor posts the field on every save.
    const sharingNoop = body.sharing_rule_override !== undefined && !sharingChange;
    if (updates.length === 0 && !hasFacetWrite && !sharingNoop) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push('updated_at = datetime(\'now\')');
    params.push(docId);

    // Build new values for diff computation
    const diffFields = ['title', 'description', 'category', 'tags', 'status', 'document_type_id', 'supplier_id', 'primary_metadata', 'extended_metadata'];
    const newValues: Record<string, any> = {
      title: body.title !== undefined ? sanitizeString(body.title) : doc.title,
      description: body.description !== undefined ? sanitizeString(body.description) : doc.description,
      category: body.category !== undefined ? sanitizeString(body.category) : doc.category,
      tags: body.tags !== undefined ? body.tags : (doc.tags ? JSON.parse(doc.tags as string) : null),
      status: body.status !== undefined ? body.status : doc.status,
      document_type_id: body.document_type_id !== undefined ? body.document_type_id : doc.document_type_id,
      supplier_id: body.supplier_id !== undefined ? body.supplier_id : doc.supplier_id,
      primary_metadata: body.primary_metadata !== undefined ? body.primary_metadata : doc.primary_metadata,
      extended_metadata: body.extended_metadata !== undefined ? body.extended_metadata : doc.extended_metadata,
    };

    // Parse tags from old doc for comparison
    const oldDoc: Record<string, any> = {
      ...doc,
      tags: doc.tags ? JSON.parse(doc.tags as string) : null,
    };

    const diff = computeDiff(oldDoc, newValues, diffFields);

    await context.env.DB.prepare(
      `UPDATE documents SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    // REPLACE the category set when provided. FTS category_text refreshes via
    // the document_categories triggers.
    //
    // RETIRED by 0080 but deliberately KEPT: 0079's documents_fts_source view
    // still reads document_categories and every FTS trigger writes through it,
    // so the facet sync below is ADDITIVE. See the P3 checklist in plan.md.
    if (body.categories !== undefined) {
      await syncDocumentCategories(
        context.env.DB,
        docId,
        body.categories,
        primaryCatId ?? null,
      );
    }

    // Registry facets. This is the post-upload EDITOR — a role-gated human
    // acting on their own tenant — which is exactly the path registry.ts
    // documents as defaulting to 'confirmed'. Ingest proposes ('suggested'),
    // this endpoint is where a human confirms; without that there is no route
    // to a confirmed link and gap detection stays permanently empty. A caller
    // may still state a status per link.
    await syncDocumentFacets(context.env.DB, docId, facetInput, {
      defaultStatus: 'confirmed',
      actorId: user.id,
    });

    // Type-level requirement defaults (migration 0100). RE-TYPING a document is
    // the one edit on this endpoint that changes what it should be closing, so
    // it is the one edit that gets to propose links. Three guards, and all
    // three are about not overruling a human:
    //   - the type actually CHANGED (a title edit re-suggests nothing);
    //   - the caller sent no `requirements` facet, so an explicit set — even an
    //     explicit empty one, which is somebody clearing the checkboxes — wins;
    //   - the document has NO requirement links at all yet. A curated set built
    //     under the old type is a set of decisions; the defaults for the new
    //     type are a guess, and a guess does not get to arrive alongside them.
    //
    // The read of `document_type_id` goes through a narrow cast: the shared
    // `Document` type in lib/types.ts predates the column (migration 0012) and
    // does not declare it, which is why the diff block above already carries
    // four errors on exactly this property. Widening that type is a separate
    // change with its own blast radius, so this pass states the shape it needs
    // locally rather than adding a fifth.
    const currentDocTypeId =
      (doc as unknown as { document_type_id: string | null }).document_type_id ?? null;
    const newDocTypeId: string | null =
      body.categories !== undefined
        ? (primaryCatId ?? null)
        : body.document_type_id !== undefined
          ? (body.document_type_id ?? null)
          : currentDocTypeId;
    if (
      newDocTypeId &&
      newDocTypeId !== currentDocTypeId &&
      facetInput.requirements === undefined
    ) {
      const linkCount = await context.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM document_requirements WHERE document_id = ?',
      )
        .bind(docId)
        .first<{ n: number }>();
      if ((linkCount?.n ?? 0) === 0) {
        await applyDocumentTypeRequirementDefaults(context.env.DB, {
          documentId: docId,
          tenantId: doc.tenant_id,
          documentTypeId: newDocTypeId,
          actorId: user.id,
        });
      }
    }

    // A person setting or correcting the document's type on this screen IS the
    // human affirmation migration 0081's 'classified' state describes — the
    // second of the two doors that write it, alongside Review Queue approval.
    // Gated on the type actually being present and having CHANGED, so a title
    // edit does not re-stamp classification_reviewed_at with today's date and
    // claim someone re-examined the classification.
    if (newDocTypeId && newDocTypeId !== currentDocTypeId) {
      await recordClassification(context.env.DB, {
        documentId: docId,
        tenantId: doc.tenant_id,
        documentTypeId: newDocTypeId,
        actorId: user.id,
        byHuman: true,
        clientIp: getClientIp(context.request),
      });
    }

    // The same audit action the approval-time decision writes (kinds/coa.ts),
    // so "when did this document get its renewal date, and who said so" is one
    // query whichever screen answered it. `via` tells the two apart.
    if (renewalEdit) {
      await logAudit(
        context.env.DB,
        user.id,
        doc.tenant_id,
        'document.renewal_decided',
        'document',
        docId,
        JSON.stringify({
          via: 'document_edit',
          decision: renewalEdit.decision,
          previous_due_date: renewalEdit.edit.previous_due_date,
          renewal_due_date: renewalEdit.edit.new_due_date,
          reason: renewalEdit.edit.reason,
          snapshot: renewalEdit.snapshot,
        }),
        getClientIp(context.request)
      );
    }

    if (sharingChange && ruleChange) {
      await logAudit(
        context.env.DB,
        user.id,
        doc.tenant_id,
        'document.sharing_rule_overridden',
        'document',
        docId,
        JSON.stringify({
          override: sharingChange.value,
          previous_override: sharingChange.previous,
          rule: ruleChange.after,
          previous_rule: ruleChange.before,
          reason: sharingChange.reason,
        }),
        getClientIp(context.request)
      );
    }
    // The effective rule moved, by whichever of the three fields: one row
    // saying from what, to what, and what moved it.
    if (ruleChange?.rule_changed && ruleChange.cause) {
      await auditRuleChange(context.env.DB, {
        userId: user.id,
        tenantId: doc.tenant_id,
        documentId: docId,
        from: ruleChange.before,
        to: ruleChange.after,
        cause: ruleChange.cause,
        via: context.data.authMethod === 'api_key' ? 'document_edit (api key)' : 'document_edit',
        previousTypeId: ruleChange.previous_type_id,
        typeId: ruleChange.next_type_id,
        reason: sharingChange?.reason ?? null,
        clientIp: getClientIp(context.request),
      });
    }

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_updated',
      'document',
      docId,
      JSON.stringify({ changes: diff }),
      getClientIp(context.request)
    );

    // Fetch updated document + its category set (mirrors the GET shape).
    const updated = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ?'
    )
      .bind(docId)
      .first();

    if (updated) {
      const cats = await context.env.DB.prepare(
        `SELECT dc.id, dc.document_id, dc.document_type_id, dc.is_primary, dc.created_at,
                dt.name AS document_type_name, dt.slug AS document_type_slug
         FROM document_categories dc
         JOIN document_types dt ON dt.id = dc.document_type_id
         WHERE dc.document_id = ?
         ORDER BY dc.is_primary DESC, dt.name ASC`
      )
        .bind(docId)
        .all();
      (updated as Record<string, unknown>).categories = cats.results;
      (updated as Record<string, unknown>).requirements = await listDocumentFacet(
        context.env.DB,
        'requirement',
        docId,
      );
      (updated as Record<string, unknown>).claims = await listDocumentFacet(
        context.env.DB,
        'claim',
        docId,
      );
      (updated as Record<string, unknown>).sharing = await describeDocumentSharing(
        context.env.DB,
        user,
        doc.tenant_id,
        docId,
      );
    }

    return new Response(
      JSON.stringify({ document: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/documents/:id
 * Soft-delete a document by setting status to 'deleted'.
 * Requires user (own tenant) or admin.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    await context.env.DB.prepare(
      'UPDATE documents SET status = \'deleted\', updated_at = datetime(\'now\') WHERE id = ?'
    )
      .bind(docId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_deleted',
      'document',
      docId,
      JSON.stringify({ title: doc.title, previous_status: doc.status }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
