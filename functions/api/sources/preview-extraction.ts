/**
 * POST /api/sources/preview-extraction
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
import { parseCSVAttachment } from '../../../shared/orderParse';
import type { ConnectorOutput, ParsedOrder, ParsedCustomer, ConnectorError } from '../../lib/connectors/types';

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

    // Connectors → Sources: the synchronous extraction engine (XLSX/PDF/eml
    // AI parsing) has been removed. The wizard's live preview is now a pure
    // CSV schema-mapping preview — it shows how the deterministic field
    // mappings split a sample CSV into primary/extended metadata. Non-CSV
    // samples flow through the async worker → Review Queue at ingest time and
    // have no synchronous preview.
    let parsed: ConnectorOutput;
    if (sourceType === 'csv' || sourceType === 'text') {
      // parseCSVAttachment is the pure deterministic mapper from
      // shared/orderParse — structural typing accepts the {fieldMappings} ctx
      // and {content} attachment without the full Worker ConnectorContext.
      parsed = parseCSVAttachment(
        { fieldMappings: mappings },
        { content: buffer },
      );
    } else {
      return new Response(
        JSON.stringify({
          error: `Live preview is only available for CSV samples. source_type="${sourceType}" is processed asynchronously at ingest time.`,
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
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
