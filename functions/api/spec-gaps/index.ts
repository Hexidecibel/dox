/**
 * What was NOT judged on an approved document (migration 0107) — the other half
 * of the register at /api/spec-checks.
 *
 *   kind=missing_required  a required analyte for the supplier the certificate
 *                          did not report ("incomplete")
 *   kind=unjudged          a printed result with no limit in scope and no
 *                          printed specification ("No limit configured")
 *
 * Read-only: these rows are written at approval and replaced on re-approval.
 * There is nothing to acknowledge on an unjudged result — the fix is a limit —
 * and a missing analyte is resolved by the supplier sending one.
 *
 * Read access is any tenant user, same as the register: evidence, not
 * configuration.
 *
 * GET /api/spec-gaps?kind=&document_id=&supplier_id=&limit=&offset=
 */

import { errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

const KINDS = new Set(['all', 'missing_required', 'unjudged']);

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (user.role === 'super_admin') {
      const t = url.searchParams.get('tenant_id');
      if (t) {
        conditions.push('g.tenant_id = ?');
        params.push(t);
      }
    } else {
      conditions.push('g.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    const kind = url.searchParams.get('kind') ?? 'all';
    if (!KINDS.has(kind)) {
      return new Response(JSON.stringify({ error: "kind must be 'all', 'missing_required' or 'unjudged'" }), {
        status: 400,
        headers,
      });
    }
    if (kind !== 'all') {
      conditions.push('g.kind = ?');
      params.push(kind);
    }
    for (const [param, column] of [
      ['document_id', 'g.document_id'],
      ['supplier_id', 'd.supplier_id'],
    ] as const) {
      const v = url.searchParams.get(param);
      if (v) {
        conditions.push(`${column} = ?`);
        params.push(v);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM document_spec_gaps g LEFT JOIN documents d ON d.id = g.document_id ${where}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const rows = await context.env.DB.prepare(
      `SELECT g.*,
              d.title AS document_title,
              d.supplier_id AS supplier_id,
              s.name AS supplier_name,
              st.name AS spec_test_name
         FROM document_spec_gaps g
         LEFT JOIN documents d ON d.id = g.document_id
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN spec_tests st ON st.id = g.spec_test_id
         ${where}
        ORDER BY g.created_at DESC, g.kind ASC, g.test_name_raw ASC
        LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({ specGaps: rows.results ?? [], total: countRow?.total ?? 0, limit, offset }),
      { headers }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    // A database without 0107 has no gaps to show; say so as an empty list
    // rather than a 500 that takes the document page's spec panel down with it.
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) {
      return new Response(JSON.stringify({ specGaps: [], total: 0, limit: 0, offset: 0 }), { headers });
    }
    console.error('List spec gaps error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers });
  }
};
