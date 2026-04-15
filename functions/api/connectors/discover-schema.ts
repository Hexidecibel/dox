/**
 * POST /api/connectors/discover-schema
 *
 * File-first wizard entry point. Accepts a sample file, uploads it to R2
 * under a short-lived `tmp/connector-samples/` prefix, runs format-specific
 * schema discovery over it, and returns:
 *   - sample_id: the R2 key the caller passes back to /preview-extraction
 *   - detected_fields: columns found in the sample, with type inference
 *     and candidate core/extended targets
 *   - sample_rows: first few rows for the Review step preview
 *   - suggested_mappings: a fully-populated v2 ConnectorFieldMappings draft
 *     ready to seed the wizard's Review step
 *
 * Wave 1: CSV only. XLSX / PDF / EML return 501 with a clear message so the
 * wizard can steer users toward the supported path without crashing.
 */

import { generateId } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import {
  discoverFromCSV,
  discoverFromXLSX,
  discoverFromPDF,
  discoverFromEmail,
  buildFieldMappingsFromDetection,
  looksLikeEmail,
  type DiscoveryResult,
} from '../../lib/connectors/schemaDiscovery';

type SourceType = 'csv' | 'xlsx' | 'pdf' | 'eml' | 'text';

const SUPPORTED_TYPES: SourceType[] = ['csv', 'xlsx', 'pdf', 'eml', 'text'];

const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function resolveSourceType(file: File | null, explicit: string | null): SourceType | null {
  if (explicit) {
    if (SUPPORTED_TYPES.includes(explicit as SourceType)) return explicit as SourceType;
    return null;
  }
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'xlsx';
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.eml')) return 'eml';
  if (name.endsWith('.txt')) return 'text';
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const formData = await context.request.formData();
    const file = formData.get('file') as File | null;
    const sourceTypeRaw = formData.get('source_type') as string | null;
    let tenantId = formData.get('tenant_id') as string | null;

    if (!file) {
      throw new BadRequestError('file is required (multipart form field "file")');
    }
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    let sourceType = resolveSourceType(file, sourceTypeRaw);
    if (!sourceType) {
      throw new BadRequestError(
        `Unable to determine source_type. Pass source_type as one of: ${SUPPORTED_TYPES.join(', ')}`,
      );
    }

    // Upload the sample to R2 with a tmp/ prefix so a nightly cleanup job
    // can purge abandoned uploads.
    const buffer = await file.arrayBuffer();
    const sampleId = `tmp/connector-samples/${tenantId}/${generateId()}`;
    const expiresAt = Date.now() + SAMPLE_TTL_MS;

    // Content-sniff for misnamed emails. If the caller said csv/text (or we
    // guessed csv/text from an ambiguous extension) but the bytes actually
    // look like an RFC822 message, re-route to the email parser — otherwise
    // the CSV parser shreds `Subject: Daily COA Report, April 6` on the comma.
    // Do NOT second-guess explicit binary/eml choices.
    const autoDetectWarnings: string[] = [];
    if (sourceType === 'csv' || sourceType === 'text') {
      const peek = new TextDecoder().decode(buffer.slice(0, 2048));
      if (looksLikeEmail(peek)) {
        autoDetectWarnings.push('Content detected as email — auto-routing to email parser');
        sourceType = 'eml';
      }
    }

    if (context.env.FILES) {
      await context.env.FILES.put(sampleId, buffer, {
        httpMetadata: {
          contentType: file.type || inferContentType(sourceType),
        },
        customMetadata: {
          source_type: sourceType,
          tenant_id: tenantId,
          original_name: file.name,
          expires_at: String(expiresAt),
          uploaded_by: user.id,
        },
      });
    }

    // Dispatch on source_type.
    const qwenConfig = {
      url: context.env.QWEN_URL,
      secret: context.env.QWEN_SECRET,
    };
    let result: DiscoveryResult;
    switch (sourceType) {
      case 'csv':
      case 'text': {
        const csvText = new TextDecoder().decode(buffer);
        result = discoverFromCSV(csvText);
        break;
      }
      case 'xlsx': {
        result = await discoverFromXLSX(buffer);
        break;
      }
      case 'pdf': {
        result = await discoverFromPDF(buffer, qwenConfig);
        break;
      }
      case 'eml': {
        const emlText = new TextDecoder().decode(buffer);
        result = await discoverFromEmail(emlText, qwenConfig);
        break;
      }
    }

    const suggestedMappings = buildFieldMappingsFromDetection(result);

    return new Response(
      JSON.stringify({
        sample_id: sampleId,
        source_type: sourceType,
        file_name: file.name,
        size: buffer.byteLength,
        expires_at: expiresAt,
        detected_fields: result.detected_fields,
        sample_rows: result.sample_rows,
        layout_hint: result.layout_hint,
        warnings: [...autoDetectWarnings, ...result.warnings],
        suggested_mappings: suggestedMappings,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('discover-schema error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function inferContentType(sourceType: SourceType): string {
  switch (sourceType) {
    case 'csv': return 'text/csv';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pdf': return 'application/pdf';
    case 'eml': return 'message/rfc822';
    case 'text': return 'text/plain';
  }
}
