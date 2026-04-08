import { computeChecksum, uploadFile } from '../../lib/r2';
import { generateId } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { User, Env } from '../../lib/types';
import type { ExtractionField } from '../../../shared/types';

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
 * POST /api/documents/process
 * Accept files, upload to R2, create queue entries. Returns immediately.
 * Actual text extraction + LLM processing happens asynchronously via the local worker.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const formData = await context.request.formData();
    const documentTypeId = formData.get('document_type_id') as string | null;
    const tenantId = (formData.get('tenant_id') as string) || user.tenant_id;
    const source = (formData.get('source') as string) || 'import';
    const sourceDetail = formData.get('source_detail') as string | null;

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    // Look up document type if provided
    let docType: {
      id: string;
      name: string;
      extraction_fields: string | null;
      auto_ingest: number;
    } | null = null;

    let extractionFields: ExtractionField[] = [];

    if (documentTypeId) {
      docType = await context.env.DB.prepare(
        'SELECT id, name, extraction_fields, auto_ingest FROM document_types WHERE id = ? AND active = 1'
      ).bind(documentTypeId).first<{
        id: string;
        name: string;
        extraction_fields: string | null;
        auto_ingest: number;
      }>();

      if (!docType) {
        throw new NotFoundError('Document type not found');
      }

      // Parse extraction_fields
      if (docType.extraction_fields) {
        try {
          const parsed = typeof docType.extraction_fields === 'string'
            ? JSON.parse(docType.extraction_fields)
            : docType.extraction_fields;
          if (Array.isArray(parsed)) extractionFields = parsed;
        } catch {
          // Invalid JSON — treat as empty
        }
      }
    }

    // Look up tenant slug for R2 key
    const tenant = await context.env.DB.prepare(
      'SELECT slug FROM tenants WHERE id = ?'
    ).bind(tenantId).first<{ slug: string }>();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    // Get all files from form data
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      throw new BadRequestError('No files provided');
    }

    // Process each file: validate, upload to R2, create queue entry
    const queuedItems: Array<{
      id: string;
      file_name: string;
      duplicate?: { document_id: string; document_title: string; file_name: string } | null;
    }> = [];

    for (const file of files) {
      // Validate file type
      const mimeType = file.type || 'application/octet-stream';
      if (!ALLOWED_TYPES.includes(mimeType)) {
        // Skip invalid files — include error info in response
        queuedItems.push({
          id: '',
          file_name: file.name,
          duplicate: null,
        });
        continue;
      }

      // Validate file extension
      const fileName = file.name;
      const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
      const expectedExtensions = MIME_TO_EXTENSIONS[mimeType];
      if (expectedExtensions && ext && !expectedExtensions.includes(ext)) {
        queuedItems.push({
          id: '',
          file_name: file.name,
          duplicate: null,
        });
        continue;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        queuedItems.push({
          id: '',
          file_name: file.name,
          duplicate: null,
        });
        continue;
      }

      const fileData = await file.arrayBuffer();
      const checksum = await computeChecksum(fileData);

      // Check for duplicate
      let duplicate: { document_id: string; document_title: string; file_name: string } | null = null;
      try {
        const existingVersion = await context.env.DB.prepare(
          `SELECT dv.document_id, dv.file_name, d.title
           FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
           WHERE dv.checksum = ? AND d.tenant_id = ? AND d.status != 'deleted'
           LIMIT 1`
        ).bind(checksum, tenantId).first<{
          document_id: string;
          file_name: string;
          title: string;
        }>();

        if (existingVersion) {
          duplicate = {
            document_id: existingVersion.document_id,
            document_title: existingVersion.title,
            file_name: existingVersion.file_name,
          };
        }
      } catch {
        // Non-critical
      }

      // Upload file to R2 under pending path
      const queueId = generateId();
      const r2Key = `pending/${tenant.slug}/${queueId}/${fileName}`;
      await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

      // Create queue entry
      await context.env.DB.prepare(
        `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, status, processing_status, checksum, created_by, source, source_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?, ?)`
      )
        .bind(queueId, tenantId, documentTypeId || null, r2Key, fileName, file.size, mimeType, checksum, user.id, source, sourceDetail)
        .run();

      queuedItems.push({
        id: queueId,
        file_name: fileName,
        duplicate,
      });
    }

    return new Response(JSON.stringify({
      queued: true,
      items: queuedItems,
      ...(docType ? {
        document_type: {
          id: docType.id,
          name: docType.name,
          extraction_fields: extractionFields,
          auto_ingest: !!(docType.auto_ingest),
        },
      } : {}),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Process error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
