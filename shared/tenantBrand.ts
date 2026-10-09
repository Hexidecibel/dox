/**
 * The tenant brand record (migration 0140) -- everything about it that is
 * PURE: what a colour is, which text is readable on it, what a logo file is,
 * which support line a surface shows, and the allow-list projection an
 * outsider is given.
 *
 * Nothing here reads a database, a bucket or a request. The loader is
 * `functions/lib/tenant-brand.ts`; the mail renderer is
 * `functions/lib/brand-mail.ts`; the page renderer is `src/components/brand/`.
 * All three import the palette and the support-line resolution from here, so a
 * mail header and a page header cannot disagree about a colour.
 *
 * THE THREE RULES THAT MAKE THIS SAFE TO PUT IN FRONT OF OUTSIDERS
 *
 *   1. A colour is `#RRGGBB` and nothing else. `parseBrandColor` is the only
 *      way a stored value reaches a style attribute, and it is applied on
 *      WRITE and again on READ, so a row edited by hand cannot inject either.
 *   2. A tenant colour never becomes body text. It paints the header band,
 *      the buttons and the accent rule; the text ON them is black or white,
 *      whichever is readable (`readableTextOn`). Used as link text on a white
 *      page it must reach 4.5:1 against white or the default navy is used.
 *   3. An outsider is handed `PublicBrand` and only `PublicBrand`
 *      (`toPublicBrand` names every field; it never spreads a row). A column
 *      added to `tenant_brands` later stays private until it is added here.
 */

import type { BrandSupportLine, PublicBrand } from './types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const BRAND_DISPLAY_NAME_MAX = 80;
export const BRAND_SUPPORT_TEXT_MAX = 200;
export const BRAND_SUPPORT_EMAIL_MAX = 254;
export const BRAND_SUPPORT_PHONE_MAX = 40;

/** 512 KB. A logo is drawn about 48 px tall; anything larger is a photograph. */
export const BRAND_LOGO_MAX_BYTES = 512 * 1024;
export const BRAND_LOGO_MIN_PIXELS = 16;
export const BRAND_LOGO_MAX_PIXELS = 2000;

/** Logo uploads one organisation may attempt in an hour (all of them count). */
export const BRAND_LOGO_UPLOADS_PER_HOUR = 20;
/**
 * Logos one organisation may keep published at once, the current one included.
 * Past logos stay reachable for mail already sent, so they are not free: at the
 * cap an admin withdraws one before another new image is accepted. Nothing is
 * ever withdrawn automatically.
 */
export const BRAND_LOGO_RETAINED_MAX = 10;
export const BRAND_WITHDRAW_REASON_MAX = 300;
/** How long a browser or a mail proxy may keep a logo: a withdrawal lands within a day. */
export const BRAND_LOGO_CACHE_SECONDS = 86400;

/** The navy every outside page and mail used before a tenant could choose. */
export const DEFAULT_BRAND_COLOR = '#1A365D';

/** WCAG 2.x AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * Every place an outsider meets the organisation, as far as the support line
 * is concerned. A page and the mail that points at it are ONE surface: the
 * person reading the request email and the person on the request page are the
 * same person and should be given the same contact.
 *
 * ADDING A SURFACE IS A LINE HERE, NOT A MIGRATION: overrides are stored as
 * one JSON object keyed by these strings (`tenant_brands.support_overrides`).
 * Complaint intake adds `complaint_intake` and nothing else changes.
 */
export const BRAND_SURFACES = [
  {
    key: 'supplier_request',
    label: 'Supplier requests',
    description: 'The request page a supplier uploads to, and the renewal request email that points at it.',
  },
  {
    key: 'document_export',
    label: 'Documents sent from search',
    description: 'The "here are the documents you asked for" email and the page its link opens.',
  },
  {
    key: 'order_send',
    label: 'Order documents',
    description: 'The email that carries the certificates for an order, and the page for a file too large to attach.',
  },
  {
    key: 'alert',
    label: 'Alert pages',
    description: 'The no-login page an alerted owner opens from a renewal or out-of-spec email.',
  },
  {
    key: 'records_form',
    label: 'Public forms',
    description: 'A Records intake form anybody with the link can fill in.',
  },
  {
    key: 'records_update_request',
    label: 'Update requests',
    description: 'The "please update this row" email and the form it opens.',
  },
  {
    key: 'records_approval',
    label: 'Sign-off requests',
    description: 'The approval email of a Records workflow and the page it opens.',
  },
  {
    key: 'file_drop',
    label: 'File drop pages',
    description: 'The upload page of a source that takes files through a public link.',
  },
] as const;

export type BrandSurface = (typeof BRAND_SURFACES)[number]['key'];

const SURFACE_KEYS: ReadonlySet<string> = new Set(BRAND_SURFACES.map((s) => s.key));

export function isBrandSurface(value: unknown): value is BrandSurface {
  return typeof value === 'string' && SURFACE_KEYS.has(value);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * `#RRGGBB`, upper-cased, or null. No `#RGB`, no alpha, no names, no `rgb()`,
 * no surrounding whitespace: this string is interpolated into `style="..."` in
 * HTML mail, so the test is "exactly seven characters from a fixed alphabet".
 */
export function parseBrandColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!HEX_COLOR.test(raw)) return null;
  return raw.toUpperCase();
}

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a `#RRGGBB` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ReadableText {
  /** `#ffffff` or `#000000`. */
  color: '#ffffff' | '#000000';
  ratio: number;
}

/**
 * Black or white, whichever reads better on `background`.
 *
 * THERE IS NO COLOUR THIS FAILS ON. The worse of the two ratios is highest
 * when they are equal, at a luminance of sqrt(1.05 * 0.05) - 0.05 = 0.179,
 * where both are 4.58:1 -- above the 4.5:1 AA line. So every `#RRGGBB` has a
 * readable black or white, and a primary colour is never refused for contrast
 * (tests/unit/tenantBrand.test.ts walks the colour cube to pin it).
 */
export function readableTextOn(background: string): ReadableText {
  const white = contrastRatio(background, '#FFFFFF');
  const black = contrastRatio(background, '#000000');
  return white >= black ? { color: '#ffffff', ratio: white } : { color: '#000000', ratio: black };
}

/** May this colour be used as TEXT on a white page (a link, a small heading)? */
export function readableOnWhite(color: string): boolean {
  return contrastRatio(color, '#FFFFFF') >= MIN_TEXT_CONTRAST;
}

export interface BrandPalette {
  /** Header band background. */
  band: string;
  /** Text on the band. */
  onBand: string;
  /** The smaller line under the name on the band. */
  onBandMuted: string;
  /** Button background and the text on it. */
  button: string;
  onButton: string;
  /** Brand colour used AS TEXT on a white page: links, the small name line. */
  text: string;
  /** The rule beside a quoted message, and under a branded band. */
  stripe: string;
  /** True when `primary` was too pale to be text on white and navy stands in. */
  textFellBack: boolean;
}

/**
 * The one place a brand's two colours become the colours a surface draws.
 * With neither set this returns EXACTLY the literals the templates used before
 * 0140 (lower-case `#ffffff`, `#cbd5e0`), which is what makes the no-brand
 * mail byte-identical.
 */
export function brandPalette(primaryRaw: unknown, accentRaw: unknown): BrandPalette {
  const primary = parseBrandColor(primaryRaw);
  const accent = parseBrandColor(accentRaw);
  if (!primary) {
    return {
      band: DEFAULT_BRAND_COLOR,
      onBand: '#ffffff',
      onBandMuted: '#cbd5e0',
      button: DEFAULT_BRAND_COLOR,
      onButton: '#ffffff',
      text: DEFAULT_BRAND_COLOR,
      stripe: accent ?? DEFAULT_BRAND_COLOR,
      textFellBack: false,
    };
  }
  const on = readableTextOn(primary).color;
  const asText = readableOnWhite(primary);
  return {
    band: primary,
    onBand: on,
    onBandMuted: on,
    button: primary,
    onButton: on,
    text: asText ? primary : DEFAULT_BRAND_COLOR,
    stripe: accent ?? primary,
    textFellBack: !asText,
  };
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

/** C0 controls (including CR, LF and TAB), DEL and the C1 block. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

// Deliberately narrower than the RFC: this address is written into a `mailto:`
// link on pages and in mail, so the local part is letters, digits and . _ % + -
// only (no `?`, `&`, quotes or anything else that means something in a URL).
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE = /^[0-9+()\-. #xXeEtT]+$/;

export type FieldResult = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Characters that take up no space, or change the direction text is drawn in.
 * Written as code points, not as literals, so no editor or tool can lose them.
 *
 * WHY THEY ARE REFUSED. A display name becomes the From name and the subject
 * of mail. U+202E in front of a name draws it backwards in an inbox; U+200B or
 * a Hangul filler on its own is a sender with no name at all. None of these
 * has a use in a company name or a support line.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong / jungseong fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels (invisible)
  [0x180b, 0x180f], // Mongolian free variation selectors, vowel separator
  [0x200b, 0x200f], // zero width space / joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x2800, 0x2800], // braille pattern blank
  [0x3164, 0x3164], // Hangul filler
  [0xfeff, 0xfeff], // zero width no-break space / BOM
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff9, 0xfffb], // interlinear annotation
  [0x1d173, 0x1d17a], // musical formatting
  [0xe0000, 0xe007f], // tags
];

const hex = (n: number) => n.toString(16);
const INVISIBLE_CLASS = INVISIBLE_RANGES.map(([from, to]) =>
  from === to ? `\\u{${hex(from)}}` : `\\u{${hex(from)}}-\\u{${hex(to)}}`,
).join('');
/** Any invisible or direction-changing character, plus the whole Cf category. */
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}\\p{Cf}]`, 'u');
const INVISIBLE_ALL = new RegExp(`[${INVISIBLE_CLASS}\\p{Cf}]`, 'gu');
const VISIBLE = /[\p{L}\p{N}]/u;

/** Does this text carry an invisible or direction-changing character? */
export function hasInvisibleCharacters(text: string): boolean {
  return INVISIBLE.test(text);
}

/** The text with every such character taken out. */
export function stripInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_ALL, '');
}

/** Does it contain at least one letter or digit a reader can see? */
export function hasVisibleCharacter(text: string): boolean {
  return VISIBLE.test(stripInvisibleCharacters(text));
}

/**
 * One line of text a person typed, to be shown to outsiders. Stored AS TYPED
 * (an ampersand or an angle bracket is a legitimate character in a company
 * name) and escaped wherever it is drawn. What is refused:
 *
 *   - anything that is not one line (a control character, a line break);
 *   - an invisible or direction-changing character (see INVISIBLE_RANGES);
 *   - anything too long;
 *   - with `requireVisible` (the display name): text with no letter or digit.
 *
 * Empty means "not set".
 */
export function cleanBrandText(
  raw: unknown,
  label: string,
  max: number,
  opts: { requireVisible?: boolean } = {},
): FieldResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be text` };
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: `${label} must be a single line of plain text` };
  if (hasInvisibleCharacters(value)) {
    return { ok: false, error: `${label} contains an invisible or text-direction character; type it again as plain text` };
  }
  if (value.length > max) return { ok: false, error: `${label} is too long (${max} characters at most)` };
  if (opts.requireVisible && !VISIBLE.test(value)) {
    return { ok: false, error: `${label} must contain at least one letter or digit` };
  }
  return { ok: true, value };
}

/** The display name: brand text that must also be readable as a name. */
export function cleanDisplayName(raw: unknown, label = 'Display name'): FieldResult {
  return cleanBrandText(raw, label, BRAND_DISPLAY_NAME_MAX, { requireVisible: true });
}

export function cleanBrandEmail(raw: unknown, label: string): FieldResult {
  const text = cleanBrandText(raw, label, BRAND_SUPPORT_EMAIL_MAX);
  if (!text.ok || text.value === null) return text;
  if (!EMAIL.test(text.value)) return { ok: false, error: `${label} is not an email address` };
  return text;
}

export function cleanBrandPhone(raw: unknown, label: string): FieldResult {
  const text = cleanBrandText(raw, label, BRAND_SUPPORT_PHONE_MAX);
  if (!text.ok || text.value === null) return text;
  if (!PHONE.test(text.value) || (text.value.match(/[0-9]/g) ?? []).length < 3) {
    return { ok: false, error: `${label} is not a phone number` };
  }
  return text;
}

export type ColorResult = { ok: true; value: string | null } | { ok: false; error: string };

/** null / '' clears; anything else must be `#RRGGBB`. Never coerced. */
export function cleanBrandColor(raw: unknown, label: string): ColorResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const color = parseBrandColor(raw);
  if (!color) return { ok: false, error: `${label} must be a six-digit hex colour such as #1A365D` };
  return { ok: true, value: color };
}

// ---------------------------------------------------------------------------
// Support line
// ---------------------------------------------------------------------------

export const EMPTY_SUPPORT_LINE: BrandSupportLine = { text: null, email: null, phone: null };

export function isEmptySupportLine(line: BrandSupportLine | null | undefined): boolean {
  return !line || (!line.text && !line.email && !line.phone);
}

export type SupportLineResult = { ok: true; value: BrandSupportLine | null } | { ok: false; error: string };

/** Validate one support line (the default or one override). All-empty = null. */
export function cleanSupportLine(raw: unknown, label: string): SupportLineResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${label} must be an object` };
  const r = raw as Record<string, unknown>;
  const text = cleanBrandText(r.text, `${label} text`, BRAND_SUPPORT_TEXT_MAX);
  if (!text.ok) return text;
  const email = cleanBrandEmail(r.email, `${label} email`);
  if (!email.ok) return email;
  const phone = cleanBrandPhone(r.phone, `${label} phone`);
  if (!phone.ok) return phone;
  const line: BrandSupportLine = { text: text.value, email: email.value, phone: phone.value };
  return { ok: true, value: isEmptySupportLine(line) ? null : line };
}

export type OverridesResult =
  | { ok: true; value: Partial<Record<BrandSurface, BrandSupportLine>> }
  | { ok: false; error: string };

/**
 * The per-surface overrides. An unknown surface is REFUSED rather than stored:
 * a typo would otherwise sit in the record looking like configuration and
 * never be shown anywhere.
 */
export function cleanSupportOverrides(raw: unknown): OverridesResult {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'support_overrides must be an object keyed by surface' };
  }
  const out: Partial<Record<BrandSurface, BrandSupportLine>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBrandSurface(key)) return { ok: false, error: `Unknown surface "${key.slice(0, 40)}"` };
    const label = BRAND_SURFACES.find((s) => s.key === key)?.label ?? key;
    const line = cleanSupportLine(value, `${label} support line`);
    if (!line.ok) return line;
    if (line.value) out[key] = line.value;
  }
  return { ok: true, value: out };
}

/**
 * Stored overrides, read back. Anything that does not validate is DROPPED, so
 * a row edited by hand can make an override disappear but never put an
 * unvalidated string in front of an outsider.
 */
export function parseStoredOverrides(json: string | null | undefined): Partial<Record<BrandSurface, BrandSupportLine>> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<BrandSurface, BrandSupportLine>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBrandSurface(key)) continue;
    const line = cleanSupportLine(value, key);
    if (line.ok && line.value) out[key] = line.value;
  }
  return out;
}

/**
 * The support line one surface shows.
 *
 * AN OVERRIDE REPLACES THE WHOLE LINE, it is not merged field by field: a
 * complaints page that says "Customer Service" must not inherit Purchasing's
 * phone number because nobody typed one. No override (or an empty one) falls
 * back to the default line; no default either is null and nothing is drawn.
 */
export function resolveSupportLine(
  defaultLine: BrandSupportLine | null | undefined,
  overrides: Partial<Record<string, BrandSupportLine>> | null | undefined,
  surface: BrandSurface | null | undefined,
): BrandSupportLine | null {
  const override = surface ? overrides?.[surface] : null;
  if (!isEmptySupportLine(override)) {
    return { text: override!.text ?? null, email: override!.email ?? null, phone: override!.phone ?? null };
  }
  if (!isEmptySupportLine(defaultLine)) {
    return { text: defaultLine!.text ?? null, email: defaultLine!.email ?? null, phone: defaultLine!.phone ?? null };
  }
  return null;
}

/** The support line as one plain-text sentence (text mail, alt text, tests). */
export function supportLineText(line: BrandSupportLine | null | undefined): string {
  if (isEmptySupportLine(line)) return '';
  return [line!.text, line!.email, line!.phone].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The outsider's projection
// ---------------------------------------------------------------------------

/** What `toPublicBrand` needs. The loader's resolved brand satisfies it. */
export interface BrandSource {
  display_name: string;
  primary_color: string | null;
  accent_color: string | null;
  /** Site-relative path of the current logo, or null. */
  logo_path: string | null;
  support: BrandSupportLine | null;
  support_overrides: Partial<Record<string, BrandSupportLine>>;
}

/**
 * The allow-list. Five fields, each named, each re-validated on the way out.
 * `origin` makes the logo URL absolute -- a mail needs that, a page does not.
 */
export function toPublicBrand(source: BrandSource, surface: BrandSurface, origin?: string | null): PublicBrand {
  const logoPath = source.logo_path && /^\/api\/public\/brand-logo\/[0-9a-f]{40}$/.test(source.logo_path) ? source.logo_path : null;
  const base = origin ? origin.replace(/\/+$/, '') : '';
  return {
    display_name: source.display_name,
    logo_url: logoPath ? `${base}${logoPath}` : null,
    primary_color: parseBrandColor(source.primary_color),
    accent_color: parseBrandColor(source.accent_color),
    support: resolveSupportLine(source.support, source.support_overrides, surface),
  };
}

// ---------------------------------------------------------------------------
// Logo files
// ---------------------------------------------------------------------------

export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SniffedLogo {
  contentType: LogoContentType;
  extension: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

export const LOGO_CONTENT_TYPES: readonly LogoContentType[] = ['image/png', 'image/jpeg', 'image/webp'];

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/**
 * A PNG is its signature, then chunks: 4 bytes of length, 4 of type, the data,
 * 4 of CRC. The first chunk is IHDR and carries the size. The walk goes on to
 * the first IDAT (the pixels) and refuses two things on the way:
 *
 *   - an `acTL` chunk, which is what makes a PNG ANIMATED (an APNG must declare
 *     it before the first IDAT). A logo does not move;
 *   - a file whose chunks do not lead to an IDAT at all: it is not an image.
 */
function sniffPng(b: Uint8Array): SniffedLogo | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v) || !ascii(b, 12, 'IHDR') || be32(b, 8) !== 13) return null;
  const logo: SniffedLogo = { contentType: 'image/png', extension: 'png', width: be32(b, 16), height: be32(b, 20) };
  let at = 33; // signature (8) + IHDR chunk (4 + 4 + 13 + 4)
  for (let chunks = 0; chunks < 4096; chunks += 1) {
    if (at + 12 > b.length) return null;
    const length = be32(b, at);
    if (ascii(b, at + 4, 'acTL')) return null;
    if (ascii(b, at + 4, 'IDAT')) return logo;
    if (ascii(b, at + 4, 'IEND')) return null;
    at += 12 + length;
  }
  return null;
}

function sniffJpeg(b: Uint8Array): SniffedLogo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Start-of-frame markers carry the size; C4 / C8 / CC share the range and do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { contentType: 'image/jpeg', extension: 'jpg', height: be16(b, at + 5), width: be16(b, at + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = be16(b, at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function sniffWebp(b: Uint8Array): SniffedLogo | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  const base = { contentType: 'image/webp' as const, extension: 'webp' as const };
  if (ascii(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { ...base, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    // Bit 1 of the flags byte is "animation". A logo does not move.
    if (b[20] & 0x02) return null;
    return { ...base, width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * What the BYTES are, whatever the upload claimed. PNG, JPEG or WebP, with the
 * pixel size read from the header; anything else is null.
 *
 * SVG IS NOT AN OMISSION. An SVG is a document that can carry script, and this
 * file is drawn on pages outsiders open; there is no branch for it here, so it
 * cannot be accepted by a later "just add the type" change to a list.
 */
export function sniffLogo(bytes: Uint8Array): SniffedLogo | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

export type LogoVerdict = { ok: true; logo: SniffedLogo } | { ok: false; error: string };

/** Type, byte size and pixel size, in the order a person can fix them. */
export function judgeLogo(bytes: Uint8Array): LogoVerdict {
  if (bytes.length === 0) return { ok: false, error: 'The file is empty' };
  if (bytes.length > BRAND_LOGO_MAX_BYTES) {
    return { ok: false, error: `The logo is too large (${Math.round(BRAND_LOGO_MAX_BYTES / 1024)} KB at most)` };
  }
  const logo = sniffLogo(bytes);
  if (!logo) return { ok: false, error: 'The logo must be a PNG, JPEG or WebP image (SVG is not accepted)' };
  const { width, height } = logo;
  if (
    width < BRAND_LOGO_MIN_PIXELS ||
    height < BRAND_LOGO_MIN_PIXELS ||
    width > BRAND_LOGO_MAX_PIXELS ||
    height > BRAND_LOGO_MAX_PIXELS
  ) {
    return {
      ok: false,
      error: `The logo is ${width} x ${height} pixels; each side must be between ${BRAND_LOGO_MIN_PIXELS} and ${BRAND_LOGO_MAX_PIXELS}`,
    };
  }
  return { ok: true, logo };
}

// ---------------------------------------------------------------------------
// On a page
// ---------------------------------------------------------------------------

const LOGO_PATH = /^\/api\/public\/brand-logo\/[0-9a-f]{40}$/;

/**
 * The logo `src` a page may draw: the logo route's own path and nothing else.
 * A payload that somehow carried another URL draws no image rather than
 * fetching from wherever it pointed.
 */
export function pageLogoSrc(brand: PublicBrand | null | undefined): string | null {
  const url = brand?.logo_url;
  return typeof url === 'string' && LOGO_PATH.test(url) ? url : null;
}

export interface PageBrand extends BrandPalette {
  /** True when the organisation has a brand record. */
  branded: boolean;
  /** The display name, or the fallback the page already had. */
  name: string;
  /**
   * The one colour a page uses wherever it used the navy: as text, as a
   * button with white on it, as a tint. It is `text` -- the primary when that
   * reaches 4.5:1 against white, the navy when it does not -- so white on it
   * is readable as well, and no page has to reason about contrast.
   */
  accent: string;
  logoSrc: string | null;
  support: BrandSupportLine | null;
}

/** Everything a public page needs from the `brand` object of its payload. */
export function pageBrand(brand: PublicBrand | null | undefined, fallbackName: string | null | undefined): PageBrand {
  const palette = brandPalette(brand?.primary_color ?? null, brand?.accent_color ?? null);
  const support = brand && !isEmptySupportLine(brand.support) ? brand.support : null;
  return {
    ...palette,
    branded: !!brand,
    name: brand?.display_name || fallbackName || '',
    accent: palette.text,
    logoSrc: pageLogoSrc(brand),
    support,
  };
}


// ---------------------------------------------------------------------------
// A Records form's own accent colour
// ---------------------------------------------------------------------------

export type AccentResult = { ok: true; value: string | null } | { ok: false; error: string };

const SHORT_HEX = /^#[0-9a-fA-F]{3}$/;

/**
 * The accent colour of one public form, as typed in the form builder.
 *
 * More forgiving than a brand colour ON THE WAY IN, because the builder's
 * field was free text for a long time: `#abc` is read as `#AABBCC`, any case
 * is accepted, surrounding spaces are dropped. Empty is "none". Anything else
 * -- a colour name, `rgb()`, a longer hex -- is an error, never a guess. What
 * comes out is `#RRGGBB` upper case or null, so what is DRAWN is held to the
 * same rule as a brand colour.
 */
export function normalizeFormAccent(raw: unknown): AccentResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Accent colour must be a hex colour such as #1A365D' };
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  if (SHORT_HEX.test(value)) {
    const [r, g, bl] = [value[1], value[2], value[3]];
    return { ok: true, value: `#${r}${r}${g}${g}${bl}${bl}`.toUpperCase() };
  }
  const full = parseBrandColor(value);
  if (full) return { ok: true, value: full };
  return { ok: false, error: 'Accent colour must be a hex colour such as #1A365D (three or six digits after the #)' };
}

/** The accent a stored setting really draws: a colour, or null (falls back). */
export function formAccentOrNull(raw: unknown): string | null {
  const r = normalizeFormAccent(raw);
  return r.ok ? r.value : null;
}
