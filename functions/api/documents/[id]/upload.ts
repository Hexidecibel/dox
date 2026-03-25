import { generateId } from '../../../lib/db';
import { logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { buildR2Key, uploadFile, computeChecksum } from '../../../lib/r2';
import { sanitizeString } from '../../../lib/validation';
import { extractText } from '../../../lib/extract';
import type { Env, User, Document } from '../../../lib/types';

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

/** Map of allowed mime types to their expected file extensions. */
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
 * POST /api/documents/:id/upload
 * Upload a new version of a document.
 * Accepts multipart form data with a "file" field and optional "changeNotes" field.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    // Only users, org_admins, and super_admins can upload
    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Fetch the document
    const doc = await context.env.DB.prepare(
      'SELECT d.*, t.slug as tenant_slug FROM documents d LEFT JOIN tenants t ON d.tenant_id = t.id WHERE d.id = ? AND d.status = \'active\''
    )
      .bind(docId)
      .first<Document & { tenant_slug: string }>();

    if (!doc) {
      throw new NotFoundError('Document not found or not active');
    }

    requireTenantAccess(user, doc.tenant_id);

    // Parse multipart form data
    const formData = await context.request.formData();
    const file = formData.get('file') as File | null;
    const changeNotes = formData.get('changeNotes') as string | null;

    if (!file) {
      return new Response(
        JSON.stringify({ error: 'file is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file type
    const mimeType = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.includes(mimeType)) {
      return new Response(
        JSON.stringify({ error: 'File type not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JSON, PNG, JPG' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'File too large. Maximum size: 100MB' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file extension matches mime type (basic sanity check)
    const fileName = file.name;
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
    const expectedExtensions = MIME_TO_EXTENSIONS[mimeType];
    if (expectedExtensions && ext && !expectedExtensions.includes(ext)) {
      return new Response(
        JSON.stringify({ error: `File extension "${ext}" does not match the file type "${mimeType}"` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Read file data
    const fileData = await file.arrayBuffer();
    const fileSize = fileData.byteLength;

    // Double-check size after reading (defense in depth)
    if (fileSize > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'File too large. Maximum size: 100MB' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Compute checksum
    const checksum = await computeChecksum(fileData);

    // Sanitize change notes if provided
    const sanitizedNotes = changeNotes ? sanitizeString(changeNotes) : null;

    // Determine new version number
    const newVersion = (doc.current_version as number) + 1;

    // Build R2 key and upload
    const r2Key = buildR2Key(doc.tenant_slug, docId, newVersion, fileName);
    await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

    // Extract text content for full-text search
    const extractedText = await extractText(fileData, mimeType, fileName);

    // Insert version record
    const versionId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, change_notes, uploaded_by, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        versionId,
        docId,
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

    // Update document's current_version and updated_at
    await context.env.DB.prepare(
      'UPDATE documents SET current_version = ?, updated_at = datetime(\'now\') WHERE id = ?'
    )
      .bind(newVersion, docId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_version_uploaded',
      'document_version',
      versionId,
      JSON.stringify({ document_id: docId, version: newVersion, file_name: fileName, file_size: fileSize }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({
        version: {
          id: versionId,
          document_id: docId,
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
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Upload error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
