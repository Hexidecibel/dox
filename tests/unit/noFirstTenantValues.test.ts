/**
 * Nothing that ships names the first tenant.
 *
 * The client's definition of done for Phase 1: "a text search of the product
 * code, starter packs and templates finds no Medosweet supplier, person, SOP
 * number, limit value or certificate value". An audit (2026-10-06) found them
 * in LIVE behaviour -- the base extraction prompt named the organisation, the
 * default industry layer was one tenant's dairy playbook, the search box
 * offered one tenant's real lot and PO numbers as examples -- and every release
 * had been adding more. This is that text search, as a test, so it stays done.
 *
 * Scanned: functions/, src/ (not its tests), shared/, starter-packs/,
 * workers/<name>/src and email-worker/src. NOT scanned: comments (history
 * belongs there), tests and fixtures, migrations, docs, and bin/ -- the seed and
 * repair scripts for the first tenant's own data are full of its names by
 * definition.
 *
 * To keep something on purpose, add it to noFirstTenantValues.allow.ts with the
 * reason.
 */
import { describe, it, expect } from 'vitest';
import { ALLOWLIST, KNOWN_FIRST_TENANT_SHAPED } from './noFirstTenantValues.allow';
import { DENYLIST, formatFindings, scanSource, stripCodeComments, stripSqlComments, type Finding } from './noFirstTenantValues.scan';

const RAW = import.meta.glob(
  [
    '../../functions/**/*',
    '../../src/**/*',
    '../../shared/**/*',
    '../../starter-packs/**/*',
    '../../workers/*/src/**/*',
    '../../email-worker/src/**/*',
    '!../../src/**/*.test.*',
    '!../../**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,pdf}',
    '!../../**/node_modules/**',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([key, text]) => [key.replace(/^(\.\.\/)+/, ''), text]),
);

function scanAll(sources: Record<string, string>): Finding[] {
  return Object.entries(sources)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, text]) => scanSource(path, text, ALLOWLIST));
}

describe('no first-tenant values in what ships', () => {
  it('the scan actually sees the code', () => {
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(400);
    for (const expected of [
      'functions/lib/llm.ts',
      'shared/orderPrompt.ts',
      'src/lib/helpContent.ts',
      'src/components/search/SearchWorkspace.tsx',
      'starter-packs/fsqa.json',
    ]) {
      expect(paths, `${expected} is not being scanned`).toContain(expected);
    }
    expect(paths.some((p) => p.startsWith('workers/') && p.includes('/src/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('email-worker/src/'))).toBe(true);
    expect(paths.some((p) => /\.test\./.test(p) && p.startsWith('src/'))).toBe(false);
  });

  it('finds no denied name or number outside comments', () => {
    const findings = scanAll(SOURCES);
    expect(
      findings,
      `${findings.length} first-tenant value(s) in shipped code. Replace each with a made-up value of the same ` +
        `shape, or add it to tests/unit/noFirstTenantValues.allow.ts with the reason:\n${formatFindings(findings)}\n`,
    ).toEqual([]);
  });

  it('every allow-list entry carries a reason and still matches something', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.path}: an allow-list entry needs a reason`).toBeGreaterThan(20);
      const source = SOURCES[entry.path];
      expect(source, `${entry.path} is allow-listed but is not a scanned file`).toBeDefined();
      // A stale entry is a hole waiting for the next value to walk through.
      const used = scanSource(entry.path, source, []).some((f) => entry.pattern.test(f.text) || entry.pattern.test(lineOf(source, entry.path, f.line)));
      expect(used, `${entry.path}: allow-list entry ${entry.pattern} no longer excuses anything -- remove it`).toBe(true);
    }
  });
});

describe('what was looked at and left on purpose is still there', () => {
  it('every recorded exception names code that still exists, with a reason', () => {
    expect(KNOWN_FIRST_TENANT_SHAPED.length).toBeGreaterThan(0);
    for (const known of KNOWN_FIRST_TENANT_SHAPED) {
      expect(known.reason.trim().length, known.path).toBeGreaterThan(40);
      expect(SOURCES[known.path], `${known.path} is not a scanned file`).toBeDefined();
      expect(
        SOURCES[known.path].includes(known.marker),
        `${known.path}: the recorded exception no longer matches the code (${known.marker}) -- update or remove the record`,
      ).toBe(true);
    }
  });
});

function lineOf(source: string, path: string, line: number): string {
  const stripped = /\.sql$/i.test(path) ? stripSqlComments(source) : /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ? stripCodeComments(source) : source;
  return stripped.split('\n')[line - 1] ?? '';
}

// The tester, tested: a guard that cannot fail is decoration.
describe('the guard catches a planted violation', () => {
  const plant = (path: string, source: string) => scanSource(path, source, []);

  it('in a string, a template literal and JSX text, naming file and line', () => {
    const findings = plant(
      'functions/lib/planted.ts',
      ['const a = 1;', "const who = 'Ship to MEDOSWEET FARMS';", 'const p = `lot 10426203-03`;'].join('\n'),
    );
    expect(findings.map((f) => [f.line, f.label])).toEqual([
      [2, 'Medosweet'],
      [3, 'real lot 10426203'],
    ]);
    expect(formatFindings(findings)).toContain('functions/lib/planted.ts:2');
    expect(plant('src/pages/Planted.tsx', '<Typography>e.g. Darigold</Typography>')).toHaveLength(1);
  });

  it('but not in a comment of any kind', () => {
    const source = [
      '// Darigold prints the plant code first',
      '/* Country Morning',
      '   lots carry a suffix (CMF) */',
      'const x = 1; // Chuckanut',
      '{/* Savencia */}',
      ' * Andersen, in a doc block',
    ].join('\n');
    // The last line is not a comment on its own, which is the point of the
    // next assertion: only real comment syntax is excused.
    expect(plant('src/x.tsx', source).map((f) => f.line)).toEqual([6]);
    expect(plant('functions/x.sql', "SELECT 1; -- Darigold\n/* Medosweet */ SELECT 'Andersen -- Dairy';").map((f) => f.label)).toEqual(['Andersen']);
  });

  it('a URL in a string does not swallow the rest of its line', () => {
    expect(plant('functions/x.ts', "const u = 'https://example.com/' + 'Darigold';")).toHaveLength(1);
    expect(plant('functions/x.ts', "const r = /https?:\\/\\//; const s = 'Darigold';")).toHaveLength(1);
  });

  it('keeps line numbers across a block comment', () => {
    expect(plant('functions/x.ts', "/*\n a\n b\n*/\nconst s = 'Chuckanut';")[0].line).toBe(5);
  });

  it('CMF only as a word; JSON has no comments, so every character counts', () => {
    expect(plant('shared/x.ts', "const a = 'CMFX'; const b = 'xCMF';")).toEqual([]);
    expect(plant('shared/x.ts', "const a = 'CMF 5 gal';")).toHaveLength(1);
    expect(plant('starter-packs/x.json', '{ "note": "// Medosweet" }')).toHaveLength(1);
  });

  it('an allow-list entry excuses only its own file and pattern', () => {
    const allow = [{ path: 'shared/a.ts', pattern: /Darigold/, reason: 'test' }];
    expect(scanSource('shared/a.ts', "const s = 'Darigold';", allow)).toEqual([]);
    expect(scanSource('shared/b.ts', "const s = 'Darigold';", allow)).toHaveLength(1);
    expect(scanSource('shared/a.ts', "const s = 'Savencia';", allow)).toHaveLength(1);
  });

  it('the denylist is not empty', () => {
    expect(DENYLIST.length).toBeGreaterThan(15);
  });
});
