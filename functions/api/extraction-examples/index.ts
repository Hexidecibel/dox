import { generateId } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/extraction-examples
 * List extraction examples for a document type.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);

    const documentTypeId = url.searchParams.get('document_type_id');
    if (!documentTypeId) {
      throw new BadRequestError('document_type_id is required');
    }

    let tenantId = url.searchParams.get('tenant_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Non-super_admins are forced to their own tenant
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = ['ee.document_type_id = ?'];
    const params: (string | number)[] = [documentTypeId];

    if (tenantId) {
      conditions.push('ee.tenant_id = ?');
      params.push(tenantId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM extraction_examples ee ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get examples
    const results = await context.env.DB.prepare(
      `SELECT ee.*, u.name as created_by_name
       FROM extraction_examples ee
       LEFT JOIN users u ON ee.created_by = u.id
       ${whereClause}
       ORDER BY ee.created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        examples: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List extraction examples error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/extraction-examples
 * Create a new extraction/training example.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      document_type_id?: string;
      tenant_id?: string;
      input_text?: string;
      ai_output?: string;
      corrected_output?: string;
      score?: number;
      supplier?: string | null;
    };

    if (!body.document_type_id) {
      throw new BadRequestError('document_type_id is required');
    }
    if (!body.input_text) {
      throw new BadRequestError('input_text is required');
    }
    if (!body.ai_output) {
      throw new BadRequestError('ai_output is required');
    }
    if (!body.corrected_output) {
      throw new BadRequestError('corrected_output is required');
    }

    // Determine tenant
    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const id = generateId();
    const score = body.score !== undefined ? body.score : null;
    const supplier = body.supplier !== undefined ? body.supplier : null;

    await context.env.DB.prepare(
      `INSERT INTO extraction_examples (id, document_type_id, tenant_id, input_text, ai_output, corrected_output, score, supplier, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.document_type_id,
        tenantId,
        body.input_text,
        body.ai_output,
        body.corrected_output,
        score,
        supplier,
        user.id
      )
      .run();

    const example = await context.env.DB.prepare(
      'SELECT * FROM extraction_examples WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ example }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create extraction example error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
