/**
 * The out-of-spec register — every judged test result, and what happened to it.
 *
 * This is the screen a QA buyer is actually paying for. The review-queue warning
 * catches a bad result; this answers the questions that come months later, in
 * front of an auditor: what has come in out of spec, which limit it was judged
 * against at the time, who approved it anyway, and what they said.
 *
 * Read access is any tenant user — the register is evidence, not configuration.
 */

import { logAudit, getClientIp } from '../../lib/db';
import { errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/spec-checks
 *
 * Query: verdict (default 'out_of_spec'), acknowledged ('0' | '1'), document_id,
 * supplier_id, spec_test_id, since (ISO date), limit, offset.
 *
 * Defaults to the view that matters — unacknowledged failures, newest first.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      const t = url.searchParams.get('tenant_id');
      if (t) {
        conditions.push('c.tenant_id = ?');
        params.push(t);
      }
    } else {
      conditions.push('c.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    // 'all' is an explicit opt-in; anything else filters to one verdict, and the
    // default is the failing set.
    const verdict = url.searchParams.get('verdict') ?? 'out_of_spec';
    if (verdict !== 'all') {
      conditions.push('c.verdict = ?');
      params.push(verdict);
    }

    const acknowledged = url.searchParams.get('acknowledged');
    if (acknowledged === '0') conditions.push('c.acknowledged_at IS NULL');
    if (acknowledged === '1') conditions.push('c.acknowledged_at IS NOT NULL');

    for (const [param, column] of [
      ['document_id', 'c.document_id'],
      ['spec_test_id', 'c.spec_test_id'],
      ['supplier_id', 'd.supplier_id'],
    ] as const) {
      const v = url.searchParams.get(param);
      if (v) {
        conditions.push(`${column} = ?`);
        params.push(v);
      }
    }

    const since = url.searchParams.get('since');
    if (since) {
      conditions.push('c.created_at >= ?');
      params.push(since);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM document_spec_checks c
         LEFT JOIN documents d ON d.id = c.document_id
         ${where}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT c.*,
              d.title AS document_title,
              d.supplier_id AS supplier_id,
              s.name AS supplier_name,
              st.name AS spec_test_name,
              u.name AS acknowledged_by_name
         FROM document_spec_checks c
         LEFT JOIN documents d ON d.id = c.document_id
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN spec_tests st ON st.id = c.spec_test_id
         LEFT JOIN users u ON u.id = c.acknowledged_by
         ${where}
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        specChecks: results.results ?? [],
        total: countRow?.total ?? 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List spec checks error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/spec-checks — acknowledge one or more results.
 *
 * Acknowledgement is the ONLY write on this table from the outside, and it never
 * changes a verdict. A person can say "I have seen this and here is why it is
 * acceptable"; nobody can say "this was actually fine". The distinction is the
 * whole value of the register.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const body = (await context.request.json()) as { ids?: string[]; note?: string };

    const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string') : [];
    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: 'ids is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const note = body.note ? sanitizeString(body.note) : null;
    const placeholders = ids.map(() => '?').join(',');

    // Tenant scoping lives in the WHERE clause, so a foreign id in the list is
    // ignored rather than acknowledged.
    const tenantClause = user.role === 'super_admin' ? '' : 'AND tenant_id = ?';
    const tenantParams = user.role === 'super_admin' ? [] : [user.tenant_id!];

    const res = await context.env.DB.prepare(
      `UPDATE document_spec_checks
          SET acknowledged_by = ?,
              acknowledged_at = datetime('now'),
              acknowledgement_note = COALESCE(?, acknowledgement_note)
        WHERE id IN (${placeholders}) ${tenantClause}`
    )
      .bind(user.id, note, ...ids, ...tenantParams)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id ?? null,
      'spec_check.acknowledged',
      'document_spec_checks',
      ids[0],
      JSON.stringify({ count: ids.length, note }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true, acknowledged: res.meta?.changes ?? ids.length }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Acknowledge spec checks error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
