/**
 * GET /api/forms/public/:slug
 *
 * Public, unauthenticated read of a form schema for the Typeform-feel
 * renderer at /f/<slug>. Returns the PublicFormView projection — only
 * visible fields, sanitized labels/help text, and the Turnstile site
 * key. We do NOT leak full sheet/column metadata for non-visible
 * columns.
 *
 * 404 returned for: missing slug, not-public, not-live, or archived
 * sheet/form. Same status for every "not available" reason to avoid
 * enumeration of whether a slug exists vs is offline.
 */
import {
  buildPublicFormView,
  entityKindsReferencedByForm,
  fetchPublicEntityOptions,
} from '../../../lib/records/forms';
import type { Env } from '../../../lib/types';
import type { RecordColumnRow, RecordFormRow } from '../../../../shared/types';

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Form not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const slug = context.params.slug as string;
    if (!slug) return notFound();

    const form = await context.env.DB.prepare(
      `SELECT f.*
       FROM records_forms f
       JOIN records_sheets s ON f.sheet_id = s.id
       WHERE f.public_slug = ?
         AND f.is_public = 1
         AND f.status = 'live'
         AND f.archived = 0
         AND s.archived = 0`,
    )
      .bind(slug)
      .first<RecordFormRow>();

    if (!form) return notFound();

    const cols = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
      .bind(form.sheet_id)
      .all<RecordColumnRow>();

    const columns = cols.results ?? [];

    // Pre-fetch tenant-scoped entity dropdown options for any visible
    // customer_ref / supplier_ref / product_ref columns. The renderer
    // uses these to render Autocomplete dropdowns instead of falling
    // back to plain text. Forms without entity-ref columns skip this
    // entirely (no extra D1 reads).
    const kinds = entityKindsReferencedByForm(form, columns);
    const entityOptions = await fetchPublicEntityOptions(
      context.env.DB,
      form.tenant_id,
      kinds,
    );

    const view = buildPublicFormView(
      form,
      columns,
      context.env.TURNSTILE_SITE_KEY ?? '',
      entityOptions,
    );

    return new Response(JSON.stringify(view), {
      headers: {
        'Content-Type': 'application/json',
        // Lightly cache so a viral form share doesn't hammer D1, but keep
        // it short — a builder edit shouldn't take long to propagate.
        'Cache-Control': 'public, max-age=30, s-maxage=30',
      },
    });
  } catch (err) {
    console.error('Public form fetch error:', err);
    // Don't leak internal errors as 5xx — clients see the same 404 the
    // intentional-not-found case shows. Logs still capture the cause.
    return notFound();
  }
};
