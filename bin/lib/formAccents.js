/* eslint-disable no-console */
/**
 * What becomes of one Records form's stored accent colour once the tenant brand
 * record ships (migration 0140). Used by bin/report-form-accents; kept here so
 * it can be tested without a database.
 *
 * The RULE is not here: it is `formAccentOrNull` in shared/tenantBrand.ts, read
 * through its esbuild mirror, so this report and the public form page cannot
 * disagree about what is a colour.
 *
 *   none                 nothing stored: brand colour or navy, as before
 *   drawn                #RRGGBB (any case): drawn as before
 *   normalised           #RGB or stray spaces: the same colour, respelled
 *   falls_back           not a colour: the form shows the brand colour or navy
 *   settings_unreadable  the settings are not JSON: treated as falls_back
 */
const { formAccentOrNull, parseBrandColor } = require('./shared/tenantBrand.js');

function classifyFormAccent(settingsRaw) {
  let settings = {};
  try {
    const v = settingsRaw ? JSON.parse(settingsRaw) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) settings = v;
  } catch {
    return { state: 'settings_unreadable', stored: null, drawn: null, has_logo_url: false };
  }
  const hasLogo = typeof settings.logo_url === 'string' && settings.logo_url.trim() !== '';
  const stored = settings.accent_color;
  if (stored === null || stored === undefined || (typeof stored === 'string' && stored.trim() === '')) {
    return { state: 'none', stored: null, drawn: null, has_logo_url: hasLogo };
  }
  const drawn = formAccentOrNull(stored);
  if (drawn === null) return { state: 'falls_back', stored: String(stored), drawn: null, has_logo_url: hasLogo };
  const exact = typeof stored === 'string' && parseBrandColor(stored) !== null;
  return { state: exact ? 'drawn' : 'normalised', stored: String(stored), drawn, has_logo_url: hasLogo };
}

module.exports = { classifyFormAccent };
