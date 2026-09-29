/**
 * Validating the D3 category + regulatory ceiling fields on an analyte
 * (migration 0120), shared by POST and PUT /api/spec-tests.
 *
 * Returns the columns to write, only for fields the body actually carries
 * (absent = leave alone, null = clear), or a 400 message. An unknown category
 * is refused rather than defaulted, for the reason the criticality API refuses
 * an unknown tier: a typo must not quietly un-band a zero-tolerance analyte.
 */

import { isSpecTestCategory, SPEC_TEST_CATEGORIES } from '../../shared/specBand';
import { sanitizeString } from './validation';

export interface CategoryBody {
  category?: unknown;
  regulatory_ceiling_value?: unknown;
  regulatory_ceiling_unit?: unknown;
  regulatory_ceiling_source?: unknown;
  regulatory_band_factor?: unknown;
}

export function parseCategoryFields(
  body: CategoryBody
): { columns: Array<[string, string | number | null]> } | { error: string } {
  const columns: Array<[string, string | number | null]> = [];

  if (body.category !== undefined) {
    if (body.category === null || body.category === '') columns.push(['category', null]);
    else if (isSpecTestCategory(body.category)) columns.push(['category', body.category]);
    else return { error: `category must be one of ${SPEC_TEST_CATEGORIES.join(', ')}, or null` };
  }

  const positive = (key: string, v: unknown, min: number): string | null => {
    if (v === undefined) return null;
    if (v === null || v === '') {
      columns.push([key, null]);
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= min) return `${key} must be a number greater than ${min}`;
    columns.push([key, n]);
    return null;
  };
  const e1 = positive('regulatory_ceiling_value', body.regulatory_ceiling_value, 0);
  if (e1) return { error: e1 };
  const e2 = positive('regulatory_band_factor', body.regulatory_band_factor, 1);
  if (e2) return { error: e2 };

  for (const key of ['regulatory_ceiling_unit', 'regulatory_ceiling_source'] as const) {
    const v = body[key];
    if (v === undefined) continue;
    const s = v == null ? '' : sanitizeString(String(v)).trim();
    columns.push([key, s || null]);
  }
  return { columns };
}
