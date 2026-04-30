/**
 * Connector slug helpers — Phase B0.5.
 *
 * A connector slug is the globally-unique, URL-safe handle used in
 * vendor-facing addresses: `<slug>@supdox.com`,
 * `https://supdox.com/api/connectors/<slug>/drop`, the future S3 bucket
 * `dox-drops-<slug>`, and the public-link route `/drop/<slug>/<token>`.
 *
 * Shape:
 *   - lowercase
 *   - kebab-case (alphanumeric + `-`)
 *   - starts and ends with [a-z0-9] (no leading/trailing hyphens)
 *   - 1-64 chars
 *
 * Encoded once here (regex + slugify) so the wizard, the create handler,
 * and the slug-or-id resolver all agree on the format. Importable from
 * both Workers (server) and the React bundle (wizard) — pure functions,
 * no runtime imports.
 */

/**
 * Canonical slug regex. The handle must be 1-64 chars, kebab-case,
 * starts/ends alphanumeric. The middle range is `[a-z0-9-]{0,62}` so
 * even the longest slug is exactly 64 chars including the anchored
 * first/last character.
 *
 * Anchored start-and-end so callers don't accidentally substring-match.
 */
export const CONNECTOR_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Slugify a connector name into a URL-safe handle.
 *
 *   - Lowercase
 *   - Any run of non-alphanumeric chars becomes a single `-`
 *   - Leading/trailing `-` trimmed
 *   - Truncated to 64 chars (then re-trimmed in case the truncation
 *     left a trailing `-`)
 *   - Empty / whitespace-only / symbol-only inputs return `""` —
 *     callers MUST treat that as invalid and reject (the regex test
 *     would also fail, but returning empty is the cleaner contract).
 */
export function slugifyConnectorName(name: string): string {
  if (typeof name !== 'string') return '';
  const lowered = name.toLowerCase();
  // Collapse any run of non-[a-z0-9] (including underscores, dots,
  // unicode, whitespace, punctuation) into a single dash.
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  // Strip leading/trailing dashes that the collapse above may have
  // produced.
  const trimmed = dashed.replace(/^-+|-+$/g, '');
  if (trimmed.length === 0) return '';
  // Truncate at 64; a slice that ends on a dash needs a second trim to
  // keep the slug shape valid. (e.g. a 64th char of `-` would fail the
  // regex.)
  const truncated = trimmed.slice(0, 64).replace(/-+$/, '');
  return truncated;
}

/**
 * Validate a string against the canonical connector-slug shape. Used by
 * the create/update handlers to reject invalid user input with a 400.
 */
export function isValidConnectorSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && CONNECTOR_SLUG_REGEX.test(slug);
}
