/**
 * No way out of the portal is added quietly.
 *
 * The sharing rule (decision C-003, migration 0137) only means something if it
 * holds on EVERY way a file leaves. When it was designed there were six exits
 * read through four different code paths, and one of them -- the bundle ZIP --
 * had been handing over whole compliance packages with no rule and no audit
 * row, because nothing connected it to the others.
 *
 * So this is a text scan, as a test. It finds every place under functions/
 * that reads a file's bytes out of storage, and fails when the file is not in
 * tests/unit/exitRegister.allow.ts, classified as an `exit` (and asking the
 * rule) or as `not_exit` (with the reason).
 *
 * What counts as a read: a `.get(` on an R2 bucket handle, and the three
 * functions that wrap one (`downloadFile`, `readExportBytes`,
 * `buildExportZip`). `.head(` is not a read -- it returns a size, never bytes.
 * Comments are stripped first, so prose about a read is not one.
 */
import { describe, it, expect } from 'vitest';
import { stripCodeComments } from './noFirstTenantValues.scan';
import { EXIT_REGISTER, SHARING_RULE_CHECKS } from './exitRegister.allow';

const RAW = import.meta.glob(['../../functions/**/*.ts', '!../../**/node_modules/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([key, text]) => [key.replace(/^(\.\.\/)+/, ''), text]),
);

/**
 * A read of file bytes. The bucket handle is matched by the names this
 * codebase gives one (`env.FILES`, a `files` / `bucket` / `r2` parameter); a
 * new name for a handle has to be added here, which `the scan sees every
 * R2Bucket handle` below enforces.
 */
const READ_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'R2 .get(', re: /\b(?:FILES|files|bucket|r2|R2|storage)\s*\.\s*get\s*\(/ },
  { label: 'downloadFile(', re: /\bdownloadFile\s*\(/ },
  { label: 'readExportBytes(', re: /\breadExportBytes\s*\(/ },
  { label: 'buildExportZip(', re: /\bbuildExportZip\s*\(/ },
];

interface Read {
  path: string;
  line: number;
  label: string;
}

function scanReads(path: string, source: string): Read[] {
  const out: Read[] = [];
  const lines = stripCodeComments(source).split('\n');
  lines.forEach((text, i) => {
    for (const p of READ_PATTERNS) {
      if (p.re.test(text)) out.push({ path, line: i + 1, label: p.label });
    }
  });
  return out;
}

function allReads(): Read[] {
  return Object.entries(SOURCES)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, text]) => scanReads(path, text));
}

describe('the exit register', () => {
  it('the scan actually sees the code', () => {
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(200);
    for (const expected of [
      'functions/api/_middleware.ts',
      'functions/lib/r2.ts',
      'functions/lib/document-export.ts',
      'functions/api/bundles/[id]/download.ts',
    ]) {
      expect(paths, `${expected} is not being scanned`).toContain(expected);
    }
  });

  it('every file that reads storage is classified', () => {
    const listed = new Set(EXIT_REGISTER.map((e) => e.path));
    const unlisted = allReads().filter((r) => !listed.has(r.path));
    expect(
      unlisted,
      `${unlisted.length} read(s) of file bytes in a file the exit register does not know. If a document can leave ` +
        `through it, it must ask the sharing rule (functions/lib/sharing-rule.ts). Either way, add the file to ` +
        `tests/unit/exitRegister.allow.ts as 'exit' or 'not_exit' with the reason:\n` +
        unlisted.map((r) => `  ${r.path}:${r.line}  ${r.label}`).join('\n') +
        '\n',
    ).toEqual([]);
  });

  it('every entry names a file that still reads storage, once, with a reason', () => {
    const reading = new Set(allReads().map((r) => r.path));
    const seen = new Set<string>();
    for (const entry of EXIT_REGISTER) {
      expect(seen.has(entry.path), `${entry.path} is listed twice`).toBe(false);
      seen.add(entry.path);
      expect(entry.reason.trim().length, `${entry.path}: an entry needs a reason`).toBeGreaterThan(40);
      expect(SOURCES[entry.path], `${entry.path} is listed but is not a file under functions/`).toBeDefined();
      expect(
        reading.has(entry.path),
        `${entry.path} is listed but no longer reads storage -- remove the entry`,
      ).toBe(true);
    }
  });

  it('every exit asks the sharing rule, through the function it names', () => {
    const exits = EXIT_REGISTER.filter((e) => e.classification === 'exit');
    expect(exits.length).toBeGreaterThanOrEqual(9);
    for (const entry of exits) {
      expect(entry.checked_by, `${entry.path}: an exit must say which function asks the rule`).toBeTruthy();
      expect(SHARING_RULE_CHECKS as readonly string[]).toContain(entry.checked_by);
      const code = stripCodeComments(SOURCES[entry.path]);
      expect(
        new RegExp(`\\b${entry.checked_by}\\s*\\(`).test(code),
        `${entry.path} is registered as an exit checked by ${entry.checked_by}, and no longer calls it`,
      ).toBe(true);
    }
    for (const entry of EXIT_REGISTER.filter((e) => e.classification === 'not_exit')) {
      expect(entry.checked_by, `${entry.path}: a not_exit names no check`).toBeUndefined();
    }
  });

  it('the scan sees every R2Bucket handle by the name it is given', () => {
    // A parameter typed R2Bucket under a name READ_PATTERNS does not match
    // would be a read this guard cannot see. Find every such name and prove
    // the pattern covers it.
    const names = new Set<string>();
    for (const text of Object.values(SOURCES)) {
      const code = stripCodeComments(text);
      for (const m of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\??\s*:\s*R2Bucket\b/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        READ_PATTERNS[0].re.test(`${name}.get(`),
        `an R2Bucket is held under the name "${name}", which the exit scan does not match -- add it to READ_PATTERNS`,
      ).toBe(true);
    }
  });
});

// The tester, tested: a guard that cannot fail is decoration.
describe('the guard catches a planted read', () => {
  it('in every shape a read takes, naming file and line', () => {
    const reads = scanReads(
      'functions/api/planted/export.ts',
      [
        'const a = 1;',
        'const obj = await context.env.FILES.get(key);',
        'const f = await downloadFile(env.FILES, key);',
        'const b = await readExportBytes(files, row.r2_key);',
        'const z = await buildExportZip(files, rows, meta);',
        'const o = await bucket.get(key);',
      ].join('\n'),
    );
    expect(reads.map((r) => [r.line, r.label])).toEqual([
      [2, 'R2 .get('],
      [3, 'downloadFile('],
      [4, 'readExportBytes('],
      [5, 'buildExportZip('],
      [6, 'R2 .get('],
    ]);
  });

  it('but not in a comment, and not for a size check', () => {
    const source = [
      '// const obj = await env.FILES.get(key);',
      '/* downloadFile(files, key) is how it used to work */',
      'const head = await files.head(key);',
      "const token = url.searchParams.get('token');",
      'const row = byId.get(id);',
    ].join('\n');
    expect(scanReads('functions/x.ts', source)).toEqual([]);
  });
});
