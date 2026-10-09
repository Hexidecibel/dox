/**
 * POST / DELETE /api/tenants/:id/brand/logo -- the organisation's logo.
 *
 * POST is multipart with one part named `file`. What the file IS is decided
 * from its bytes (`judgeLogo`: PNG, JPEG or WebP by magic number, 512 KB at
 * most, 16-2000 px a side); the part's own Content-Type and file name are
 * ignored. SVG is refused: it is a document that can carry script, and a logo
 * is drawn on pages outsiders open.
 *
 * A PERSON, NOT AN API KEY. The file is served from a public URL and fetched by
 * the mail clients of people outside the organisation. A key may set the text
 * and colour fields (./index.ts); publishing an image is a signed-in admin.
 *
 * DELETE takes the logo off the brand. The published file stays reachable at
 * its old URL, because mail already sent points at it.
 */

import { getClientIp } from '../../../../lib/db';
import { ForbiddenError, errorToResponse } from '../../../../lib/permissions';
import {
  BrandValidationError,
  removeBrandLogo,
  requireBrandAdmin,
  storeBrandLogo,
  toBrandResponse,
} from '../../../../lib/tenant-brand';
import { BRAND_LOGO_MAX_BYTES } from '../../../../../shared/tenantBrand';
import type { Env, User } from '../../../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function requirePerson(data: Record<string, unknown>): void {
  if (data.authMethod === 'api_key') {
    throw new ForbiddenError('A logo is uploaded or removed by a signed-in administrator, not with an API key');
  }
}

const TOO_LARGE = `The logo is too large (${Math.round(BRAND_LOGO_MAX_BYTES / 1024)} KB at most)`;
const NOT_MULTIPART = 'Send the logo as multipart form data with one part named "file"';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    requireBrandAdmin(user, tenantId);
    requirePerson(context.data);

    // Refuse an obviously oversize body before reading any of it. The slack
    // is the multipart envelope; the exact cap is applied to the file below.
    const declared = Number(context.request.headers.get('Content-Length') ?? '0');
    if (Number.isFinite(declared) && declared > BRAND_LOGO_MAX_BYTES + 16 * 1024) {
      return json({ error: TOO_LARGE }, 413);
    }

    let form: FormData;
    try {
      form = await context.request.formData();
    } catch {
      return json({ error: NOT_MULTIPART }, 400);
    }
    const file = form.get('file') as unknown;
    if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
      return json({ error: NOT_MULTIPART }, 400);
    }
    if ((file as Blob).size > BRAND_LOGO_MAX_BYTES) return json({ error: TOO_LARGE }, 413);

    const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    // The bucket is named here so the exit register sees this file writes to it.
    const brand = await storeBrandLogo({ DB: context.env.DB, FILES: context.env.FILES }, tenantId, bytes, {
      userId: user.id,
      ip: getClientIp(context.request),
    });
    if (!brand) return json({ error: 'Tenant not found' }, 404);
    return json(toBrandResponse(brand));
  } catch (err) {
    if (err instanceof BrandValidationError) return json({ error: err.message }, 400);
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand logo upload error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    requireBrandAdmin(user, tenantId);
    requirePerson(context.data);
    const brand = await removeBrandLogo(context.env.DB, tenantId, {
      userId: user.id,
      ip: getClientIp(context.request),
    });
    if (!brand) return json({ error: 'Tenant not found' }, 404);
    return json(toBrandResponse(brand));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand logo removal error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
