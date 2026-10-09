/**
 * GET /api/public/brand-logo/:token -- an organisation's logo (migration 0140).
 *
 * PUBLIC ON PURPOSE. A logo is drawn in mail and on token pages read by people
 * with no account, so it cannot sit behind a login. It is the ONLY brand value
 * reachable without a token for one of the tenant's own pages, and it reveals
 * nothing but the image: the URL carries a 40-hex token and no tenant id, and
 * the response carries no name.
 *
 * IT CAN ONLY EVER SERVE A LOGO. The whole read is `readBrandLogo`: the token
 * must match a fixed pattern, it is used only to find a row of
 * `tenant_brand_logos`, and the object key is rebuilt from that row rather
 * than taken from anywhere a caller can write. So no document, queue file or
 * any other object in the bucket is reachable from here, whatever the URL
 * says. Registered as `not_exit` in tests/unit/exitRegister.allow.ts.
 *
 * ANYTHING ELSE IS ONE 404: a malformed token, an unknown one, a missing
 * object, a WITHDRAWN logo. A replaced or removed logo still answers at its old
 * URL -- mail that was already sent points at it -- until an admin withdraws it.
 *
 * CACHED FOR A DAY, NOT FOREVER. The token is a hash of the image, so a URL
 * never changes what it returns; but a logo can be withdrawn, and a year's
 * `immutable` cache would keep serving it from every browser and mail proxy
 * that had seen it. One day bounds how long a withdrawal takes to land.
 */

import { readBrandLogo } from '../../../lib/tenant-brand';
import { BRAND_LOGO_CACHE_SECONDS } from '../../../../shared/tenantBrand';
import type { Env } from '../../../lib/types';

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    // The bucket is named HERE, not passed along inside `env`, so the exit
    // register sees this file as one that reaches stored files.
    const logo = await readBrandLogo(
      { DB: context.env.DB, FILES: context.env.FILES },
      String(context.params.token ?? ''),
    );
    if (!logo) return notFound();
    return new Response(logo.body, {
      status: 200,
      headers: {
        // From the validated type stored with the row, never from the upload.
        'Content-Type': logo.contentType,
        'Content-Length': String(logo.size),
        'Cache-Control': `public, max-age=${BRAND_LOGO_CACHE_SECONDS}`,
        ETag: `"${logo.etag}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        // Mail clients and other origins must be able to draw it.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  } catch (err) {
    console.error('Brand logo read error:', err);
    return notFound();
  }
};
