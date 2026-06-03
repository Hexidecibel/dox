import { computeChecksum, uploadFile } from '../../lib/r2';
import { generateId } from '../../lib/db';
import { enqueueDocument } from '../../lib/intake/enqueue';
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

// Reverse map: extension → canonical mime. Browsers (and some upload clients)
// frequently send Office files with an empty or 'application/octet-stream'
// Content-Type — most notoriously .docx — which would otherwise fail the
// ALLOWED_TYPES allowlist and silently drop the file. We recover the canonical
// mime from the extension in that case.
const EXTENSION_TO_MIME: Record<string, string> = Object.entries(MIME_TO_EXTENSIONS)
  .reduce<Record<string, string>>((acc, [mime, exts]) => {
    for (const ext of exts) acc[ext] = mime;
    return acc;
  }, {});

// Mimes we treat as "unknown" and therefore eligible for extension-based
// recovery. An empty type from the browser also lands here.
const GENERIC_MIMES = new Set(['', 'application/octet-stream']);

function fileExtension(fileName: string): string {
  return fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
}

/**
 * Resolve the effective mime for an uploaded file. If the client supplied a
 * recognized mime, trust it. Otherwise (empty / octet-stream) fall back to the
 * canonical mime implied by the file extension so e.g. .docx uploads aren't
 * dropped just because the browser didn't set a Content-Type.
 */
function resolveMimeType(rawType: string, fileName: string): string {
  const type = rawType || '';
  if (!GENERIC_MIMES.has(type) && ALLOWED_TYPES.includes(type)) {
    return type;
  }
  const byExt = EXTENSION_TO_MIME[fileExtension(fileName)];
  if (byExt) return byExt;
  return type || 'application/octet-stream';
}

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

    // Optional intake routing: which downstream kind the worker should produce.
    // NULL is treated as 'coa' downstream; we default to 'coa' explicitly for clarity.
    const VALID_OUTPUT_KINDS = ['coa', 'order', 'shipment'];
    const rawOutputKind = formData.get('output_kind') as string | null;
    const outputKind = rawOutputKind || 'coa';
    if (!VALID_OUTPUT_KINDS.includes(outputKind)) {
      throw new BadRequestError(
        `Invalid output_kind '${rawOutputKind}'. Must be one of: ${VALID_OUTPUT_KINDS.join(', ')}`
      );
    }

    // Optional source (connector) id — pass through if present, else null.
    const sourceId = (formData.get('source_id') as string) || null;

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
      // Validate file type. Recover the canonical mime from the extension when
      // the client sent an empty / octet-stream Content-Type (common for .docx).
      const fileName = file.name;
      const mimeType = resolveMimeType(file.type, fileName);
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
      const ext = fileExtension(fileName);
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
      await enqueueDocument(context.env.DB, {
        id: queueId,
        tenantId,
        documentTypeId: documentTypeId || null,
        fileR2Key: r2Key,
        fileName,
        fileSize: file.size,
        mimeType,
        checksum,
        createdBy: user.id,
        source,
        sourceDetail,
        outputKind,
        sourceId,
      });

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
