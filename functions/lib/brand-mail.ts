/**
 * The brand in a mail (migration 0140): the header, the footer line, and the
 * three colours a template may use. PURE -- a brand in, strings out.
 *
 * Every mail that leaves the organisation builds its header and its support
 * line HERE, so no template hand-rolls the organisation's name, the navy or a
 * support line again. A template takes `brand?: PublicBrand | null`; the
 * caller gets that object from `loadPublicBrand(db, tenantId, surface,
 * { origin })` and passes it straight through.
 *
 * NO BRAND IS BYTE-IDENTICAL TO BEFORE 0140. With `brand` null every function
 * here returns exactly the markup the templates carried as literals, which
 * tests/unit/brandMail.test.ts pins against output captured before the change
 * (tests/fixtures/brand-mail/pre-0140-golden.json).
 *
 * WHAT A BRAND MAY PAINT: the header band, the buttons, the rule beside a
 * quoted message. NEVER body text -- and the text on a band or a button is
 * black or white, whichever is readable on the tenant's colour.
 *
 * EVERY VALUE IS ESCAPED OR VALIDATED HERE, whatever the caller did. Text goes
 * through `escapeHtml`; a colour goes through `brandPalette`, which hands back
 * `#RRGGBB` or the default and nothing else; a logo URL must be http(s) and end
 * in the logo route's own path or it is dropped.
 */

import { brandPalette, isEmptySupportLine, parseBrandColor, supportLineText } from '../../shared/tenantBrand';
import type { BrandPalette } from '../../shared/tenantBrand';
import type { PublicBrand } from '../../shared/types';

export type MailBrand = PublicBrand | null | undefined;

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The colours a template may use. Navy and white when there is no brand. */
export function mailPalette(brand: MailBrand): BrandPalette {
  return brandPalette(brand?.primary_color ?? null, brand?.accent_color ?? null);
}

const LOGO_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/api\/public\/brand-logo\/[0-9a-f]{40}$/;

/** The absolute logo URL, or null when there is none or it is not ours. */
export function mailLogoUrl(brand: MailBrand): string | null {
  const url = brand?.logo_url;
  return typeof url === 'string' && LOGO_URL.test(url) ? url : null;
}

/** What the organisation is called in this mail. */
export function mailOrganisationName(brand: MailBrand, fallback: string): string {
  return brand ? brand.display_name : fallback;
}

/**
 * The header cell: `<td ...>` to `</td>`, indented to sit inside
 * `    <tr>\n      HERE\n    </tr>`.
 *
 *   no brand        the navy band, `fallbackTitle` in white (as before 0140)
 *   brand, no logo  the band in the tenant's primary colour, display name on
 *                   it in black or white
 *   brand + logo    the logo on WHITE with a rule in the tenant's colour under
 *                   it. White because a logo is drawn for a white page: on a
 *                   coloured band a dark mark disappears and a JPEG becomes a
 *                   white box. The alt text is the display name, styled, so a
 *                   mail client that blocks images still shows who wrote.
 *
 * `subtitleHtml` is ALREADY HTML (the caller escaped its parts).
 */
export function renderMailHeaderCell(
  brand: MailBrand,
  opts: { fallbackTitle: string; subtitleHtml?: string | null },
): string {
  const p = mailPalette(brand);
  const title = escapeHtml(mailOrganisationName(brand, opts.fallbackTitle));
  const subtitle = opts.subtitleHtml ?? null;
  const logo = mailLogoUrl(brand);

  if (brand && logo) {
    return `<td style="background:#ffffff;padding:24px 32px 16px;border-bottom:4px solid ${p.stripe};">
        <img src="${escapeHtml(logo)}" alt="${title}" height="48" style="display:block;height:48px;max-width:260px;width:auto;border:0;outline:none;color:#333333;font-size:20px;font-weight:600;line-height:48px;">${
          subtitle ? `\n        <p style="margin:10px 0 0;color:#555555;font-size:13px;">${subtitle}</p>` : ''
        }
      </td>`;
  }

  const rule = brand && parseBrandColor(brand.accent_color) ? `border-bottom:4px solid ${p.stripe};` : '';
  return `<td style="background:${p.band};padding:24px 32px;${rule}">
        <h1 style="margin:0;color:${p.onBand};font-size:20px;font-weight:600;">${title}</h1>${
          subtitle ? `\n        <p style="margin:6px 0 0;color:${p.onBandMuted};font-size:13px;">${subtitle}</p>` : ''
        }
      </td>`;
}

/**
 * The organisation's own line in the footer: its display name and, when one is
 * set for this surface, the support line. Empty with no brand, so the footer
 * is what it was. Returned WITH its trailing newline and indentation so a
 * template can put it directly in front of its own footer paragraph.
 */
export function renderMailSupportLine(brand: MailBrand): string {
  if (!brand) return '';
  const parts = [`<strong>${escapeHtml(brand.display_name)}</strong>`];
  const s = brand.support;
  if (!isEmptySupportLine(s)) {
    if (s!.text) parts.push(escapeHtml(s!.text));
    if (s!.email) {
      parts.push(`<a href="mailto:${escapeHtml(s!.email)}" style="color:#666666;">${escapeHtml(s!.email)}</a>`);
    }
    if (s!.phone) parts.push(escapeHtml(s!.phone));
  }
  return `<p style="margin:0 0 6px;color:#666666;font-size:12px;text-align:center;">${parts.join(' &middot; ')}</p>
        `;
}

/** The same line for a plain-text body. Empty with no brand. */
export function mailSupportText(brand: MailBrand): string {
  if (!brand) return '';
  const support = supportLineText(brand.support);
  return support ? `${brand.display_name}: ${support}\n` : `${brand.display_name}\n`;
}

/**
 * What dressed a mail, for the audit row of a send whose exact text is
 * recorded: the name, the logo URL and the support line an outsider was shown.
 * Null with no brand.
 */
export function mailBrandAudit(brand: MailBrand): Record<string, unknown> | null {
  if (!brand) return null;
  return {
    display_name: brand.display_name,
    logo_url: mailLogoUrl(brand),
    primary_color: brand.primary_color,
    accent_color: brand.accent_color,
    support: supportLineText(brand.support) || null,
  };
}
