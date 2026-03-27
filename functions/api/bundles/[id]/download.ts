import { zipSync } from 'fflate';
import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/bundles/:id/download
 * Download all documents in a bundle as a ZIP file.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // Get all items with their file info
    const items = await context.env.DB.prepare(
      `SELECT bi.*, d.current_version,
              dv.file_name, dv.r2_key, dv.mime_type
       FROM document_bundle_items bi
       INNER JOIN documents d ON bi.document_id = d.id
       LEFT JOIN document_versions dv ON dv.document_id = d.id
         AND dv.version_number = COALESCE(bi.version_number, d.current_version)
       WHERE bi.bundle_id = ?
       ORDER BY bi.sort_order ASC, bi.created_at ASC`
    )
      .bind(bundleId)
      .all();

    if (!items.results || items.results.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Bundle has no items' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Build files object for ZIP
    const files: Record<string, Uint8Array> = {};

    for (const item of items.results) {
      const r2Key = item.r2_key as string;
      if (!r2Key) continue;

      const r2Object = await context.env.FILES.get(r2Key);
      if (!r2Object) continue;

      const buffer = await r2Object.arrayBuffer();

      // Deduplicate file names
      let name = (item.file_name as string) || 'unnamed';
      let counter = 1;
      while (files[name]) {
        const dotIndex = name.lastIndexOf('.');
        if (dotIndex > 0) {
          const base = name.substring(0, dotIndex);
          const ext = name.substring(dotIndex);
          // Remove any previous counter suffix
          const cleanBase = base.replace(/_\d+$/, '');
          name = `${cleanBase}_${counter}${ext}`;
        } else {
          name = `${name}_${counter}`;
        }
        counter++;
      }

      files[name] = new Uint8Array(buffer);
    }

    if (Object.keys(files).length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files could be retrieved' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const zipped = zipSync(files);

    // Sanitize bundle name for filename
    const safeName = (bundle.name as string)
      .replace(/[^a-zA-Z0-9_\-. ]/g, '')
      .trim() || 'bundle';

    return new Response(zipped, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeName}.zip"`,
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Download bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
