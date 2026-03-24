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
import type { Env, User, Document } from '../../lib/types';

const ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
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
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

/**
 * POST /api/documents/ingest
 * Upsert a document by external_ref. Creates or adds a new version.
 * Designed for agentic AI / email processing pipelines.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
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

    // Validate required fields
    if (!file) {
      throw new BadRequestError('file is required');
    }
    if (!externalRef) {
      throw new BadRequestError('external_ref is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    // Validate file type
    const mimeType = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.includes(mimeType)) {
      throw new BadRequestError(
        'File type not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPG'
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

    // Read file data and compute checksum
    const fileData = await file.arrayBuffer();
    const fileSize = fileData.byteLength;

    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestError('File too large. Maximum size: 100MB');
    }

    const checksum = await computeChecksum(fileData);
    const sanitizedRef = sanitizeString(externalRef);
    const sanitizedNotes = changeNotes ? sanitizeString(changeNotes) : null;
    const sanitizedTitle = title ? sanitizeString(title) : fileName.replace(/\.[^/.]+$/, '');

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
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, change_notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          user.id
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

      updateBindings.push(existingDoc.id);

      await context.env.DB.prepare(
        `UPDATE documents SET ${updateFields.join(', ')} WHERE id = ?`
      )
        .bind(...updateBindings)
        .run();

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
          },
          version: {
            id: versionId,
            document_id: existingDoc.id,
            version_number: newVersion,
            file_name: fileName,
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
        `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, source_metadata)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`
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
          sourceMetadata || null
        )
        .run();

      // Insert version
      const versionId = generateId();
      await context.env.DB.prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, change_notes, uploaded_by)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          versionId,
          docId,
          fileName,
          fileSize,
          mimeType,
          r2Key,
          checksum,
          sanitizedNotes,
          user.id
        )
        .run();

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
          },
          version: {
            id: versionId,
            document_id: docId,
            version_number: 1,
            file_name: fileName,
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
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Ingest error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
