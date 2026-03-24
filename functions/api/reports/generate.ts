import { logAudit, getClientIp } from '../../lib/db';
import { requireTenantAccess, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

function toCSV(headers: string[], rows: string[][]): string {
  const escape = (val: string) => `"${val.replace(/"/g, '""')}"`;
  const headerLine = headers.map(escape).join(',');
  const dataLines = rows.map((row) => row.map(escape).join(','));
  return [headerLine, ...dataLines].join('\n');
}

interface ReportRow {
  title: string;
  category: string | null;
  tags: string;
  status: string;
  current_version: number;
  file_name: string | null;
  file_size: number | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * POST /api/reports/generate
 * Generate a report of documents matching filters.
 * Returns CSV or JSON format.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    const body = (await context.request.json()) as {
      tenantId?: string;
      category?: string;
      dateFrom?: string;
      dateTo?: string;
      format?: 'csv' | 'json';
    };

    const format = body.format || 'csv';

    // Determine tenant scope
    let tenantId = body.tenantId || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (tenantId) {
      requireTenantAccess(user, tenantId);
    }

    const conditions: string[] = ["d.status != 'deleted'"];
    const params: (string | number)[] = [];

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }

    if (body.category) {
      conditions.push('d.category = ?');
      params.push(body.category);
    }

    if (body.dateFrom) {
      conditions.push('d.created_at >= ?');
      params.push(body.dateFrom);
    }

    if (body.dateTo) {
      conditions.push('d.created_at <= ?');
      params.push(body.dateTo + 'T23:59:59');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT
        d.title,
        d.category,
        d.tags,
        d.status,
        d.current_version,
        dv.file_name,
        dv.file_size,
        u.name as creator_name,
        d.created_at,
        d.updated_at
      FROM documents d
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN document_versions dv ON d.id = dv.document_id AND d.current_version = dv.version_number
      ${whereClause}
      ORDER BY d.updated_at DESC
    `;

    const results = await context.env.DB.prepare(query)
      .bind(...params)
      .all<ReportRow>();

    const rows = results.results || [];

    // Log audit entry
    await logAudit(
      context.env.DB,
      user.id,
      tenantId || user.tenant_id,
      'report.generate',
      'report',
      null,
      JSON.stringify({ format, category: body.category || null, count: rows.length }),
      getClientIp(context.request)
    );

    if (format === 'json') {
      const data = rows.map((r) => ({
        title: r.title,
        category: r.category || '',
        tags: r.tags,
        status: r.status,
        currentVersion: r.current_version,
        fileName: r.file_name || '',
        fileSizeKB: r.file_size ? Math.round(r.file_size / 1024) : 0,
        uploadedBy: r.creator_name || '',
        createdDate: r.created_at,
        lastUpdated: r.updated_at,
      }));

      return new Response(JSON.stringify({ data, total: data.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CSV format
    const headers = [
      'Title',
      'Category',
      'Tags',
      'Status',
      'Current Version',
      'File Name',
      'File Size (KB)',
      'Uploaded By',
      'Created Date',
      'Last Updated',
    ];

    const csvRows = rows.map((r) => {
      let tagsStr = '';
      try {
        const parsed = JSON.parse(r.tags);
        tagsStr = Array.isArray(parsed) ? parsed.join('; ') : r.tags;
      } catch {
        tagsStr = r.tags;
      }

      return [
        r.title,
        r.category || '',
        tagsStr,
        r.status,
        String(r.current_version),
        r.file_name || '',
        r.file_size ? String(Math.round(r.file_size / 1024)) : '0',
        r.creator_name || '',
        r.created_at,
        r.updated_at,
      ];
    });

    const csv = toCSV(headers, csvRows);
    const date = new Date().toISOString().split('T')[0];

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="report-${date}.csv"`,
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
