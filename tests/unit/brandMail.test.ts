/**
 * The brand in a mail (migration 0140).
 *
 *   1. NO BRAND IS BYTE-IDENTICAL. `pre-0140-golden.json` was rendered from
 *      these same inputs by the code as it stood before the brand record
 *      existed. It is a fixture, not a snapshot: nothing regenerates it.
 *   2. A brand reaches the header, the buttons, the footer line and nothing
 *      else, and every character of it is escaped.
 */
import { describe, it, expect } from 'vitest';
import golden from '../fixtures/brand-mail/pre-0140-golden.json';
import { renderOutsideMails, SAMPLE_TENANT } from './brandMailSamples';
import {
  mailBrandAudit,
  mailLogoUrl,
  mailPalette,
  mailSupportText,
  renderMailHeaderCell,
  renderMailSupportLine,
} from '../../functions/lib/brand-mail';
import type { PublicBrand } from '../../shared/types';
import emailSource from '../../functions/lib/email.ts?raw';
import orderSendSource from '../../functions/lib/order-send.ts?raw';
import renewalSource from '../../functions/lib/renewal-request-email.ts?raw';

const LOGO = `https://portal.example/api/public/brand-logo/${'ab12'.repeat(10)}`;

const brand = (over: Partial<PublicBrand> = {}): PublicBrand => ({
  display_name: 'Northfield',
  logo_url: null,
  primary_color: null,
  accent_color: null,
  support: null,
  ...over,
});

const HTML_KEYS = ['export_html', 'order_html', 'order_plain_html', 'renewal_html', 'update_request_html', 'approval_html'] as const;

describe('no brand: every outside mail is what it was before 0140', () => {
  const now = renderOutsideMails();
  for (const key of Object.keys(golden) as (keyof typeof golden)[]) {
    it(`${key} is byte-identical`, () => {
      expect(now[key]).toBe(golden[key]);
    });
  }

  it('brand: null and brand: undefined are the same thing', () => {
    expect(renderOutsideMails({ brand: null })).toEqual(golden);
    expect(renderOutsideMails({ brand: undefined })).toEqual(golden);
  });

  it('the golden really is the old header (a guard on the fixture itself)', () => {
    expect(golden.export_html).toContain(
      `<td style="background:#1A365D;padding:24px 32px;">\n        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${SAMPLE_TENANT}</h1>`,
    );
    expect(golden.update_request_html).toContain('font-weight:600;">SupDox</h1>');
  });
});

describe('a brand in every outside mail', () => {
  const b = brand({
    display_name: 'Northfield Foods',
    logo_url: LOGO,
    primary_color: '#0B6E4F',
    accent_color: '#F2A900',
    support: { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: '+1 (555) 010-2000' },
  });
  const mails = renderOutsideMails({ brand: b });

  for (const key of HTML_KEYS) {
    it(`${key} carries the name, the logo and the support line`, () => {
      const html = mails[key];
      expect(html).toContain(`<img src="${LOGO}" alt="Northfield Foods"`);
      expect(html).toContain('<strong>Northfield Foods</strong>');
      expect(html).toContain('Questions? Ask Purchasing');
      expect(html).toContain('href="mailto:purchasing@northfield.example"');
      expect(html).toContain('+1 (555) 010-2000');
      // The rule under the logo is the accent; the navy is gone from the mail.
      expect(html).toContain('border-bottom:4px solid #F2A900;');
      expect(html).not.toContain('#1A365D');
    });
  }

  it('buttons take the primary colour with readable text on it', () => {
    expect(mails.export_html).toContain('background:#0B6E4F;color:#ffffff;');
    const pale = renderOutsideMails({ brand: brand({ primary_color: '#FFE08A' }) });
    expect(pale.export_html).toContain('background:#FFE08A;color:#000000;');
    // ...and the band, with no logo, is that colour with black on it.
    expect(pale.export_html).toContain('<td style="background:#FFE08A;padding:24px 32px;">');
    expect(pale.export_html).toContain('<h1 style="margin:0;color:#000000;');
  });

  it('a pale primary is never used as link text on white', () => {
    const pale = renderOutsideMails({ brand: brand({ primary_color: '#FFE08A' }) });
    expect(pale.update_request_html).toContain('style="color:#1A365D;"');
    expect(pale.update_request_html).not.toContain('style="color:#FFE08A;"');
  });

  it('body text is never painted', () => {
    const body = mails.export_html.slice(mails.export_html.indexOf('<td style="padding:32px;">'));
    expect(body).toContain('color:#555;');
    // The tenant colour appears as a BACKGROUND (the button), never as a text colour.
    expect(body).toContain('background:#0B6E4F;');
    expect(body).not.toMatch(/[^-]color:#0B6E4F/);
    expect(body).not.toMatch(/[^-]color:#F2A900/);
  });

  it('the update and sign-off mails name the organisation instead of the product', () => {
    const named = renderOutsideMails({ brand: brand({ display_name: 'Northfield Foods' }) });
    expect(named.update_request_html).toContain('font-weight:600;">Northfield Foods</h1>');
    expect(named.approval_html).toContain('font-weight:600;">Northfield Foods</h1>');
  });

  it('the plain-text body carries the support line too', () => {
    expect(mails.export_text.endsWith('Northfield Foods: Questions? Ask Purchasing · purchasing@northfield.example · +1 (555) 010-2000\n')).toBe(true);
  });

  it('a brand with nothing but a name changes the header title and adds one footer line', () => {
    const plain = renderOutsideMails({ brand: brand({ display_name: SAMPLE_TENANT }) });
    expect(plain.export_html).toContain(`<strong>${SAMPLE_TENANT}</strong>`);
    expect(plain.export_html.replace(/<p style="margin:0 0 6px;color:#666666;[^\n]*\n\s*/, '')).toBe(golden.export_html);
  });
});

describe('nothing a tenant types can become markup', () => {
  const hostile = brand({
    display_name: `<script>alert(1)</script>"'&`,
    logo_url: LOGO,
    support: { text: `"><img src=x onerror=alert(2)>`, email: null, phone: null },
  });
  const mails = renderOutsideMails({ brand: hostile });

  for (const key of HTML_KEYS) {
    it(`${key} escapes the display name and the support line`, () => {
      const html = mails[key];
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('onerror=alert(2)>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
      expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
      // The alt attribute is closed by exactly one quote: ours.
      expect(html).toContain('alt="&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;" height="48"');
    });
  }

  it('a colour that is not #RRGGBB never reaches a style attribute', () => {
    for (const bad of ['red', '#fff', '#12345G', '#1A365D;background:url(x)', 'rgb(0,0,0)', ' #1A365D', '#1A365D ', '"><script>']) {
      const cell = renderMailHeaderCell(brand({ primary_color: bad, accent_color: bad }), { fallbackTitle: 'x' });
      expect(cell).toBe(renderMailHeaderCell(brand(), { fallbackTitle: 'x' }));
      expect(mailPalette(brand({ primary_color: bad })).button).toBe('#1A365D');
    }
  });

  it('a logo URL that is not the logo route is dropped, not drawn', () => {
    for (const bad of [
      'https://evil.example/logo.png',
      'javascript:alert(1)',
      `https://portal.example/api/public/brand-logo/${'ab12'.repeat(10)}?x=1`,
      `https://portal.example/api/public/brand-logo/${'ab12'.repeat(10)}" onerror="x`,
      `/api/public/brand-logo/${'ab12'.repeat(10)}`,
      'https://portal.example/api/documents/123/download',
    ]) {
      expect(mailLogoUrl(brand({ logo_url: bad }))).toBeNull();
      expect(renderMailHeaderCell(brand({ logo_url: bad }), { fallbackTitle: 'x' })).not.toContain('<img');
    }
    expect(mailLogoUrl(brand({ logo_url: LOGO }))).toBe(LOGO);
  });

  it('a support email cannot break out of its mailto link', () => {
    const line = renderMailSupportLine(brand({ support: { text: null, email: `a"onmouseover="x@b.example`, phone: null } }));
    expect(line).not.toContain('"onmouseover="');
    expect(line).toContain('mailto:a&quot;onmouseover=&quot;x@b.example');
  });
});

describe('the helper on its own', () => {
  it('no brand: empty footer line, empty text line, null audit', () => {
    expect(renderMailSupportLine(null)).toBe('');
    expect(mailSupportText(undefined)).toBe('');
    expect(mailBrandAudit(null)).toBeNull();
  });

  it('the audit record of a branded send names what the outsider was shown', () => {
    expect(
      mailBrandAudit(brand({ logo_url: LOGO, primary_color: '#0B6E4F', support: { text: 'Call us', email: null, phone: '555 0100' } })),
    ).toEqual({
      display_name: 'Northfield',
      logo_url: LOGO,
      primary_color: '#0B6E4F',
      accent_color: null,
      support: 'Call us · 555 0100',
    });
  });

  it('an accent with no logo is a rule under the band', () => {
    expect(renderMailHeaderCell(brand({ accent_color: '#F2A900' }), { fallbackTitle: 'x' })).toContain(
      '<td style="background:#1A365D;padding:24px 32px;border-bottom:4px solid #F2A900;">',
    );
  });
});

describe('no outside mail hand-rolls its header, its colours or a support line', () => {
  const builders: Array<[string, string, string, string]> = [
    ['buildUpdateRequestEmail', emailSource, 'export function buildUpdateRequestEmail(', 'export function buildApprovalRequestEmail('],
    ['buildApprovalRequestEmail', emailSource, 'export function buildApprovalRequestEmail(', 'export function escapeHtml('],
    ['buildDocumentExportEmail', emailSource, 'export function buildDocumentExportEmail(', 'export function buildExpiredOnArrivalEmail('],
    ['buildOrderDocumentsEmail', orderSendSource, 'export function buildOrderDocumentsEmail(', '// Running the parts'],
    ['buildRenewalRequestSupplierEmail', renewalSource, 'export function buildRenewalRequestSupplierEmail(', '/** One draft waiting for a person'],
  ];

  for (const [name, source, from, to] of builders) {
    it(`${name} takes its header, footer line and colours from the brand helper`, () => {
      const a = source.indexOf(from);
      const b = source.indexOf(to, a);
      expect(a, `${name}: start marker moved`).toBeGreaterThan(-1);
      expect(b, `${name}: end marker moved`).toBeGreaterThan(a);
      const body = source.slice(a, b);
      expect(body).toContain('renderMailHeaderCell(params.brand');
      expect(body).toContain('renderMailSupportLine(params.brand)');
      expect(body).toContain('mailPalette(params.brand)');
      // The navy is the helper's default, not a literal a template carries.
      expect(body).not.toMatch(/#1A365D/i);
    });
  }
});
