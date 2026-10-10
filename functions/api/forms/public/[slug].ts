/**
 * GET /api/forms/public/:slug
 *
 * Public, unauthenticated read of a form schema for the Typeform-feel
 * renderer at /f/<slug>. Returns the PublicFormView projection — only
 * visible fields, sanitized labels/help text, and the Turnstile site
 * key. We do NOT leak full sheet/column metadata for non-visible
 * columns.
 *
 * A list of the organisation's customers / suppliers / products is sent ONLY
 * for a field whose form builder opted it in, and then as id + name (C-120).
 *
 * 404 returned for: missing slug, not-public, not-live, archived
 * sheet/form, a form and sheet of different tenants, an inactive
 * organisation, Records switched off. Same status and body for every "not
 * available" reason to avoid enumeration of whether a slug exists vs is
 * offline.
 *
 * Every view is rate limited per (form, address) and audited (C-130).
 */
import { logAudit } from '../../../lib/db';
import {
  buildPublicFormView,
  entityKindsReferencedByForm,
  fetchPublicEntityOptions,
  loadLivePublicForm,
} from '../../../lib/records/forms';
import {
  publicClientIp,
  publicNotFound,
  rateLimited,
  takePublicView,
} from '../../../lib/records/publicView';
import { loadPublicBrand } from '../../../lib/tenant-brand';
import type { Env } from '../../../lib/types';

/** A form is opened by many people behind one office address; a scraper is not 120 people. */
const VIEWS_PER_HOUR = 120;

const notFound = () => publicNotFound('Form not found');

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const slug = context.params.slug as string;
    if (!slug) return notFound();

    const found = await loadLivePublicForm(context.env.DB, slug);
    if (!found) return notFound();
    const { form, columns } = found;

    const ip = publicClientIp(context.request);
    if (!(await takePublicView(context.env.DB, 'records_form_view', form.id, ip, VIEWS_PER_HOUR))) {
      return rateLimited();
    }

    // Lists are fetched ONLY for the kinds a field opted in. A form with no
    // opted-in field reads no customer, supplier or product at all.
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

    // The link is a bearer secret and is not written into the log; the form
    // id names what was opened.
    await logAudit(
      context.env.DB,
      null,
      form.tenant_id,
      'records_form.view',
      'records_form',
      form.id,
      JSON.stringify({ fields: view.fields.length, published_lists: [...kinds], ip }),
      ip,
    );

    // The organisation's brand (0140), from the tenant that owns the form.
    const brand = await loadPublicBrand(context.env.DB, form.tenant_id, 'records_form');

    // No brand record: the payload has no `brand` key.
    return new Response(JSON.stringify(brand ? { ...view, brand } : view), {
      headers: {
        'Content-Type': 'application/json',
        // Never `public`: with a field opted in, this body carries the
        // organisation's customer or supplier list, and a shared cache would
        // go on serving it after the builder switched the list off.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Public form fetch error:', err);
    // Don't leak internal errors as 5xx — clients see the same 404 the
    // intentional-not-found case shows. Logs still capture the cause.
    return notFound();
  }
};
