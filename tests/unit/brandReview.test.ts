/**
 * Two things the independent review of the tenant brand record (2026-10-08)
 * found outside the brand module itself:
 *
 *   - the From name of every mail is built from a name nobody checks for
 *     invisible characters when the tenant has no brand (`tenants.name`);
 *   - forms whose stored accent is not a colour change appearance at deploy,
 *     and somebody should be able to list them first (bin/report-form-accents).
 */
import { describe, it, expect } from 'vitest';
import { viaSenderName } from '../../functions/lib/email';
import mod from '../../bin/lib/formAccents.js';

const { classifyFormAccent } = mod as {
  classifyFormAccent: (raw: string | null) => { state: string; stored: string | null; drawn: string | null; has_logo_url: boolean };
};

const cp = (n: number) => String.fromCodePoint(n);

describe('viaSenderName: the From name is cleaned where it is built', () => {
  it('an ordinary name is unchanged', () => {
    expect(viaSenderName('Northfield Foods')).toBe('Northfield Foods via SupDox');
    expect(viaSenderName('Søndergård & Co.')).toBe('Søndergård & Co. via SupDox');
    expect(viaSenderName('北田食品')).toBe('北田食品 via SupDox');
  });

  it('a right-to-left override cannot reverse the sender in an inbox', () => {
    const name = viaSenderName(`${cp(0x202e)}moc.elpmaxe`);
    expect(name).toBe('moc.elpmaxe via SupDox');
    expect(name).not.toContain(cp(0x202e));
  });

  it.each([0x200b, 0x200d, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0x00ad, 0x061c])(
    'U+%s is taken out of the middle of a name',
    (code) => {
      expect(viaSenderName(`North${cp(code)}field`)).toBe('Northfield via SupDox');
    },
  );

  it('a name that is nothing but invisible characters or fillers is no name: the portal sends as itself', () => {
    for (const blank of [cp(0x200b), cp(0x3164), cp(0x115f), cp(0x1160), cp(0xffa0), `${cp(0x3164)} ${cp(0x200b)}`, cp(0x2800)]) {
      expect(viaSenderName(blank), JSON.stringify(blank)).toBe('SupDox');
    }
    // ...and so is one with no letter or digit left at all.
    expect(viaSenderName('---')).toBe('SupDox');
    expect(viaSenderName('"<>"')).toBe('SupDox');
    expect(viaSenderName(null)).toBe('SupDox');
  });

  it('still strips what could break the header', () => {
    const name = viaSenderName('Acme "Foods" <ceo@acme.example>,\r\nBcc: x@y.example');
    expect(name).not.toMatch(/[\r\n"<>,;:@]/);
    expect(name.endsWith(' via SupDox')).toBe(true);
  });
});

describe('bin/report-form-accents: what becomes of a stored accent', () => {
  const settings = (accent: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ accent_color: accent, ...extra });

  it('nothing stored', () => {
    expect(classifyFormAccent(null).state).toBe('none');
    expect(classifyFormAccent('{}').state).toBe('none');
    expect(classifyFormAccent(settings('')).state).toBe('none');
    expect(classifyFormAccent(settings(null)).state).toBe('none');
  });

  it('a six-digit hex colour is drawn as before, whatever its case', () => {
    expect(classifyFormAccent(settings('#1A365D'))).toMatchObject({ state: 'drawn', drawn: '#1A365D' });
    expect(classifyFormAccent(settings('#1a365d'))).toMatchObject({ state: 'drawn', drawn: '#1A365D' });
  });

  it('a short hex or stray spaces are respelled, the same colour', () => {
    expect(classifyFormAccent(settings('#abc'))).toMatchObject({ state: 'normalised', stored: '#abc', drawn: '#AABBCC' });
    expect(classifyFormAccent(settings(' #1A365D '))).toMatchObject({ state: 'normalised', drawn: '#1A365D' });
  });

  it('anything else FALLS BACK, and is named with what was stored', () => {
    for (const bad of ['red', 'navy blue', 'rgb(0,0,0)', '1A365D', '#12345', '#abc;x']) {
      expect(classifyFormAccent(settings(bad))).toEqual({ state: 'falls_back', stored: bad, drawn: null, has_logo_url: false });
    }
    expect(classifyFormAccent(settings(123456)).state).toBe('falls_back');
  });

  it('unreadable settings are reported, not skipped', () => {
    expect(classifyFormAccent('{not json').state).toBe('settings_unreadable');
  });

  it('counts a stored outside logo link', () => {
    expect(classifyFormAccent(settings('#abc', { logo_url: 'https://elsewhere.example/logo.png' })).has_logo_url).toBe(true);
    expect(classifyFormAccent(settings('#abc', { logo_url: ' ' })).has_logo_url).toBe(false);
  });
});
