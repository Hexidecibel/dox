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
import { applyNamingTemplate } from '../../lib/naming';
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

const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/plain',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Extract filename from a Content-Disposition header value.
 */
function parseContentDispositionFilename(header: string): string | null {
  // Try filename*= (RFC 5987) first
  const starMatch = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1]);
    } catch {
      // fall through
    }
  }
  // Try filename="..."
  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1];
  // Try filename=... (unquoted)
  const unquotedMatch = header.match(/filename=([^;\s]+)/i);
  if (unquotedMatch) return unquotedMatch[1];
  return null;
}

/**
 * Extract filename from a URL path.
 */
function filenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const last = decodeURIComponent(segments[segments.length - 1]);
    // Only return if it looks like a filename (has an extension)
    if (last.includes('.')) return last;
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /api/documents/ingest-url
 * Upsert a document by external_ref, downloading the file from a URL.
 * Creates or adds a new version. Designed for agentic AI / email processing pipelines.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  let partialTenantId: string | null = null;
  let partialFileName: string | null = null;
  let partialExternalRef: string | null = null;
  let partialFileUrl: string | null = null;

  try {
    // Require JSON content type
    const contentType = context.request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      throw new BadRequestError('Content-Type must be application/json');
    }

    const user = context.data.user as User;

    // Only users, org_admins, and super_admins can ingest
    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Parse JSON body
    let body: {
      file_url?: string;
      external_ref?: string;
      tenant_id?: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: string | string[];
      change_notes?: string;
      source_metadata?: string | Record<string, unknown>;
      file_name?: string;
      document_type_id?: string;
      lot_number?: string;
      po_number?: string;
      code_date?: string;
      expiration_date?: string;
      product_ids?: string | Array<{ product_id: string; expires_at?: string; notes?: string }>;
    };
    try {
      body = await context.request.json();
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const { file_url: fileUrl, external_ref: externalRef, tenant_id: tenantId } = body;

    partialTenantId = tenantId || null;
    partialExternalRef = externalRef || null;
    partialFileUrl = fileUrl || null;
    partialFileName = body.file_name || null;

    // Validate required fields
    if (!fileUrl) {
      throw new BadRequestError('file_url is required');
    }
    if (!externalRef) {
      throw new BadRequestError('external_ref is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fileUrl);
    } catch {
      throw new BadRequestError('file_url must be a valid URL');
    }
    if (!parsedUrl.protocol.startsWith('http')) {
      throw new BadRequestError('file_url must use http or https protocol');
    }

    // Download the file from the URL
    let fetchResponse: Response;
    try {
      fetchResponse = await fetch(fileUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'DocPortal-Ingest/1.0',
        },
      });
    } catch (err) {
      throw new BadRequestError(
        `Failed to download file from URL: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }

    if (!fetchResponse.ok) {
      throw new BadRequestError(
        `Failed to download file from URL: HTTP ${fetchResponse.status} ${fetchResponse.statusText}`
      );
    }

    // Determine filename: explicit override > Content-Disposition > URL path > fallback
    let fileName: string;
    if (body.file_name) {
      fileName = body.file_name;
    } else {
      const cdHeader = fetchResponse.headers.get('Content-Disposition');
      const cdFilename = cdHeader ? parseContentDispositionFilename(cdHeader) : null;
      const urlFilename = filenameFromUrl(fileUrl);
      fileName = cdFilename || urlFilename || 'document';
    }

    // Determine MIME type: response Content-Type header > infer from extension > fallback
    let mimeType: string;
    const responseContentType = fetchResponse.headers.get('Content-Type');
    if (responseContentType) {
      // Strip parameters like charset
      mimeType = responseContentType.split(';')[0].trim().toLowerCase();
    } else {
      mimeType = 'application/octet-stream';
    }

    // If the response gave us a generic type, try to infer from extension
    if (mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
      const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
      if (ext && EXTENSION_TO_MIME[ext]) {
        mimeType = EXTENSION_TO_MIME[ext];
      }
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(mimeType)) {
      throw new BadRequestError(
        'File type not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JSON, PNG, JPG'
      );
    }

    // Validate file extension matches mime type
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
    const expectedExtensions = MIME_TO_EXTENSIONS[mimeType];
    if (expectedExtensions && ext && !expectedExtensions.includes(ext)) {
      throw new BadRequestError(
        `File extension "${ext}" does not match the file type "${mimeType}"`
      );
    }

    // Read the file data
    const fileData = await fetchResponse.arrayBuffer();
    const fileSize = fileData.byteLength;

    // Validate file size
    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestError('File too large. Maximum size: 100MB');
    }

    // Normalize tags - accept string (JSON) or array
    let tagsStr: string | null = null;
    if (body.tags) {
      if (Array.isArray(body.tags)) {
        tagsStr = JSON.stringify(body.tags);
      } else if (typeof body.tags === 'string') {
        try {
          const parsed = JSON.parse(body.tags);
          if (!Array.isArray(parsed)) {
            throw new BadRequestError('tags must be an array of strings');
          }
          tagsStr = body.tags;
        } catch (e) {
          if (e instanceof BadRequestError) throw e;
          throw new BadRequestError('tags must be a valid JSON array');
        }
      }
    }

    // Normalize source_metadata - accept string (JSON) or object
    let sourceMetadataStr: string | null = null;
    if (body.source_metadata) {
      if (typeof body.source_metadata === 'string') {
        try {
          JSON.parse(body.source_metadata);
          sourceMetadataStr = body.source_metadata;
        } catch {
          throw new BadRequestError('source_metadata must be a valid JSON string');
        }
      } else if (typeof body.source_metadata === 'object') {
        sourceMetadataStr = JSON.stringify(body.source_metadata);
      }
    }

    // Normalize product_ids - accept string (JSON) or array
    let productLinks: Array<{ product_id: string; expires_at?: string; notes?: string }> = [];
    if (body.product_ids) {
      let parsed: unknown;
      if (typeof body.product_ids === 'string') {
        try {
          parsed = JSON.parse(body.product_ids);
        } catch {
          throw new BadRequestError('product_ids must be a valid JSON array');
        }
      } else {
        parsed = body.product_ids;
      }
      if (!Array.isArray(parsed)) {
        throw new BadRequestError('product_ids must be an array');
      }
      for (const entry of parsed) {
        if (!entry.product_id || typeof entry.product_id !== 'string') {
          throw new BadRequestError('Each product_ids entry must have a product_id string');
        }
      }
      productLinks = parsed;
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

    // Compute checksum and extract text
    const checksum = await computeChecksum(fileData);
    const extractedText = await extractText(fileData.slice(0), mimeType, fileName);
    const sanitizedRef = sanitizeString(externalRef);
    const changeNotes = body.change_notes || null;
    const sanitizedNotes = changeNotes ? sanitizeString(changeNotes) : null;
    const sanitizedTitle = body.title
      ? sanitizeString(body.title)
      : fileName.replace(/\.[^/.]+$/, '');
    const sanitizedLotNumber = body.lot_number?.trim() ? sanitizeString(body.lot_number) : null;
    const sanitizedPoNumber = body.po_number?.trim() ? sanitizeString(body.po_number) : null;
    const sanitizedCodeDate = body.code_date?.trim() ? sanitizeString(body.code_date) : null;
    const sanitizedExpirationDate = body.expiration_date?.trim() ? sanitizeString(body.expiration_date) : null;
    const documentTypeId = body.document_type_id?.trim() || null;

    // Check for naming template and apply to file name
    let displayFileName = fileName;
    const namingTemplate = await context.env.DB.prepare(
      'SELECT template FROM naming_templates WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .first<{ template: string }>();

    if (namingTemplate?.template) {
      const fileExt = fileName.split('.').pop() || '';
      displayFileName = applyNamingTemplate(namingTemplate.template, {
        title: sanitizedTitle || fileName.replace(/\.[^/.]+$/, ''),
        lot_number: sanitizedLotNumber || undefined,
        po_number: sanitizedPoNumber || undefined,
        code_date: sanitizedCodeDate || undefined,
        expiration_date: sanitizedExpirationDate || undefined,
        ext: fileExt,
      });
    }

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
          fileName,
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

      if (sourceMetadataStr) {
        updateFields.push('source_metadata = ?');
        updateBindings.push(sourceMetadataStr);
      }
      if (documentTypeId) {
        updateFields.push('document_type_id = ?');
        updateBindings.push(documentTypeId);
      }
      if (sanitizedLotNumber) {
        updateFields.push('lot_number = ?');
        updateBindings.push(sanitizedLotNumber);
      }
      if (sanitizedPoNumber) {
        updateFields.push('po_number = ?');
        updateBindings.push(sanitizedPoNumber);
      }
      if (sanitizedCodeDate) {
        updateFields.push('code_date = ?');
        updateBindings.push(sanitizedCodeDate);
      }
      if (sanitizedExpirationDate) {
        updateFields.push('expiration_date = ?');
        updateBindings.push(sanitizedExpirationDate);
      }

      updateBindings.push(existingDoc.id);

      await context.env.DB.prepare(
        `UPDATE documents SET ${updateFields.join(', ')} WHERE id = ?`
      )
        .bind(...updateBindings)
        .run();

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
          source: 'url',
          file_url: fileUrl,
          source_metadata: sourceMetadataStr ? JSON.parse(sourceMetadataStr) : null,
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
            source_metadata: sourceMetadataStr || existingDoc.source_metadata,
            document_type_id: documentTypeId || existingDoc.document_type_id || null,
            lot_number: sanitizedLotNumber || existingDoc.lot_number || null,
            po_number: sanitizedPoNumber || existingDoc.po_number || null,
            code_date: sanitizedCodeDate || existingDoc.code_date || null,
            expiration_date: sanitizedExpirationDate || existingDoc.expiration_date || null,
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
        `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, source_metadata, document_type_id, lot_number, po_number, code_date, expiration_date)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          docId,
          tenantId,
          sanitizedTitle,
          body.description ? sanitizeString(body.description) : null,
          body.category ? sanitizeString(body.category) : null,
          tagsStr || '[]',
          user.id,
          sanitizedRef,
          sourceMetadataStr || null,
          documentTypeId,
          sanitizedLotNumber,
          sanitizedPoNumber,
          sanitizedCodeDate,
          sanitizedExpirationDate
        )
        .run();

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
          source: 'url',
          file_url: fileUrl,
          source_metadata: sourceMetadataStr ? JSON.parse(sourceMetadataStr) : null,
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
            description: body.description ? sanitizeString(body.description) : null,
            category: body.category ? sanitizeString(body.category) : null,
            tags: tagsStr || '[]',
            current_version: 1,
            status: 'active',
            created_by: user.id,
            created_at: now,
            updated_at: now,
            external_ref: sanitizedRef,
            source_metadata: sourceMetadataStr || null,
            document_type_id: documentTypeId,
            lot_number: sanitizedLotNumber,
            po_number: sanitizedPoNumber,
            code_date: sanitizedCodeDate,
            expiration_date: sanitizedExpirationDate,
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
            source: 'url',
            file_url: partialFileUrl,
          }),
          getClientIp(context.request)
        );
      }
    } catch {
      // Never let audit logging failure mask the original error
    }

    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Ingest-url error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
