import { describe, it, expect } from 'vitest';
// Vite ?raw imports work in the Workers pool because Vite inlines the file
// contents at transform time — no fs access needed at runtime.
import bootstrapMd from '../../releases/v2.5.0.md?raw';
import publicMirrorMd from '../../public/releases/v2.5.0.md?raw';
import indexJsonRaw from '../../public/releases/index.json?raw';

describe('bootstrap release notes (v2.5.0)', () => {
  it('starts with YAML frontmatter declaring version 2.5.0', () => {
    expect(bootstrapMd.startsWith('---\n')).toBe(true);
    const fm = bootstrapMd.split('---', 3)[1] ?? '';
    expect(fm).toMatch(/^version:\s*2\.5\.0\s*$/m);
    expect(fm).toMatch(/^date:\s*\d{4}-\d{2}-\d{2}\s*$/m);
    expect(fm).toMatch(/^title:\s*.+$/m);
  });

  it('mirrors the same content into public/releases/', () => {
    expect(publicMirrorMd).toBe(bootstrapMd);
  });

  it('mentions the four required surfaces', () => {
    expect(bootstrapMd.toLowerCase()).toContain('chip');
    expect(bootstrapMd.toLowerCase()).toContain('modal');
    expect(bootstrapMd).toMatch(/toast|snackbar|what.?s.?new/i);
    expect(bootstrapMd).toContain('bin/release');
  });

  it('has Added / Changed / Internal sections', () => {
    expect(bootstrapMd).toMatch(/^###?\s+Added\b/m);
    expect(bootstrapMd).toMatch(/^###?\s+Changed\b/m);
    expect(bootstrapMd).toMatch(/^###?\s+Internal\b/m);
  });
});

describe('release notes index', () => {
  it('lists v2.5.0 as current and includes the three prior phases', () => {
    const idx = JSON.parse(indexJsonRaw);
    expect(idx.current).toBe('2.5.0');
    const versions = idx.versions.map((v: { version: string }) => v.version);
    expect(versions).toContain('2.5.0');
    expect(versions).toContain('2.4.3');
    expect(versions).toContain('2.4.2');
    expect(versions).toContain('2.4.1');
  });

  it('orders newest version first', () => {
    const idx = JSON.parse(indexJsonRaw);
    expect(idx.versions[0].version).toBe('2.5.0');
  });
});
