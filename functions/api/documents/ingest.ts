import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { buildR2Key, uploadFile, computeChecksum } from '../../lib/r2';
import { sanitizeString } from '../../lib/validation';
import { extractText } from '../../lib/extract';
import { attachLotToCoaDocument, extractSubLotCode } from '../../lib/entities/matching';
import {
  parseStringArray,
  validateCategoryIds,
  resolvePrimaryCategoryId,
  syncDocumentCategories,
  isValidRenewalType,
} from '../../lib/registry';
import type { Env, User, Document } from '../../lib/types';

const ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/json',
  'image/png',
  'image/jpeg',
];

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt', '.text', '.log', '.md'],
  'application/json': ['.json'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

/**
 * POST /api/documents/ingest
 * Upsert a document by external_ref. Creates or adds a new version.
 * Designed for agentic AI / email processing pipelines.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  let partialTenantId: string | null = null;
  let partialFileName: string | null = null;
  let partialExternalRef: string | null = null;

  try {
    const user = context.data.user as User;

    // Only users, org_admins, and super_admins can ingest
    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Parse multipart form data
    const formData = await context.request.formData();
    const file = formData.get('file') as File | null;
    const externalRef = formData.get('external_ref') as string | null;
    const tenantId = formData.get('tenant_id') as string | null;
    const title = formData.get('title') as string | null;
    const description = formData.get('description') as string | null;
    const category = formData.get('category') as string | null;
    const tags = formData.get('tags') as string | null;
    const changeNotes = formData.get('changeNotes') as string | null;
    const sourceMetadata = formData.get('source_metadata') as string | null;
    const documentTypeId = formData.get('document_type_id') as string | null;
    const supplierId = formData.get('supplier_id') as string | null;
    const primaryMetadataRaw = formData.get('primary_metadata') as string | null;
    const extendedMetadataRaw = formData.get('extended_metadata') as string | null;
    // Backward compat: accept old field names and fold them into primary_metadata
    const lotNumber = formData.get('lot_number') as string | null;
    const poNumber = formData.get('po_number') as string | null;
    const codeDate = formData.get('code_date') as string | null;
    const expirationDate = formData.get('expiration_date') as string | null;
    const productIdsRaw = formData.get('product_ids') as string | null;
    // IDP Document Registry fields (migrations 0076/0077).
    const categoriesRaw = formData.get('categories') as string | null;
    const primaryCategoryId = formData.get('primary_category_id') as string | null;
    const aliasesRaw = formData.get('aliases') as string | null;
    const criteriaRaw = formData.get('criteria') as string | null;
    const appliesToRaw = formData.get('applies_to') as string | null;
    const owner = formData.get('owner') as string | null;
    const renewalType = formData.get('renewal_type') as string | null;
    const renewalIntervalMonthsRaw = formData.get('renewal_interval_months') as string | null;
    const renewalDueDate = formData.get('renewal_due_date') as string | null;

    // external_ref is OPTIONAL on the manual registry path. When the caller
    // supplies one (e.g. a QFD doc_id) we keep the idempotent upsert; when it
    // is absent we mint `reg-<random>` so each manual upload creates a new doc.
    const effectiveExternalRef = externalRef && externalRef.trim()
      ? externalRef
      : `reg-${generateId()}`;

    partialTenantId = tenantId;
    partialFileName = file?.name ?? null;
    partialExternalRef = effectiveExternalRef;

    // Validate required fields
    if (!file) {
      throw new BadRequestError('file is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    // Parse + validate registry fields up front.
    const categoryIds = parseStringArray(categoriesRaw, 'categories');
    const aliases = parseStringArray(aliasesRaw, 'aliases');
    const criteria = parseStringArray(criteriaRaw, 'criteria');
    const appliesTo = parseStringArray(appliesToRaw, 'applies_to');

    if (renewalType && !isValidRenewalType(renewalType)) {
      throw new BadRequestError(
        'renewal_type must be one of: renewal_application, hard_expiry, keep_current, review_cycle',
      );
    }

    let renewalIntervalMonths: number | null = null;
    if (renewalIntervalMonthsRaw != null && renewalIntervalMonthsRaw !== '') {
      const parsed = parseInt(renewalIntervalMonthsRaw, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new BadRequestError('renewal_interval_months must be a non-negative integer');
      }
      renewalIntervalMonths = parsed;
    }

    // The primary category also becomes documents.document_type_id (denormalized
    // pointer). Fall back to an explicit document_type_id form field when no
    // categories are given.
    const primaryCatId = resolvePrimaryCategoryId(categoryIds, primaryCategoryId);
    const effectiveDocTypeId = primaryCatId || documentTypeId || null;

    // Serialize the JSON-array columns (null when empty so we don't clobber the
    // '[]' default needlessly on update).
    const aliasesStr = aliases.length > 0 ? JSON.stringify(aliases) : null;
    const criteriaStr = criteria.length > 0 ? JSON.stringify(criteria) : null;
    const appliesToStr = appliesTo.length > 0 ? JSON.stringify(appliesTo) : null;
    const ownerVal = owner && owner.trim() ? sanitizeString(owner) : null;
    const renewalTypeVal = renewalType || null;
    const renewalDueDateVal = renewalDueDate && renewalDueDate.trim() ? renewalDueDate.trim() : null;

    // Validate file type
    const mimeType = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.includes(mimeType)) {
      throw new BadRequestError(
        'File type not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JSON, PNG, JPG'
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestError('File too large. Maximum size: 100MB');
    }

    // Validate file extension matches mime type
    const fileName = file.name;
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
    const expectedExtensions = MIME_TO_EXTENSIONS[mimeType];
    if (expectedExtensions && ext && !expectedExtensions.includes(ext)) {
      throw new BadRequestError(
        `File extension "${ext}" does not match the file type "${mimeType}"`
      );
    }

    // Validate tags if provided
    if (tags) {
      try {
        const parsed = JSON.parse(tags);
        if (!Array.isArray(parsed)) {
          throw new BadRequestError('tags must be a JSON array of strings');
        }
      } catch (e) {
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError('tags must be a valid JSON array');
      }
    }

    // Validate source_metadata if provided
    if (sourceMetadata) {
      try {
        JSON.parse(sourceMetadata);
      } catch {
        throw new BadRequestError('source_metadata must be a valid JSON string');
      }
    }

    // Validate product_ids if provided
    let productLinks: Array<{ product_id: string; expires_at?: string; notes?: string }> = [];
    if (productIdsRaw) {
      try {
        const parsed = JSON.parse(productIdsRaw);
        if (!Array.isArray(parsed)) {
          throw new BadRequestError('product_ids must be a JSON array');
        }
        for (const entry of parsed) {
          if (!entry.product_id || typeof entry.product_id !== 'string') {
            throw new BadRequestError('Each product_ids entry must have a product_id string');
          }
        }
        productLinks = parsed;
      } catch (e) {
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError('product_ids must be a valid JSON array');
      }
    }

    // Check tenant exists and is active
    const tenant = await context.env.DB.prepare(
      'SELECT id, slug, active FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first<{ id: string; slug: string; active: number }>();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }
    if (!tenant.active) {
      throw new BadRequestError('Tenant is not active');
    }

    // Check tenant access
    requireTenantAccess(user, tenantId);

    // Validate registry categories + the standalone document_type_id belong to
    // this tenant (rejects cross-tenant leakage).
    await validateCategoryIds(context.env.DB, tenantId, categoryIds);
    if (documentTypeId) {
      await validateCategoryIds(context.env.DB, tenantId, [documentTypeId]);
    }

    // Validate product_ids belong to this tenant
    if (productLinks.length > 0) {
      const productIds = productLinks.map(l => l.product_id);
      const placeholders = productIds.map(() => '?').join(',');
      const validProducts = await context.env.DB.prepare(
        `SELECT id FROM products WHERE id IN (${placeholders}) AND tenant_id = ?`
      ).bind(...productIds, tenantId).all();

      const validIds = new Set(validProducts.results.map((r: any) => r.id));
      const invalidIds = productIds.filter(id => !validIds.has(id));
      if (invalidIds.length > 0) {
        throw new BadRequestError(`Invalid product_ids for this tenant: ${invalidIds.join(', ')}`);
      }
    }

    // Read file data and compute checksum
    const fileData = await file.arrayBuffer();
    const fileSize = fileData.byteLength;

    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestError('File too large. Maximum size: 100MB');
    }

    const checksum = await computeChecksum(fileData);
    const extractedText = await extractText(fileData.slice(0), mimeType, fileName);
    const sanitizedRef = sanitizeString(effectiveExternalRef);
    const sanitizedNotes = changeNotes ? sanitizeString(changeNotes) : null;
    const sanitizedTitle = title ? sanitizeString(title) : fileName.replace(/\.[^/.]+$/, '');

    // Build primary_metadata: explicit JSON > backward-compat old fields
    let primaryMetadata: Record<string, string | null> = {};
    if (primaryMetadataRaw) {
      try { primaryMetadata = JSON.parse(primaryMetadataRaw); } catch { /* ignore */ }
    }
    // Backward compat: fold old field names into primary_metadata
    if (lotNumber) primaryMetadata.lot_number = sanitizeString(lotNumber);
    if (poNumber) primaryMetadata.po_number = sanitizeString(poNumber);
    if (codeDate) primaryMetadata.code_date = sanitizeString(codeDate);
    if (expirationDate) primaryMetadata.expiration_date = sanitizeString(expirationDate);

    let extendedMetadata: Record<string, string | null> = {};
    if (extendedMetadataRaw) {
      try { extendedMetadata = JSON.parse(extendedMetadataRaw); } catch { /* ignore */ }
    }

    const primaryMetadataStr = Object.keys(primaryMetadata).length > 0 ? JSON.stringify(primaryMetadata) : null;
    const extendedMetadataStr = Object.keys(extendedMetadata).length > 0 ? JSON.stringify(extendedMetadata) : null;

    // Use original filename as-is (metadata is searchable separately)
    const displayFileName = fileName;

    // Look up existing document by external_ref + tenant_id
    const existingDoc = await context.env.DB.prepare(
      "SELECT * FROM documents WHERE external_ref = ? AND tenant_id = ? AND status != 'deleted'"
    )
      .bind(sanitizedRef, tenantId)
      .first<Document & { external_ref: string; source_metadata: string | null }>();

    if (existingDoc) {
      // === UPDATE FLOW: Add new version ===
      const newVersion = existingDoc.current_version + 1;
      const r2Key = buildR2Key(tenant.slug, existingDoc.id, newVersion, fileName);

      await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

      const versionId = generateId();
      await context.env.DB.prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, change_notes, uploaded_by, extracted_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          versionId,
          existingDoc.id,
          newVersion,
          displayFileName,
          fileSize,
          mimeType,
          r2Key,
          checksum,
          sanitizedNotes,
          user.id,
          extractedText
        )
        .run();

      // Update document metadata
      const updateFields = [
        'current_version = ?',
        "updated_at = datetime('now')",
      ];
      const updateBindings: (string | number | null)[] = [newVersion];

      if (sourceMetadata) {
        updateFields.push('source_metadata = ?');
        updateBindings.push(sourceMetadata);
      }
      if (effectiveDocTypeId) {
        updateFields.push('document_type_id = ?');
        updateBindings.push(effectiveDocTypeId);
      }
      if (supplierId) {
        updateFields.push('supplier_id = ?');
        updateBindings.push(supplierId);
      }
      if (primaryMetadataStr) {
        updateFields.push('primary_metadata = ?');
        updateBindings.push(primaryMetadataStr);
      }
      if (extendedMetadataStr) {
        updateFields.push('extended_metadata = ?');
        updateBindings.push(extendedMetadataStr);
      }
      // Registry fields — only overwrite when the caller sent the field.
      if (aliasesRaw != null) {
        updateFields.push('aliases = ?');
        updateBindings.push(aliasesStr ?? '[]');
      }
      if (criteriaRaw != null) {
        updateFields.push('criteria = ?');
        updateBindings.push(criteriaStr ?? '[]');
      }
      if (appliesToRaw != null) {
        updateFields.push('applies_to = ?');
        updateBindings.push(appliesToStr ?? '[]');
      }
      if (owner != null) {
        updateFields.push('owner = ?');
        updateBindings.push(ownerVal);
      }
      if (renewalType != null) {
        updateFields.push('renewal_type = ?');
        updateBindings.push(renewalTypeVal);
      }
      if (renewalIntervalMonthsRaw != null) {
        updateFields.push('renewal_interval_months = ?');
        updateBindings.push(renewalIntervalMonths);
      }
      if (renewalDueDate != null) {
        updateFields.push('renewal_due_date = ?');
        updateBindings.push(renewalDueDateVal);
      }

      updateBindings.push(existingDoc.id);

      await context.env.DB.prepare(
        `UPDATE documents SET ${updateFields.join(', ')} WHERE id = ?`
      )
        .bind(...updateBindings)
        .run();

      // REPLACE the category set when categories were sent (multi-category
      // "one doc, many mappings"). FTS category_text refreshes via triggers.
      if (categoriesRaw != null) {
        await syncDocumentCategories(
          context.env.DB,
          existingDoc.id,
          categoryIds,
          primaryCatId,
        );
      }

      // Link products if provided (update flow)
      if (productLinks.length > 0) {
        for (const link of productLinks) {
          await context.env.DB.prepare(
            `INSERT INTO document_products (id, document_id, product_id, expires_at, notes)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(document_id, product_id) DO UPDATE SET
               expires_at = COALESCE(excluded.expires_at, document_products.expires_at),
               notes = COALESCE(excluded.notes, document_products.notes),
               updated_at = datetime('now')`
          )
            .bind(generateId(), existingDoc.id, link.product_id, link.expires_at || null, link.notes || null)
            .run();

          // Record product↔supplier provenance (Model B) when a supplier is
          // known for this ingest.
          if (supplierId) {
            await context.env.DB.prepare(
              `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(product_id, supplier_id) DO NOTHING`
            )
              .bind(generateId(), tenantId, link.product_id, supplierId)
              .run();
          }
        }
      }

      // Phase 2: lot resolution + order⇄COA matching for COA ingests carrying a
      // lot. Attach once per linked product (or once with null product when no
      // product links exist). Best-effort — never blocks the ingest.
      {
        const ingestLot =
          (primaryMetadata.lot_number as string | null) || lotNumber || null;
        // D1: honour a sub_lot_code supplied in primary_metadata so an ingested
        // COA keys on the same combined lot_key (norm(lot) + sublot) the
        // review/approve path produces. Absent → '' (unchanged behavior).
        const ingestSubLot = extractSubLotCode(primaryMetadata);
        if (ingestLot) {
          const targets = productLinks.length > 0
            ? productLinks.map((l) => l.product_id)
            : [null];
          for (const pid of targets) {
            await attachLotToCoaDocument(context.env.DB, tenantId, {
              documentId: existingDoc.id,
              lotNumber: ingestLot,
              subLotCode: ingestSubLot,
              productId: pid,
              supplierId: supplierId || null,
              codeDate: (primaryMetadata.code_date as string | null) || codeDate || null,
              expirationDate:
                (primaryMetadata.expiration_date as string | null) || expirationDate || null,
              source: 'ingest',
            });
          }
        }
      }

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'document.ingested',
        'document',
        existingDoc.id,
        JSON.stringify({
          action: 'version_added',
          external_ref: sanitizedRef,
          version: newVersion,
          file_name: fileName,
          file_size: fileSize,
          source_metadata: sourceMetadata ? JSON.parse(sourceMetadata) : null,
        }),
        getClientIp(context.request)
      );

      return new Response(
        JSON.stringify({
          action: 'version_added',
          document: {
            id: existingDoc.id,
            tenant_id: existingDoc.tenant_id,
            title: existingDoc.title,
            description: existingDoc.description,
            category: existingDoc.category,
            tags: existingDoc.tags,
            current_version: newVersion,
            status: existingDoc.status,
            created_by: existingDoc.created_by,
            created_at: existingDoc.created_at,
            updated_at: new Date().toISOString(),
            external_ref: existingDoc.external_ref,
            source_metadata: sourceMetadata || existingDoc.source_metadata,
            document_type_id: effectiveDocTypeId || existingDoc.document_type_id || null,
            supplier_id: supplierId || existingDoc.supplier_id || null,
            primary_metadata: primaryMetadataStr || existingDoc.primary_metadata || null,
            extended_metadata: extendedMetadataStr || existingDoc.extended_metadata || null,
          },
          version: {
            id: versionId,
            document_id: existingDoc.id,
            version_number: newVersion,
            file_name: displayFileName,
            file_size: fileSize,
            mime_type: mimeType,
            r2_key: r2Key,
            checksum,
            change_notes: sanitizedNotes,
            uploaded_by: user.id,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      // === CREATE FLOW: New document ===
      const docId = generateId();
      const r2Key = buildR2Key(tenant.slug, docId, 1, fileName);

      await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

      // Insert document
      await context.env.DB.prepare(
        `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, source_metadata, document_type_id, supplier_id, primary_metadata, extended_metadata, aliases, criteria, applies_to, owner, renewal_type, renewal_interval_months, renewal_due_date)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          docId,
          tenantId,
          sanitizedTitle,
          description ? sanitizeString(description) : null,
          category ? sanitizeString(category) : null,
          tags || '[]',
          user.id,
          sanitizedRef,
          sourceMetadata || null,
          effectiveDocTypeId,
          supplierId || null,
          primaryMetadataStr,
          extendedMetadataStr,
          aliasesStr ?? '[]',
          criteriaStr ?? '[]',
          appliesToStr ?? '[]',
          ownerVal,
          renewalTypeVal,
          renewalIntervalMonths,
          renewalDueDateVal
        )
        .run();

      // Category set (multi-category). The document row exists now, so the
      // document_categories FTS triggers refresh category_text.
      if (categoryIds.length > 0) {
        await syncDocumentCategories(context.env.DB, docId, categoryIds, primaryCatId);
      }

      // Insert version
      const versionId = generateId();
      await context.env.DB.prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, change_notes, uploaded_by, extracted_text)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          versionId,
          docId,
          displayFileName,
          fileSize,
          mimeType,
          r2Key,
          checksum,
          sanitizedNotes,
          user.id,
          extractedText
        )
        .run();

      // Link products if provided (create flow)
      if (productLinks.length > 0) {
        for (const link of productLinks) {
          await context.env.DB.prepare(
            `INSERT INTO document_products (id, document_id, product_id, expires_at, notes)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(document_id, product_id) DO NOTHING`
          )
            .bind(generateId(), docId, link.product_id, link.expires_at || null, link.notes || null)
            .run();

          // Record product↔supplier provenance (Model B) when a supplier is
          // known for this ingest.
          if (supplierId) {
            await context.env.DB.prepare(
              `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(product_id, supplier_id) DO NOTHING`
            )
              .bind(generateId(), tenantId, link.product_id, supplierId)
              .run();
          }
        }
      }

      // Phase 2: lot resolution + order⇄COA matching (create flow). See the
      // update flow above for rationale. Best-effort.
      {
        const ingestLot =
          (primaryMetadata.lot_number as string | null) || lotNumber || null;
        // D1: honour a sub_lot_code supplied in primary_metadata so an ingested
        // COA keys on the same combined lot_key (norm(lot) + sublot) the
        // review/approve path produces. Absent → '' (unchanged behavior).
        const ingestSubLot = extractSubLotCode(primaryMetadata);
        if (ingestLot) {
          const targets = productLinks.length > 0
            ? productLinks.map((l) => l.product_id)
            : [null];
          for (const pid of targets) {
            await attachLotToCoaDocument(context.env.DB, tenantId, {
              documentId: docId,
              lotNumber: ingestLot,
              subLotCode: ingestSubLot,
              productId: pid,
              supplierId: supplierId || null,
              codeDate: (primaryMetadata.code_date as string | null) || codeDate || null,
              expirationDate:
                (primaryMetadata.expiration_date as string | null) || expirationDate || null,
              source: 'ingest',
            });
          }
        }
      }

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'document.ingested',
        'document',
        docId,
        JSON.stringify({
          action: 'created',
          external_ref: sanitizedRef,
          version: 1,
          file_name: fileName,
          file_size: fileSize,
          source_metadata: sourceMetadata ? JSON.parse(sourceMetadata) : null,
        }),
        getClientIp(context.request)
      );

      const now = new Date().toISOString();

      return new Response(
        JSON.stringify({
          action: 'created',
          document: {
            id: docId,
            tenant_id: tenantId,
            title: sanitizedTitle,
            description: description ? sanitizeString(description) : null,
            category: category ? sanitizeString(category) : null,
            tags: tags || '[]',
            current_version: 1,
            status: 'active',
            created_by: user.id,
            created_at: now,
            updated_at: now,
            external_ref: sanitizedRef,
            source_metadata: sourceMetadata || null,
            document_type_id: effectiveDocTypeId,
            supplier_id: supplierId || null,
            primary_metadata: primaryMetadataStr,
            extended_metadata: extendedMetadataStr,
          },
          version: {
            id: versionId,
            document_id: docId,
            version_number: 1,
            file_name: displayFileName,
            file_size: fileSize,
            mime_type: mimeType,
            r2_key: r2Key,
            checksum,
            change_notes: sanitizedNotes,
            uploaded_by: user.id,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    // Log failed ingest attempt
    try {
      const user = context.data?.user as User | undefined;
      if (context.env?.DB && user?.id) {
        await logAudit(
          context.env.DB,
          user.id,
          partialTenantId,
          'document.ingest_failed',
          'document',
          null,
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            file_name: partialFileName,
            external_ref: partialExternalRef,
            source: 'form',
          }),
          getClientIp(context.request)
        );
      }
    } catch {
      // Never let audit logging failure mask the original error
    }

    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Ingest error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
