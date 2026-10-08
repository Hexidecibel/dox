import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import {
  defaultSharingRuleForTypeName,
  parseSharingRule,
  type SharingRule,
} from '../../../shared/sharingRule';
import { sanitizeString } from '../../lib/validation';
import {
  defaultRenewalSettingForTypeName,
  type TypeRenewalPolicy,
  type RenewalWindow,
} from '../../../shared/renewalPeriod';
import { parseRenewalIntervalMonths, parseTypeRenewalWindowSetting } from '../../lib/registry';
import { parseRenewalAlertLeadDays } from '../../../shared/renewalLeadTime';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseExtractionFields(docType: Record<string, unknown>): void {
  if (docType.extraction_fields && typeof docType.extraction_fields === 'string') {
    try {
      docType.extraction_fields = JSON.parse(docType.extraction_fields as string);
    } catch {
      // leave as-is if invalid JSON
    }
  }
}

/**
 * GET /api/document-types
 * List document types. Non-super_admins see only their tenant's types.
 * super_admin can filter by ?tenant_id=. Supports ?active=1 filter.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const activeFilter = url.searchParams.get('active');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const supplierIdParam = url.searchParams.get('supplier_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant scoping
    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (activeFilter !== null) {
      conditions.push('active = ?');
      params.push(Number(activeFilter));
    } else {
      // Default to showing only active document types
      conditions.push('active = 1');
    }

    // Optional supplier scoping: return shared/global doctypes (supplier_id
    // IS NULL) plus those owned by the given supplier, so selectors can show
    // the union. When absent, return all tenant doctypes (admin view).
    if (supplierIdParam) {
      conditions.push('(supplier_id IS NULL OR supplier_id = ?)');
      params.push(supplierIdParam);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM document_types ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get document types (with tenant name for super_admin view)
    const results = await context.env.DB.prepare(
      `SELECT dt.*, t.name as tenant_name
       FROM document_types dt
       LEFT JOIN tenants t ON dt.tenant_id = t.id
       ${whereClause ? whereClause.replace(/tenant_id/g, 'dt.tenant_id').replace(/active/g, 'dt.active') : ''}
       ORDER BY dt.name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    const documentTypes = results.results.map((dt) => {
      parseExtractionFields(dt as Record<string, unknown>);
      return dt;
    });

    return new Response(
      JSON.stringify({
        documentTypes,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List document types error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/document-types
 * Create a new document type. org_admin+ for their own tenant.
 * super_admin can specify tenant_id.
 * Fields: name (required), description (optional), tenant_id (optional, super_admin only).
 * Auto-generates slug from name.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      tenant_id?: string;
      supplier_id?: string | null;
      auto_ingest?: number;
      extract_tables?: number;
      renewal_interval_months?: number | null;
      /** 'inherit' | 'period' | 'none' — see migration 0097. */
      renewal_policy?: string | null;
      /** A fixed calendar renewal window (0125, G3). */
      renewal_window?: unknown;
      /** 'free' / 'qa' / 'locked' (migration 0137). Omitted = proposed from the name. */
      sharing_rule?: string | null;
      /** Days of renewal-alert warning for this type; null/absent = inherit (0111). */
      renewal_alert_lead_days?: number | null;
    };

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Determine tenant
    let tenantId: string;
    if (user.role === 'super_admin' && body.tenant_id) {
      tenantId = body.tenant_id;
    } else if (user.role === 'super_admin' && !body.tenant_id) {
      return new Response(
        JSON.stringify({ error: 'tenant_id is required for super_admin' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      tenantId = user.tenant_id!;
    }

    // Sanitize inputs
    body.name = sanitizeString(body.name);
    if (body.description) body.description = sanitizeString(body.description);

    const slug = slugify(body.name);

    if (!slug) {
      return new Response(
        JSON.stringify({ error: 'Could not generate a valid slug from name' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check slug uniqueness within tenant
    const existing = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE slug = ? AND tenant_id = ?'
    )
      .bind(slug, tenantId)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A document type with this slug already exists for this tenant' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Optional supplier ownership. Empty string is treated as "global" (NULL).
    const supplierId = body.supplier_id ? body.supplier_id : null;
    if (supplierId) {
      const supplier = await context.env.DB.prepare(
        'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?'
      )
        .bind(supplierId, tenantId)
        .first();
      if (!supplier) {
        return new Response(
          JSON.stringify({ error: 'supplier_id does not reference a supplier in this tenant' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const id = generateId();

    const autoIngest = body.auto_ingest === 1 ? 1 : 0;
    const extractTables = body.extract_tables === 0 ? 0 : 1;

    // Renewal period. When the caller says nothing we PROPOSE one from the
    // name: a type that reads as a specification sheet starts at three years,
    // because both major food-safety schemes define a current spec sheet that
    // way. Everything else starts NULL, meaning the annual default applies.
    // The guess is written once into a column an admin can see and change on
    // the Document Types screen — it is never re-derived at read time.
    let renewalIntervalMonths: number | null;
    let renewalPolicy: TypeRenewalPolicy;
    let renewalWindow: RenewalWindow | null;
    if (
      body.renewal_interval_months !== undefined ||
      body.renewal_policy !== undefined ||
      body.renewal_window !== undefined
    ) {
      const parsedMonths = parseRenewalIntervalMonths(body.renewal_interval_months ?? null);
      if (!parsedMonths.ok) {
        return new Response(
          JSON.stringify({ error: parsedMonths.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const parsed = parseTypeRenewalWindowSetting(body.renewal_policy, parsedMonths.value, body.renewal_window);
      if (!parsed.ok) {
        return new Response(
          JSON.stringify({ error: parsed.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      renewalIntervalMonths = parsed.months;
      renewalPolicy = parsed.policy;
      renewalWindow = parsed.window ?? null;
    } else {
      // Nothing submitted: propose both from the name. A COA type starts at
      // 'none' — it does not renew — and a spec sheet at three years. Same
      // contract as before: a guess written once into a setting an admin can
      // see and change, never re-derived on read.
      //
      // ONE helper, shared with every other path that inserts a document type
      // (the starter pack, in the portal and in the CLI). They diverged once
      // already and a tenant seeded by the pack got an annually-renewing COA.
      const proposed = defaultRenewalSettingForTypeName(body.name);
      renewalIntervalMonths = proposed.interval_months;
      renewalPolicy = proposed.policy;
      renewalWindow = proposed.window;
    }

    // The sharing rule (migration 0137, decision C-003). Same contract as the
    // renewal default above: said by the caller, or PROPOSED ONCE from the
    // name and written into a setting an admin can see and change. A name the
    // starting table does not recognise starts at 'qa'.
    let sharingRule: SharingRule;
    if (body.sharing_rule !== undefined && body.sharing_rule !== null && body.sharing_rule !== '') {
      const parsedRule = parseSharingRule(body.sharing_rule);
      if (!parsedRule) {
        return new Response(
          JSON.stringify({ error: 'sharing_rule must be one of: free, qa, locked' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      sharingRule = parsedRule;
    } else {
      sharingRule = defaultSharingRuleForTypeName(body.name);
    }

    // Renewal alert lead time override (0111). Absent or null = inherit the
    // organization's setting, which is what every existing type does.
    let renewalAlertLeadDays: number | null = null;
    if (body.renewal_alert_lead_days !== undefined) {
      const parsedLead = parseRenewalAlertLeadDays(body.renewal_alert_lead_days);
      if (!parsedLead.ok) {
        return new Response(
          JSON.stringify({ error: parsedLead.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      renewalAlertLeadDays = parsedLead.value;
    }

    await context.env.DB.prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, description, supplier_id, active, auto_ingest, extract_tables, renewal_interval_months, renewal_policy,
                                   renewal_alert_lead_days, renewal_alert_lead_updated_at, renewal_alert_lead_updated_by, renewal_window,
                                   sharing_rule)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.name,
        slug,
        body.description || null,
        supplierId,
        autoIngest,
        extractTables,
        renewalIntervalMonths,
        renewalPolicy,
        renewalAlertLeadDays,
        renewalAlertLeadDays,
        renewalAlertLeadDays === null ? null : user.id,
        renewalWindow === null ? null : JSON.stringify(renewalWindow),
        sharingRule
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_type_created',
      'document_type',
      id,
      JSON.stringify({
        name: body.name,
        slug,
        renewal_interval_months: renewalIntervalMonths,
        renewal_policy: renewalPolicy,
        renewal_window: renewalWindow,
        renewal_alert_lead_days: renewalAlertLeadDays,
        sharing_rule: sharingRule,
      }),
      getClientIp(context.request)
    );

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(id)
      .first();

    if (documentType) {
      parseExtractionFields(documentType as Record<string, unknown>);
    }

    return new Response(JSON.stringify({ documentType }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
