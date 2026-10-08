/**
 * No way out of the portal is added quietly.
 *
 * The sharing rule (decision C-003, migration 0137) only means something if it
 * holds on EVERY way a file leaves. When it was designed there were six exits
 * read through four different code paths, and one of them -- the bundle ZIP --
 * had been handing over whole compliance packages with no rule and no audit
 * row, because nothing connected it to the others.
 *
 * So this is a text scan, as a test. Every file under functions/ that can
 * reach stored files at all must be in tests/unit/exitRegister.allow.ts,
 * classified `exit` (and asking the rule) or `not_exit` (with the reason), and
 * PINNED: how many times it names the bucket, how many `.get(` calls it makes,
 * how many read wrappers it calls and how many times it asks the rule. A new
 * read anywhere in a registered file moves a number and fails here until the
 * entry is consciously updated. See exitRegister.scan.ts for why it counts
 * rather than pattern-matches a read: the first version did the latter, and
 * was walked around six ways.
 */
import { describe, it, expect } from 'vitest';
import { EXIT_REGISTER, SHARING_RULE_CHECKS } from './exitRegister.allow';
import {
  bucketNames,
  bucketSignature,
  callsBucketByName,
  countGets,
  formatSignature,
  sameSignature,
  touchesBucket,
} from './exitRegister.scan';

const RAW = import.meta.glob(['../../functions/**/*.ts', '!../../**/node_modules/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([key, text]) => [key.replace(/^(\.\.\/)+/, ''), text]),
);

const NAMES = bucketNames(SOURCES);
const sig = (source: string) => bucketSignature(source, SHARING_RULE_CHECKS);
const inScope = (source: string) => touchesBucket(source, NAMES, SHARING_RULE_CHECKS);

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
    // The names a bucket is held under are discovered, not hard-coded.
    expect(NAMES).toContain('FILES');
    expect(NAMES).toContain('files');
  });

  it('every file that can reach stored files is classified', () => {
    const listed = new Set(EXIT_REGISTER.map((e) => e.path));
    const unlisted = Object.entries(SOURCES)
      .filter(([path, text]) => inScope(text) && !listed.has(path))
      .map(([path, text]) => `  ${path}  ${formatSignature(sig(text))}`)
      .sort();
    expect(
      unlisted,
      `${unlisted.length} file(s) under functions/ touch stored files and are not in the exit register. If a ` +
        `document's bytes can reach a person or a system through one, it must ask the sharing rule ` +
        `(functions/lib/sharing-rule.ts). Either way, add it to tests/unit/exitRegister.allow.ts as 'exit' or ` +
        `'not_exit', with the reason and this signature:\n${unlisted.join('\n')}\n`,
    ).toEqual([]);
  });

  it('every registered file still does exactly what it was registered doing', () => {
    const moved: string[] = [];
    for (const entry of EXIT_REGISTER) {
      const source = SOURCES[entry.path];
      if (source === undefined) continue; // reported by the next test
      const actual = sig(source);
      if (!sameSignature(actual, entry.signature)) {
        moved.push(
          `  ${entry.path} (${entry.classification})\n` +
            `      registered ${formatSignature(entry.signature)}\n` +
            `      now        ${formatSignature(actual)}`,
        );
      }
    }
    expect(
      moved,
      `${moved.length} registered file(s) changed how they touch stored files. A new read of file bytes in an ` +
        `'exit' needs its own sharing-rule check; a new read in a 'not_exit' may have made it an exit. Look at ` +
        `what changed, then update the entry's signature (and its classification and reason if they no longer ` +
        `hold) in tests/unit/exitRegister.allow.ts:\n${moved.join('\n')}\n`,
    ).toEqual([]);
  });

  it('every entry names a file that still touches stored files, once, with a reason', () => {
    const seen = new Set<string>();
    for (const entry of EXIT_REGISTER) {
      expect(seen.has(entry.path), `${entry.path} is listed twice`).toBe(false);
      seen.add(entry.path);
      expect(entry.reason.trim().length, `${entry.path}: an entry needs a reason`).toBeGreaterThan(40);
      expect(SOURCES[entry.path], `${entry.path} is listed but is not a file under functions/`).toBeDefined();
      expect(
        inScope(SOURCES[entry.path]),
        `${entry.path} is listed but no longer touches stored files -- remove the entry`,
      ).toBe(true);
    }
  });

  it('every exit asks the sharing rule, at least once for each read it makes', () => {
    const exits = EXIT_REGISTER.filter((e) => e.classification === 'exit');
    expect(exits.length).toBeGreaterThanOrEqual(9);
    for (const entry of exits) {
      expect(entry.checked_by, `${entry.path}: an exit must say which function asks the rule`).toBeTruthy();
      expect(SHARING_RULE_CHECKS as readonly string[]).toContain(entry.checked_by);
      const source = SOURCES[entry.path];
      expect(
        new RegExp(`\\b${entry.checked_by}\\s*\\(`).test(source),
        `${entry.path} is registered as an exit checked by ${entry.checked_by}, and no longer calls it`,
      ).toBe(true);
      expect(entry.signature.checks, `${entry.path}: an exit with no rule check`).toBeGreaterThan(0);
      // Each read wrapper the file calls is covered by a check of its own,
      // unless the entry says, in `reads_covered_by`, why one check covers
      // several reads. This is what "the file calls the rule somewhere" missed:
      // a second, unchecked read beside a checked one.
      if (entry.signature.readers > entry.signature.checks) {
        expect(
          (entry.reads_covered_by ?? '').trim().length,
          `${entry.path} makes ${entry.signature.readers} reads under ${entry.signature.checks} rule check(s). ` +
            `Say in reads_covered_by which check covers which read, or add the missing check.`,
        ).toBeGreaterThan(40);
      }
    }
    for (const entry of EXIT_REGISTER.filter((e) => e.classification === 'not_exit')) {
      expect(entry.checked_by, `${entry.path}: a not_exit names no check`).toBeUndefined();
    }
  });
});

// The tester, tested: a guard that cannot fail is decoration. Every shape below
// walked straight past the first version of this scanner.
describe('the scanner sees the shapes that defeated the first one', () => {
  const BASE = 'export const x = 1;\n';
  const base = sig(BASE);

  function expectSeen(label: string, source: string) {
    expect(inScope(source), `${label}: not in scope`).toBe(true);
    const s = sig(source);
    expect(sameSignature(s, base), `${label}: the signature did not move`).toBe(false);
  }

  it('an alias of the bucket', () => {
    const source = 'const b = env.FILES;\nconst obj = await b.get(key);\n';
    expectSeen('alias', source);
    expect(sig(source)).toMatchObject({ bucket: 1, gets: 1 });
  });

  it('a read whose .get( is on the next line', () => {
    const source = 'const obj = await context.env.FILES\n  .get(key);\n';
    expectSeen('next line', source);
    expect(sig(source)).toMatchObject({ bucket: 1, gets: 1 });
  });

  it('a bracket access, on the binding and on the method', () => {
    expectSeen('env["FILES"]', 'const obj = await env["FILES"].get(key);\n');
    const both = "const obj = await env['FILES']['get'](key);\n";
    expectSeen("['get']", both);
    expect(sig(both)).toMatchObject({ bucket: 1, gets: 1 });
  });

  it('a renamed destructure', () => {
    const source = 'const { FILES: docs } = env;\nconst obj = await docs.get(key);\n';
    expectSeen('destructure', source);
    expect(sig(source)).toMatchObject({ bucket: 1, gets: 1 });
  });

  it('a brand new wrapper handed the bucket', () => {
    const source = 'const bytes = await fetchBytes(env.FILES, key);\n';
    expectSeen('new wrapper', source);
    expect(sig(source)).toMatchObject({ bucket: 1, gets: 0, readers: 0 });
  });

  it('a bucket under a name outside any hard-coded list', () => {
    const declared = { 'functions/lib/vault.ts': 'export interface Ctx { vault: R2Bucket }\n' };
    const names = bucketNames(declared);
    expect(names).toEqual(['vault']);
    // A second file that never says FILES or R2Bucket, only uses the name.
    const user = 'export async function read(ctx) {\n  return ctx.vault.get(key);\n}\n';
    expect(sig(user).bucket).toBe(0);
    expect(callsBucketByName(user, names)).toBe(true);
    expect(touchesBucket(user, names, SHARING_RULE_CHECKS)).toBe(true);
    expect(touchesBucket(user, [], SHARING_RULE_CHECKS)).toBe(false);
  });

  it('a second read added to a file that already has a checked one', () => {
    const one = [
      'const refusal = await apiKeyFileRefusal(db, data, args);',
      'if (refusal) return refusal;',
      'const a = await downloadFile(env.FILES, key);',
    ].join('\n');
    const two = `${one}\nconst b = await downloadFile(env.FILES, other);\n`;
    expect(sig(one)).toEqual({ bucket: 1, gets: 0, readers: 1, checks: 1 });
    expect(sig(two)).toEqual({ bucket: 2, gets: 0, readers: 2, checks: 1 });
    expect(sameSignature(sig(one), sig(two))).toBe(false);
    // And through an alias, with no new mention of the bucket at all:
    const aliased = 'async function f(files: R2Bucket) {\n  await files.get(a);\n}\n';
    const aliasedTwice = 'async function f(files: R2Bucket) {\n  await files.get(a);\n  await files.get(b);\n}\n';
    expect(sig(aliased).bucket).toBe(sig(aliasedTwice).bucket);
    expect(sameSignature(sig(aliased), sig(aliasedTwice))).toBe(false);
  });

  it('a read added to a file classified not_exit moves its signature too', () => {
    const upload = 'await uploadFile(context.env.FILES, key, data, mime);\n';
    const uploadAndRead = `${upload}const back = await context.env.FILES.get(key);\n`;
    expect(sameSignature(sig(upload), sig(uploadAndRead))).toBe(false);
  });
});

describe('what the scanner does not count', () => {
  it('a header or a query parameter lookup', () => {
    const source = [
      "const a = context.request.headers.get('X-API-Key');",
      "const t = url.searchParams.get('token');",
      "const u = new URL(x).searchParams\n  .get('id');",
    ].join('\n');
    expect(countGets(source)).toBe(0);
    // ...but a local somebody named `headers` is not excused: only the property is.
    expect(countGets('const headers = env.FILES;\nawait headers.get(key);')).toBe(1);
  });

  it('a Map lookup IS counted: any .get( in a file that reaches the bucket is pinned', () => {
    expect(countGets('const row = byId.get(id);')).toBe(1);
  });

  it('anything in a comment, and a size check', () => {
    const source = [
      '// const obj = await env.FILES.get(key);',
      '/* downloadFile(files, key) is how it used to work */',
      'const n = 1;',
    ].join('\n');
    expect(sig(source)).toEqual({ bucket: 0, gets: 0, readers: 0, checks: 0 });
    expect(inScope(source)).toBe(false);
    expect(countGets('const head = await store.head(key);')).toBe(0);
  });
});
