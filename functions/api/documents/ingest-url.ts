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
      tags?: string;
      change_notes?: string;
      source_metadata?: string;
      file_name?: string;
    };
    try {
      body = await context.request.json();
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const { file_url: fileUrl, external_ref: externalRef, tenant_id: tenantId } = body;

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

    // Validate tags if provided
    const tags = body.tags || null;
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
    const sourceMetadata = body.source_metadata || null;
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

    // Compute checksum and extract text
    const checksum = await computeChecksum(fileData);
    const extractedText = await extractText(fileData.slice(0), mimeType, fileName);
    const sanitizedRef = sanitizeString(externalRef);
    const changeNotes = body.change_notes || null;
    const sanitizedNotes = changeNotes ? sanitizeString(changeNotes) : null;
    const sanitizedTitle = body.title
      ? sanitizeString(body.title)
      : fileName.replace(/\.[^/.]+$/, '');

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
          source: 'url',
          file_url: fileUrl,
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
          body.description ? sanitizeString(body.description) : null,
          body.category ? sanitizeString(body.category) : null,
          tags || '[]',
          user.id,
          sanitizedRef,
          sourceMetadata || null
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
            description: body.description ? sanitizeString(body.description) : null,
            category: body.category ? sanitizeString(body.category) : null,
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

    console.error('Ingest-url error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
