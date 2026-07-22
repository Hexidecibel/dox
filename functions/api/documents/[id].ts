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
  isValidRenewalType,
} from '../../lib/registry';
import type { Env, User, Document } from '../../lib/types';
import type { RenewalType } from '../../../shared/types';

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
      aliases?: string[];
      criteria?: string[];
      applies_to?: string[];
      owner?: string | null;
      renewal_type?: RenewalType | null;
      renewal_interval_months?: number | null;
      renewal_due_date?: string | null;
    };

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
      params.push(body.document_type_id);
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
    // When categories is provided, keep document_type_id = the primary.
    if (body.categories !== undefined) {
      updates.push('document_type_id = ?');
      params.push(primaryCatId ?? null);
    }

    if (updates.length === 0) {
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
    if (body.categories !== undefined) {
      await syncDocumentCategories(
        context.env.DB,
        docId,
        body.categories,
        primaryCatId ?? null,
      );
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
