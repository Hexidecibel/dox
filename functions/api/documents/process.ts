import { extractText } from '../../lib/extract';
import { extractFields } from '../../lib/llm';
import { computeConfidenceScore } from '../../lib/confidence';
import { computeChecksum } from '../../lib/r2';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { User, Env } from '../../lib/types';
import type { ExtractionField, ProcessingResult } from '../../../shared/types';

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
 * Accept files, extract text, call LLM for field extraction, return results.
 * Does NOT ingest/store anything — purely for preview/processing.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const formData = await context.request.formData();
    const documentTypeId = formData.get('document_type_id') as string;
    const tenantId = (formData.get('tenant_id') as string) || user.tenant_id;

    if (!documentTypeId) {
      throw new BadRequestError('document_type_id is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    // Look up document type and get extraction_fields
    const docType = await context.env.DB.prepare(
      'SELECT id, name, naming_format, extraction_fields, auto_ingest_threshold FROM document_types WHERE id = ? AND active = 1'
    ).bind(documentTypeId).first<{
      id: string;
      name: string;
      naming_format: string | null;
      extraction_fields: string | null;
      auto_ingest_threshold: number | null;
    }>();

    if (!docType) {
      throw new NotFoundError('Document type not found');
    }

    // Parse extraction_fields
    let extractionFields: ExtractionField[] = [];
    if (docType.extraction_fields) {
      try {
        const parsed = typeof docType.extraction_fields === 'string'
          ? JSON.parse(docType.extraction_fields)
          : docType.extraction_fields;
        if (Array.isArray(parsed)) extractionFields = parsed;
      } catch {
        // Invalid JSON in extraction_fields — treat as empty
      }
    }

    // Few-shot examples will be fetched per-file after supplier detection
    // (moved below into the per-file processing loop)

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

    // Process each file
    const results: ProcessingResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        // Validate file type
        const mimeType = file.type || 'application/octet-stream';
        if (!ALLOWED_TYPES.includes(mimeType)) {
          results.push({
            file_name: file.name,
            file_index: i,
            status: 'error',
            error_message: 'File type not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JSON, PNG, JPG',
            fields: {},
            product_names: [],
            confidence: 'low',
            confidence_score: 0,
            training_ready: false,
            example_count: 0,
          });
          continue;
        }

        // Validate file extension matches mime type
        const fileName = file.name;
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
        const expectedExtensions = MIME_TO_EXTENSIONS[mimeType];
        if (expectedExtensions && ext && !expectedExtensions.includes(ext)) {
          results.push({
            file_name: file.name,
            file_index: i,
            status: 'error',
            error_message: `File extension "${ext}" does not match the file type "${mimeType}"`,
            fields: {},
            product_names: [],
            confidence: 'low',
            confidence_score: 0,
            training_ready: false,
            example_count: 0,
          });
          continue;
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          results.push({
            file_name: file.name,
            file_index: i,
            status: 'error',
            error_message: 'File too large (100MB max)',
            fields: {},
            product_names: [],
            confidence: 'low',
            confidence_score: 0,
            training_ready: false,
            example_count: 0,
          });
          continue;
        }

        // Extract text
        const fileData = await file.arrayBuffer();
        const text = await extractText(fileData, mimeType, fileName);

        // Compute checksum for duplicate detection
        const checksum = await computeChecksum(fileData);

        // Check for existing document with same checksum in this tenant
        let duplicate: ProcessingResult['duplicate'] = undefined;
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
          // Non-critical — don't block processing if duplicate check fails
        }

        if (!text) {
          results.push({
            file_name: file.name,
            file_index: i,
            status: 'error',
            error_message: 'Could not extract text from file',
            fields: {},
            product_names: [],
            confidence: 'low',
            confidence_score: 0,
            training_ready: false,
            example_count: 0,
            checksum,
            duplicate,
          });
          continue;
        }

        // Initial LLM extraction (no few-shot yet — we need supplier first)
        const initialExtraction = await extractFields(text, context.env);

        // Detect supplier from extracted fields
        const supplierKeys = ['supplier_name', 'supplier', 'manufacturer', 'vendor', 'company', 'from'];
        const supplier = supplierKeys.map(k => initialExtraction.fields[k]).find(v => v != null && String(v).trim() !== '') as string | undefined || null;

        // Fetch supplier-aware few-shot examples
        const MIN_TRAINING_EXAMPLES = 3;
        let fewShotExamples: { input_text: string; corrected_output: string }[] = [];

        if (supplier) {
          const supplierExResult = await context.env.DB.prepare(
            `SELECT input_text, corrected_output FROM extraction_examples
             WHERE document_type_id = ? AND tenant_id = ? AND supplier = ? AND score >= 0.7
             ORDER BY score DESC, created_at DESC LIMIT 3`
          ).bind(documentTypeId, tenantId, supplier).all();
          fewShotExamples = (supplierExResult.results || []).map(e => ({
            input_text: e.input_text as string,
            corrected_output: e.corrected_output as string,
          }));
        }

        // Fill remaining slots from other suppliers
        if (fewShotExamples.length < 3) {
          const remaining = 3 - fewShotExamples.length;
          const otherExResult = await context.env.DB.prepare(
            `SELECT input_text, corrected_output FROM extraction_examples
             WHERE document_type_id = ? AND tenant_id = ? AND (supplier IS NULL OR supplier != ?) AND score >= 0.7
             ORDER BY score DESC, created_at DESC LIMIT ?`
          ).bind(documentTypeId, tenantId, supplier || '', remaining).all();
          fewShotExamples = [...fewShotExamples, ...(otherExResult.results || []).map(e => ({
            input_text: e.input_text as string,
            corrected_output: e.corrected_output as string,
          }))];
        }

        // Re-extract with few-shot examples if we have any
        let extraction = initialExtraction;
        if (fewShotExamples.length > 0) {
          extraction = await extractFields(text, context.env, fewShotExamples);
        }

        // Count training examples for this supplier+doctype
        let exampleCount = 0;
        if (supplier) {
          const supplierExamples = await context.env.DB.prepare(
            `SELECT COUNT(*) as count FROM extraction_examples
             WHERE document_type_id = ? AND tenant_id = ? AND supplier = ? AND score >= 0.7`
          ).bind(documentTypeId, tenantId, supplier).first();
          exampleCount = (supplierExamples?.count as number) || 0;
        }

        if (exampleCount < MIN_TRAINING_EXAMPLES) {
          // Fallback: count all examples for this doc type
          const allExamples = await context.env.DB.prepare(
            `SELECT COUNT(*) as count FROM extraction_examples
             WHERE document_type_id = ? AND tenant_id = ? AND score >= 0.7`
          ).bind(documentTypeId, tenantId).first();
          exampleCount = (allExamples?.count as number) || 0;
        }

        const trainingReady = exampleCount >= MIN_TRAINING_EXAMPLES;

        const confidenceScore = computeConfidenceScore(extraction.confidence, extraction.fields);

        results.push({
          file_name: file.name,
          file_index: i,
          status: 'success',
          extracted_text_preview: text.substring(0, 500),
          fields: extraction.fields,
          tables: extraction.tables,
          summary: extraction.summary,
          product_names: extraction.products,
          confidence: extraction.confidence,
          confidence_score: confidenceScore,
          supplier: supplier || undefined,
          training_ready: trainingReady,
          example_count: exampleCount,
          checksum,
          duplicate,
        });
      } catch (err) {
        results.push({
          file_name: file.name,
          file_index: i,
          status: 'error',
          error_message: err instanceof Error ? err.message : 'Processing failed',
          fields: {},
          product_names: [],
          confidence: 'low',
          confidence_score: 0,
          training_ready: false,
          example_count: 0,
        });
      }
    }

    return new Response(JSON.stringify({
      results,
      document_type: {
        id: docType.id as string,
        name: docType.name as string,
        naming_format: docType.naming_format || null,
        extraction_fields: extractionFields,
        auto_ingest_threshold: docType.auto_ingest_threshold ?? null,
      },
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
