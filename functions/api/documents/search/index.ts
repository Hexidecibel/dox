import type { Env, User } from '../../../lib/types';

/**
 * GET /api/documents/search
 * Search documents by title, description, tags, and file content.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const q = url.searchParams.get('q') || '';
    let tenantId = url.searchParams.get('tenantId');
    const category = url.searchParams.get('category');
    const documentTypeId = url.searchParams.get('document_type_id');
    const lotNumber = url.searchParams.get('lot_number');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Non-admins are restricted to their own tenant
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = ['d.status = \'active\''];
    const params: (string | number)[] = [];

    if (q) {
      conditions.push('(d.title LIKE ? OR d.description LIKE ? OR d.tags LIKE ? OR dv.file_name LIKE ? OR dv.extracted_text LIKE ? OR d.lot_number LIKE ? OR d.po_number LIKE ?)');
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }

    if (category) {
      conditions.push('d.category = ?');
      params.push(category);
    }

    if (documentTypeId) {
      conditions.push('d.document_type_id = ?');
      params.push(documentTypeId);
    }

    if (lotNumber) {
      conditions.push('d.lot_number = ?');
      params.push(lotNumber);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total matches
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(DISTINCT d.id) as total FROM documents d
       LEFT JOIN document_versions dv ON dv.document_id = d.id
       ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Fetch matching documents
    const results = await context.env.DB.prepare(
      `SELECT DISTINCT d.*, u.name as creator_name, t.name as tenant_name,
              dt.name as document_type_name, dt.slug as document_type_slug
       FROM documents d
       LEFT JOIN users u ON d.created_by = u.id
       LEFT JOIN tenants t ON d.tenant_id = t.id
       LEFT JOIN document_versions dv ON dv.document_id = d.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       ${whereClause}
       ORDER BY d.updated_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        documents: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
