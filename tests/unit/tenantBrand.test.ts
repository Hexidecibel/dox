/**
 * shared/tenantBrand.ts -- the pure half of the tenant brand record (0140):
 * what a colour is, which text is readable on it, what a logo file is, which
 * support line a surface shows, and what an outsider is handed.
 */
import { describe, it, expect } from 'vitest';
import {
  BRAND_LOGO_MAX_BYTES,
  BRAND_SURFACES,
  brandPalette,
  cleanBrandColor,
  cleanBrandEmail,
  cleanBrandPhone,
  cleanBrandText,
  cleanDisplayName,
  formAccentOrNull,
  hasInvisibleCharacters,
  hasVisibleCharacter,
  normalizeFormAccent,
  stripInvisibleCharacters,
  cleanSupportOverrides,
  contrastRatio,
  isBrandSurface,
  judgeLogo,
  parseBrandColor,
  parseStoredOverrides,
  readableOnWhite,
  readableTextOn,
  resolveSupportLine,
  sniffLogo,
  supportLineText,
  toPublicBrand,
} from '../../shared/tenantBrand';
import { jpegBytes, pngBytes, webpBytes, SVG_BYTES } from '../helpers/brand';

describe('a colour is #RRGGBB and nothing else', () => {
  it('accepts six hex digits and upper-cases them', () => {
    expect(parseBrandColor('#1a365d')).toBe('#1A365D');
    expect(parseBrandColor('#FFFFFF')).toBe('#FFFFFF');
    expect(parseBrandColor('#000000')).toBe('#000000');
  });

  it.each([
    'red',
    '#fff',
    '#1A365',
    '#1A365DD',
    '#1A365DFF',
    '1A365D',
    '#1A365G',
    ' #1A365D',
    '#1A365D ',
    '#1A365D\n',
    '#1A365D;color:red',
    'rgb(26,54,93)',
    'var(--x)',
    'url(javascript:alert(1))',
    '#1A365D"onload="x',
    '',
  ])('refuses %j', (bad) => {
    expect(parseBrandColor(bad)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const bad of [null, undefined, 0x1a365d, ['#1A365D'], { toString: () => '#1A365D' }]) {
      expect(parseBrandColor(bad)).toBeNull();
    }
  });

  it('cleanBrandColor: empty clears, a bad value is an error, never a coercion', () => {
    expect(cleanBrandColor(null, 'Primary colour')).toEqual({ ok: true, value: null });
    expect(cleanBrandColor('', 'Primary colour')).toEqual({ ok: true, value: null });
    expect(cleanBrandColor('#0b6e4f', 'Primary colour')).toEqual({ ok: true, value: '#0B6E4F' });
    const bad = cleanBrandColor('green', 'Primary colour');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('Primary colour');
  });
});

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    // Symmetric.
    expect(contrastRatio('#1A365D', '#FFFFFF')).toBe(contrastRatio('#FFFFFF', '#1A365D'));
  });

  it('picks white on dark and black on light', () => {
    expect(readableTextOn('#1A365D').color).toBe('#ffffff');
    expect(readableTextOn('#000000').color).toBe('#ffffff');
    expect(readableTextOn('#FFE08A').color).toBe('#000000');
    expect(readableTextOn('#FFFFFF').color).toBe('#000000');
  });

  it('EVERY colour has a black or white that reaches 4.5:1 -- so none is refused', () => {
    let worst = 21;
    let worstAt = '';
    const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
    // A 52-step walk of each channel (every 5th value, plus 255): 148,877 colours.
    const steps: number[] = [];
    for (let v = 0; v < 256; v += 5) steps.push(v);
    if (!steps.includes(255)) steps.push(255);
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const c = `#${hex(r)}${hex(g)}${hex(b)}`;
      const ratio = readableTextOn(c).ratio;
      if (ratio < worst) {
        worst = ratio;
        worstAt = c;
      }
    }
    expect(worst, `worst case ${worstAt}`).toBeGreaterThanOrEqual(4.5);
    // The analytic floor is sqrt(21) = 4.583; the walk cannot go under it.
    expect(worst).toBeGreaterThanOrEqual(Math.sqrt(21) - 1e-9);
  });

  it('a pale colour is not text on a white page', () => {
    expect(readableOnWhite('#1A365D')).toBe(true);
    expect(readableOnWhite('#FFE08A')).toBe(false);
    expect(readableOnWhite('#777777')).toBe(false);
    expect(readableOnWhite('#767676')).toBe(true);
  });
});

describe('the palette', () => {
  it('no colours: exactly the literals the templates used before 0140', () => {
    expect(brandPalette(null, null)).toEqual({
      band: '#1A365D',
      onBand: '#ffffff',
      onBandMuted: '#cbd5e0',
      button: '#1A365D',
      onButton: '#ffffff',
      text: '#1A365D',
      stripe: '#1A365D',
      textFellBack: false,
    });
  });

  it('a dark primary paints the band, the button and the text', () => {
    const p = brandPalette('#0b6e4f', '#F2A900');
    expect(p).toMatchObject({ band: '#0B6E4F', onBand: '#ffffff', button: '#0B6E4F', onButton: '#ffffff', text: '#0B6E4F', stripe: '#F2A900', textFellBack: false });
  });

  it('a pale primary paints the band with black on it and leaves text navy', () => {
    const p = brandPalette('#FFE08A', null);
    expect(p).toMatchObject({ band: '#FFE08A', onBand: '#000000', onButton: '#000000', text: '#1A365D', stripe: '#FFE08A', textFellBack: true });
  });

  it('an accent alone moves only the rule', () => {
    expect(brandPalette(null, '#F2A900')).toMatchObject({ band: '#1A365D', button: '#1A365D', text: '#1A365D', stripe: '#F2A900' });
  });

  it('a bad colour is no colour', () => {
    expect(brandPalette('red; x', 'url(x)')).toEqual(brandPalette(null, null));
  });
});

describe('text fields', () => {
  it('stores what was typed, trimmed -- an ampersand or a bracket is a legitimate character', () => {
    expect(cleanBrandText('  Smith & Sons <Dairy>  ', 'Display name', 80)).toEqual({ ok: true, value: 'Smith & Sons <Dairy>' });
    expect(cleanBrandText('', 'Display name', 80)).toEqual({ ok: true, value: null });
    expect(cleanBrandText('   ', 'Display name', 80)).toEqual({ ok: true, value: null });
    expect(cleanBrandText(null, 'Display name', 80)).toEqual({ ok: true, value: null });
  });

  it('refuses a line break, a control character, a non-string and anything too long', () => {
    for (const bad of ['two\nlines', 'tab\there', 'nul\u0000', 'ls x', 'bell\u0007', 'c1\u0085']) {
      expect(cleanBrandText(bad, 'Display name', 80).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(cleanBrandText(42, 'Display name', 80).ok).toBe(false);
    expect(cleanBrandText({ a: 1 }, 'Display name', 80).ok).toBe(false);
    expect(cleanBrandText('x'.repeat(80), 'Display name', 80).ok).toBe(true);
    expect(cleanBrandText('x'.repeat(81), 'Display name', 80).ok).toBe(false);
  });

  it('an email is an address that is safe inside a mailto link', () => {
    expect(cleanBrandEmail('purchasing@northfield.example', 'Email')).toEqual({ ok: true, value: 'purchasing@northfield.example' });
    for (const bad of ['nope', 'a@b', 'a b@c.example', 'a@b.example?subject=x', 'a"x@b.example', '<a@b.example>', 'a@b.example,c@d.example', 'javascript:alert(1)']) {
      expect(cleanBrandEmail(bad, 'Email').ok, bad).toBe(false);
    }
  });

  it('a phone number is digits and punctuation', () => {
    expect(cleanBrandPhone('+1 (555) 010-2000 ext 4', 'Phone').ok).toBe(true);
    for (const bad of ['call us', '12', '555-0100<script>', '555;0100', 'x'.repeat(41)]) {
      expect(cleanBrandPhone(bad, 'Phone').ok, bad).toBe(false);
    }
  });
});

describe('the support line a surface shows', () => {
  const purchasing = { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: '555 0100' };
  const service = { text: 'Customer Service', email: 'care@northfield.example', phone: null };

  it('the default line when a surface has no override', () => {
    expect(resolveSupportLine(purchasing, {}, 'supplier_request')).toEqual(purchasing);
    expect(resolveSupportLine(purchasing, { order_send: service }, 'supplier_request')).toEqual(purchasing);
  });

  it('an override REPLACES the whole line -- it never inherits the default phone', () => {
    expect(resolveSupportLine(purchasing, { order_send: service }, 'order_send')).toEqual(service);
    expect(resolveSupportLine(purchasing, { order_send: { text: 'Sales desk', email: null, phone: null } }, 'order_send')).toEqual({
      text: 'Sales desk',
      email: null,
      phone: null,
    });
  });

  it('an empty override is no override; nothing at all is null', () => {
    expect(resolveSupportLine(purchasing, { order_send: { text: null, email: null, phone: null } }, 'order_send')).toEqual(purchasing);
    expect(resolveSupportLine(null, {}, 'order_send')).toBeNull();
    expect(resolveSupportLine({ text: null, email: null, phone: null }, null, 'alert')).toBeNull();
    expect(resolveSupportLine(null, { alert: service }, 'alert')).toEqual(service);
  });

  it('reads as one sentence', () => {
    expect(supportLineText(purchasing)).toBe('Questions? Ask Purchasing · purchasing@northfield.example · 555 0100');
    expect(supportLineText(service)).toBe('Customer Service · care@northfield.example');
    expect(supportLineText(null)).toBe('');
  });

  it('overrides: an unknown surface is refused on write and dropped on read', () => {
    const typo = cleanSupportOverrides({ suplier_request: service });
    expect(typo.ok).toBe(false);
    const good = cleanSupportOverrides({ supplier_request: service, alert: { text: '', email: null } });
    expect(good).toEqual({ ok: true, value: { supplier_request: service } });
    expect(cleanSupportOverrides([service]).ok).toBe(false);
    expect(cleanSupportOverrides({ alert: { text: 'x', email: 'not an address' } }).ok).toBe(false);

    expect(parseStoredOverrides(JSON.stringify({ suplier_request: service, alert: service, order_send: { email: 'bad' } }))).toEqual({ alert: service });
    expect(parseStoredOverrides('{not json')).toEqual({});
    expect(parseStoredOverrides(null)).toEqual({});
    expect(parseStoredOverrides('[1,2]')).toEqual({});
  });

  it('every surface key is a plain identifier, unique, and labelled', () => {
    const keys = BRAND_SURFACES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of BRAND_SURFACES) {
      expect(s.key).toMatch(/^[a-z][a-z_]{2,39}$/);
      expect(s.label.length).toBeGreaterThan(3);
      expect(isBrandSurface(s.key)).toBe(true);
    }
    expect(isBrandSurface('complaint_intake')).toBe(false);
    expect(isBrandSurface('__proto__')).toBe(false);
    expect(isBrandSurface('constructor')).toBe(false);
  });
});

describe('what an outsider is handed', () => {
  const token = 'c0ffee'.repeat(6) + 'c0ff';
  const source = {
    display_name: 'Northfield Foods',
    primary_color: '#0B6E4F',
    accent_color: null,
    logo_path: `/api/public/brand-logo/${token}`,
    support: { text: 'Default', email: null, phone: null },
    support_overrides: { order_send: { text: 'Sales desk', email: null, phone: null } },
    // Things a wider row might carry. None may come out.
    tenant_id: 'tenant-secret',
    updated_by_name: 'Internal Person',
    internal_note: 'do not share',
  };

  it('is five named fields and nothing else', () => {
    const pub = toPublicBrand(source, 'order_send');
    expect(Object.keys(pub).sort()).toEqual(['accent_color', 'display_name', 'logo_url', 'primary_color', 'support']);
    expect(JSON.stringify(pub)).not.toContain('tenant-secret');
    expect(JSON.stringify(pub)).not.toContain('Internal Person');
    expect(JSON.stringify(pub)).not.toContain('do not share');
  });

  it('carries ONE support line: this surface, never the others', () => {
    expect(toPublicBrand(source, 'order_send').support?.text).toBe('Sales desk');
    expect(JSON.stringify(toPublicBrand(source, 'order_send'))).not.toContain('Default');
    expect(toPublicBrand(source, 'alert').support?.text).toBe('Default');
    expect(JSON.stringify(toPublicBrand(source, 'alert'))).not.toContain('Sales desk');
  });

  it('the logo is a path on a page and an absolute URL in a mail', () => {
    expect(toPublicBrand(source, 'alert').logo_url).toBe(`/api/public/brand-logo/${token}`);
    expect(toPublicBrand(source, 'alert', 'https://portal.example/').logo_url).toBe(`https://portal.example/api/public/brand-logo/${token}`);
  });

  it('a logo path that is not the logo route, and a colour that is not a colour, do not come out', () => {
    for (const bad of ['/api/documents/1/download', 'https://evil.example/x.png', `/api/public/brand-logo/${token}/../x`, '/api/public/brand-logo/short']) {
      expect(toPublicBrand({ ...source, logo_path: bad }, 'alert').logo_url).toBeNull();
    }
    expect(toPublicBrand({ ...source, primary_color: 'red' }, 'alert').primary_color).toBeNull();
  });
});

describe('what a logo file is: the bytes, not the label', () => {
  it('reads PNG, JPEG and WebP with their size', () => {
    expect(sniffLogo(pngBytes(320, 96))).toEqual({ contentType: 'image/png', extension: 'png', width: 320, height: 96 });
    expect(sniffLogo(jpegBytes(400, 120))).toEqual({ contentType: 'image/jpeg', extension: 'jpg', width: 400, height: 120 });
    expect(sniffLogo(webpBytes(256, 64, 'VP8X'))).toEqual({ contentType: 'image/webp', extension: 'webp', width: 256, height: 64 });
    expect(sniffLogo(webpBytes(256, 64, 'VP8L'))).toEqual({ contentType: 'image/webp', extension: 'webp', width: 256, height: 64 });
    expect(sniffLogo(webpBytes(256, 64, 'VP8 '))).toEqual({ contentType: 'image/webp', extension: 'webp', width: 256, height: 64 });
  });

  it('SVG is refused, however it starts', () => {
    expect(sniffLogo(SVG_BYTES)).toBeNull();
    const withProlog = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffLogo(withProlog)).toBeNull();
    const verdict = judgeLogo(SVG_BYTES);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.error).toContain('SVG is not accepted');
  });

  it('refuses HTML, a PDF, a GIF, a truncated header and an animated WebP', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffLogo(enc('<!DOCTYPE html><html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffLogo(enc('%PDF-1.7\n'))).toBeNull();
    expect(sniffLogo(enc('GIF89a' + '\u0001'.repeat(40)))).toBeNull();
    expect(sniffLogo(pngBytes(320, 96).slice(0, 12))).toBeNull();
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(sniffLogo(webpBytes(256, 64, 'VP8X', { animated: true }))).toBeNull();
    expect(sniffLogo(new Uint8Array(0))).toBeNull();
  });

  it('judges byte size and pixel size', () => {
    expect(judgeLogo(pngBytes(320, 96)).ok).toBe(true);
    expect(judgeLogo(new Uint8Array(0)).ok).toBe(false);
    const big = pngBytes(320, 96, BRAND_LOGO_MAX_BYTES + 1);
    expect(big.length).toBe(BRAND_LOGO_MAX_BYTES + 1);
    const tooBig = judgeLogo(big);
    expect(!tooBig.ok && tooBig.error).toContain('512 KB');
    expect(judgeLogo(pngBytes(320, 96, BRAND_LOGO_MAX_BYTES)).ok).toBe(true);
    expect(judgeLogo(pngBytes(8, 8)).ok).toBe(false);
    expect(judgeLogo(pngBytes(16, 16)).ok).toBe(true);
    expect(judgeLogo(pngBytes(2000, 2000)).ok).toBe(true);
    expect(judgeLogo(pngBytes(2001, 100)).ok).toBe(false);
    expect(judgeLogo(pngBytes(100, 40000)).ok).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// After the independent review (2026-10-08)
// ---------------------------------------------------------------------------

const cp = (n: number) => String.fromCodePoint(n);

describe('invisible and direction-changing characters are refused in every brand text field', () => {
  // Written as code points so no editor or tool can lose them.
  const HOSTILE: Array<[string, number]> = [
    ['zero width space', 0x200b],
    ['zero width non-joiner', 0x200c],
    ['zero width joiner', 0x200d],
    ['left-to-right mark', 0x200e],
    ['right-to-left mark', 0x200f],
    ['left-to-right embedding', 0x202a],
    ['right-to-left embedding', 0x202b],
    ['pop directional formatting', 0x202c],
    ['left-to-right override', 0x202d],
    ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['word joiner', 0x2060],
    ['invisible times', 0x2062],
    ['left-to-right isolate', 0x2066],
    ['right-to-left isolate', 0x2067],
    ['pop directional isolate', 0x2069],
    ['zero width no-break space', 0xfeff],
    ['Hangul filler', 0x3164],
    ['Hangul choseong filler', 0x115f],
    ['Hangul jungseong filler', 0x1160],
    ['halfwidth Hangul filler', 0xffa0],
    ['soft hyphen', 0x00ad],
    ['Arabic letter mark', 0x061c],
    ['braille blank', 0x2800],
    ['Mongolian vowel separator', 0x180e],
    ['tag space', 0xe0020],
  ];

  it.each(HOSTILE)('%s (U+%s) is refused in the middle of a display name and of a support line', (_name, code) => {
    const text = `North${cp(code)}field`;
    expect(hasInvisibleCharacters(text)).toBe(true);
    for (const result of [cleanDisplayName(text), cleanBrandText(text, 'Support line text', 200)]) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain('invisible or text-direction character');
    }
    // At the very front it is refused too -- or, for the one of these that
    // JavaScript counts as white space (U+FEFF), trimmed away. Either way it
    // is never in what is stored.
    const leading = cleanBrandText(`${cp(code)}Northfield`, 'Support line text', 200);
    expect(leading.ok ? leading.value : 'Northfield').toBe('Northfield');
    expect(stripInvisibleCharacters(text)).toBe('Northfield');
  });

  it('a name that would draw backwards in an inbox is refused', () => {
    // U+202E in front: "moc.elpmaxe" reads "example.com" on screen.
    expect(cleanDisplayName(`${cp(0x202e)}moc.elpmaxe`).ok).toBe(false);
  });

  it('a display name must have a letter or digit somebody can see', () => {
    for (const blank of [cp(0x3164), cp(0x200b), `${cp(0x3164)}${cp(0x3164)}`, '...', '---', '***', '"\'"']) {
      expect(cleanDisplayName(blank).ok, JSON.stringify(blank)).toBe(false);
    }
    const symbols = cleanDisplayName('---');
    expect(!symbols.ok && symbols.error).toBe('Display name must contain at least one letter or digit');
    for (const fine of ['Northfield Foods', 'A', '7', 'Smith & Sons <Dairy>', 'Søndergård A/S', '北田食品', 'Ünal Süt 24']) {
      expect(cleanDisplayName(fine)).toEqual({ ok: true, value: fine });
    }
    expect(cleanDisplayName('')).toEqual({ ok: true, value: null });
    expect(cleanDisplayName(null)).toEqual({ ok: true, value: null });
    expect(cleanDisplayName('x'.repeat(81)).ok).toBe(false);
  });

  it('a support line may be punctuation; it may not be invisible', () => {
    expect(cleanBrandText('---', 'Support line text', 200).ok).toBe(true);
    expect(cleanBrandText(cp(0x3164), 'Support line text', 200).ok).toBe(false);
  });

  it('hasVisibleCharacter ignores what cannot be seen', () => {
    expect(hasVisibleCharacter('Northfield')).toBe(true);
    expect(hasVisibleCharacter(`${cp(0x3164)}${cp(0x115f)}${cp(0xffa0)}`)).toBe(false);
    expect(hasVisibleCharacter(`${cp(0x200b)} ${cp(0x202e)}`)).toBe(false);
    expect(hasVisibleCharacter('')).toBe(false);
  });

  it('ordinary accents, scripts and symbols are not caught', () => {
    for (const fine of ['Crème & Co.', 'Ελληνικά', 'Привет', 'مرحبا', 'שלום', '日本語', 'Ñandú 100%', "O'Brien (Dairy) #2"]) {
      expect(hasInvisibleCharacters(fine), fine).toBe(false);
    }
  });
});

describe('an animated PNG is not a logo', () => {
  it('a PNG with an acTL chunk is refused, as an animated WebP is', () => {
    expect(sniffLogo(pngBytes(320, 96, 400))).toEqual({ contentType: 'image/png', extension: 'png', width: 320, height: 96 });
    expect(sniffLogo(pngBytes(320, 96, 400, 0, { animated: true }))).toBeNull();
    const verdict = judgeLogo(pngBytes(320, 96, 400, 0, { animated: true }));
    expect(verdict.ok).toBe(false);
  });

  it('a PNG whose chunks never reach the image data is not an image', () => {
    expect(sniffLogo(pngBytes(320, 96, undefined, 0, { noData: true }))).toBeNull();
    // A header with bytes after it that are not chunks at all.
    const junk = new Uint8Array(200);
    junk.set(pngBytes(320, 96).slice(0, 33), 0);
    for (let i = 33; i < junk.length; i += 1) junk[i] = 0xee;
    expect(sniffLogo(junk)).toBeNull();
  });

  it('an acTL after the image data does not animate anything and is not what is tested for', () => {
    const still = pngBytes(320, 96, 400);
    // The walk stops at IDAT; what follows is not read.
    expect(sniffLogo(still)).not.toBeNull();
  });
});

describe("a form's own accent colour", () => {
  it('a hex colour of three or six digits, any case, is normalised to #RRGGBB', () => {
    expect(normalizeFormAccent('#1a365d')).toEqual({ ok: true, value: '#1A365D' });
    expect(normalizeFormAccent('#1A365D')).toEqual({ ok: true, value: '#1A365D' });
    expect(normalizeFormAccent('#abc')).toEqual({ ok: true, value: '#AABBCC' });
    expect(normalizeFormAccent('#F0a')).toEqual({ ok: true, value: '#FF00AA' });
    expect(normalizeFormAccent('  #abc  ')).toEqual({ ok: true, value: '#AABBCC' });
  });

  it('empty is none', () => {
    for (const none of [null, undefined, '', '   ']) expect(normalizeFormAccent(none)).toEqual({ ok: true, value: null });
  });

  it.each(['red', 'navy', '1A365D', '#1A365', '#1A365DFF', '#12', '#ggg', 'rgb(0,0,0)', '#abc; background:url(x)', 'var(--x)'])(
    '%j is refused with a message, never guessed at',
    (bad) => {
      const r = normalizeFormAccent(bad);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('hex colour');
      expect(formAccentOrNull(bad)).toBeNull();
    },
  );

  it('a value that is not a string is refused', () => {
    expect(normalizeFormAccent(0xabc).ok).toBe(false);
    expect(normalizeFormAccent(['#abc']).ok).toBe(false);
  });
});
