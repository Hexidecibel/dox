/**
 * POST /api/connectors/preview-extraction
 *
 * Run the connector's parse path against a previously-uploaded sample so the
 * wizard's Review step can show "this is what a real ingest would look like"
 * before the user commits the config.
 *
 * NEVER writes to D1. This endpoint is pure — it fetches a sample from R2,
 * drives the connector's parser with an in-memory ConnectorContext, and
 * returns the rows as plain JSON. No orders / customers / connector_runs
 * get persisted.
 *
 * Wave 1: CSV only. Non-CSV samples return 501.
 */

import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import {
  normalizeFieldMappings,
  validateFieldMappings,
} from '../../../shared/fieldMappings';
import { execute as executeEmailConnector, parseCSVAttachment } from '../../lib/connectors/email';
import type { ConnectorContext, ConnectorOutput, EmailAttachment, ParsedOrder, ParsedCustomer, ConnectorError } from '../../lib/connectors/types';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

interface PreviewBody {
  sample_id?: string;
  field_mappings?: unknown;
  connector_type?: string;
  /** Max rows to return — default 3, max 10. */
  limit?: number;
  tenant_id?: string;
}

interface PreviewRow {
  order_number: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  primary_metadata?: Record<string, unknown>;
  extended_metadata?: Record<string, unknown>;
  source_data: Record<string, unknown>;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const started = Date.now();
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as PreviewBody;

    if (!body.sample_id || typeof body.sample_id !== 'string') {
      throw new BadRequestError('sample_id is required');
    }
    if (!body.sample_id.startsWith('tmp/connector-samples/')) {
      throw new BadRequestError('sample_id must reference a connector sample upload');
    }

    // Extract the tenant_id segment from the sample key. The discover-schema
    // endpoint stores samples under `tmp/connector-samples/<tenant_id>/<id>`.
    const segments = body.sample_id.split('/');
    if (segments.length < 4) {
      throw new BadRequestError('sample_id is malformed');
    }
    const sampleTenantId = segments[2];
    requireTenantAccess(user, sampleTenantId);

    // Normalize + validate the field mappings. The caller usually passes
    // the Review-step draft, which should already be v2, but we accept any
    // legacy shape and run it through normalize for safety.
    const mappings = normalizeFieldMappings(body.field_mappings);
    const validation = validateFieldMappings(mappings);
    if (!validation.ok) {
      throw new BadRequestError(
        `field_mappings invalid: ${validation.errors.join('; ')}`,
      );
    }

    const limit = Math.min(
      Math.max(1, Math.floor(body.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );

    // Fetch the sample from R2.
    if (!context.env.FILES) {
      throw new BadRequestError('R2 (FILES) binding not configured');
    }
    const object = await context.env.FILES.get(body.sample_id);
    if (!object) {
      return new Response(
        JSON.stringify({ error: 'Sample not found (may have expired)' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const sourceType = object.customMetadata?.source_type || 'csv';
    const buffer = await object.arrayBuffer();
    const originalName = object.customMetadata?.original_name || `sample.${sourceType}`;
    const contentType = object.httpMetadata?.contentType || inferContentType(sourceType);

    // Build a synthetic ConnectorContext. db/r2 are unused on the parse
    // path but must be typed — stubbed because preview writes nothing.
    const ctx: ConnectorContext = {
      db: {} as never,
      r2: undefined,
      tenantId: sampleTenantId,
      connectorId: 'preview',
      config: {},
      fieldMappings: mappings,
      qwenUrl: context.env.QWEN_URL,
      qwenSecret: context.env.QWEN_SECRET,
    };

    let parsed: ConnectorOutput;
    if (sourceType === 'csv' || sourceType === 'text') {
      const attachment: EmailAttachment = {
        filename: originalName,
        content: buffer,
        contentType: contentType || 'text/csv',
        size: buffer.byteLength,
      };
      parsed = parseCSVAttachment(ctx, attachment);
    } else if (sourceType === 'xlsx' || sourceType === 'pdf') {
      // Drive the full email connector so the XLSX/PDF attachment paths
      // produce real extracted rows against the user's chosen mappings.
      const attachment: EmailAttachment = {
        filename: originalName,
        content: buffer,
        contentType: contentType || (sourceType === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        size: buffer.byteLength,
      };
      parsed = await executeEmailConnector(ctx, {
        type: 'email',
        body: '',
        subject: `preview :: ${originalName}`,
        sender: 'preview@dox.local',
        attachments: [attachment],
      });
    } else if (sourceType === 'eml') {
      // .eml files are already full RFC822 messages — let the email
      // connector handle them via the body + attachments it carries.
      // For preview we just feed the raw text as body and let the AI
      // parser do its thing.
      const rawText = new TextDecoder().decode(buffer);
      parsed = await executeEmailConnector(ctx, {
        type: 'email',
        body: rawText,
        subject: `preview :: ${originalName}`,
        sender: 'preview@dox.local',
      });
    } else {
      return new Response(
        JSON.stringify({
          error: `Preview extraction for source_type="${sourceType}" is not supported.`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const rows: PreviewRow[] = parsed.orders.slice(0, limit).map((o: ParsedOrder) => ({
      order_number: o.order_number,
      po_number: o.po_number,
      customer_number: o.customer_number,
      customer_name: o.customer_name,
      primary_metadata: o.primary_metadata,
      extended_metadata: o.extended_metadata,
      source_data: o.source_data,
    }));

    const errors: ConnectorError[] = parsed.errors;
    const warnings: string[] = [];
    if (parsed.orders.length > limit) {
      warnings.push(`Showing ${limit} of ${parsed.orders.length} rows — raise the limit (max ${MAX_LIMIT}) to preview more.`);
    }
    const customerSample: ParsedCustomer[] = parsed.customers.slice(0, limit);

    return new Response(
      JSON.stringify({
        rows,
        customers: customerSample,
        errors,
        warnings,
        total_rows_in_sample: parsed.orders.length,
        total_customers_in_sample: parsed.customers.length,
        duration_ms: Date.now() - started,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('preview-extraction error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function inferContentType(sourceType: string): string {
  switch (sourceType) {
    case 'csv': return 'text/csv';
    case 'text': return 'text/plain';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pdf': return 'application/pdf';
    case 'eml': return 'message/rfc822';
    default: return 'application/octet-stream';
  }
}
