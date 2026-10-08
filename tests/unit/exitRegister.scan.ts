/**
 * The scanner behind tests/unit/exitRegister.test.ts.
 *
 * WHAT IT IS FOR. The exit register says, for every file under functions/ that
 * can touch stored files, whether a document can LEAVE through it. The first
 * version of this scanner looked for `FILES.get(` on one line and asked only
 * whether the file called a rule function SOMEWHERE. A review defeated it six
 * ways without trying hard:
 *
 *   const b = env.FILES; b.get(key)          an alias
 *   env.FILES                                the call on the next line
 *     .get(key)
 *   env["FILES"].get(key)                    a bracket access
 *   const { FILES: docs } = env              a renamed destructure
 *   fetchBytes(env.FILES, key)               a new wrapper
 *   a second, unchecked read added to a file that already had a checked one
 *
 * So it no longer tries to recognise a READ. It recognises a file that can
 * REACH THE BUCKET AT ALL, and pins how much of that the file does:
 *
 *   bucket   how many times the file names the bucket: the `FILES` binding or
 *            the `R2Bucket` type, anywhere outside a comment -- in code, in a
 *            string, in a destructure. Every shape above names it once more.
 *   gets     every `.get(` call in the file, on ANY receiver, across line
 *            breaks, plus `['get'](`. A read through an alias is still a
 *            `.get(`. The two Web API receivers every handler uses
 *            (`.headers.get(`, `.searchParams.get(`) are left out so that
 *            reading a header does not move the count.
 *   readers  calls to the functions that wrap a read (`downloadFile`,
 *            `readExportBytes`, `buildExportZip`).
 *   checks   calls to the functions that ask the sharing rule.
 *
 * The register holds those four numbers for every such file. Adding a read --
 * to a file classified `exit` OR `not_exit` -- moves a number, and the test
 * fails until somebody opens the allow-list and decides, in writing, what the
 * new read is.
 *
 * A file is in scope when `bucket > 0`, `readers > 0`, or it calls a storage
 * method on a receiver that some file in functions/ declares as an R2Bucket
 * (`ctx.files.get(` in a resolver that never says "R2Bucket" itself).
 *
 * WHAT IT STILL CANNOT SEE: a bucket handed along under a property name no
 * file types as `R2Bucket`, then read through an alias, in a file that names
 * neither. Nothing in functions/ does that today.
 */
import { stripCodeComments } from './noFirstTenantValues.scan';

export interface BucketSignature {
  bucket: number;
  gets: number;
  readers: number;
  checks: number;
}

/** The functions that wrap a read of file bytes. */
export const READER_FUNCTIONS = ['downloadFile', 'readExportBytes', 'buildExportZip'] as const;

/** Receivers whose `.get(` is a Web API lookup, never a bucket. */
const NOT_A_BUCKET = new Set(['headers', 'searchParams']);

function count(code: string, re: RegExp): number {
  return [...code.matchAll(re)].length;
}

/** Every `.get(` in the code that is not `.headers.get(` / `.searchParams.get(`. */
export function countGets(code: string): number {
  let n = 0;
  for (const m of code.matchAll(/(?:\?\.|\.)\s*get\s*\(/g)) {
    const before = code.slice(0, m.index).trimEnd();
    const receiver = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? '';
    // Only when the Web API name is itself a PROPERTY (`request.headers.get`):
    // a local variable somebody called `headers` is not excused.
    const isProperty = /\.\s*[A-Za-z_$][\w$]*$/.test(before);
    if (NOT_A_BUCKET.has(receiver) && isProperty) continue;
    n++;
  }
  n += count(code, /\[\s*['"`]get['"`]\s*\]\s*\(/g);
  return n;
}

export function bucketSignature(source: string, ruleChecks: readonly string[]): BucketSignature {
  const code = stripCodeComments(source);
  return {
    bucket: count(code, /\bFILES\b|\bR2Bucket\b/g),
    gets: countGets(code),
    readers: count(code, new RegExp(`\\b(?:${READER_FUNCTIONS.join('|')})\\s*\\(`, 'g')),
    checks: count(code, new RegExp(`\\b(?:${ruleChecks.join('|')})\\s*\\(`, 'g')),
  };
}

/**
 * Every name a bucket is held under, anywhere in the given sources: a
 * parameter or property declared `name: R2Bucket`.
 */
export function bucketNames(sources: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const m of stripCodeComments(text).matchAll(/\b([A-Za-z_$][\w$]*)\??\s*:\s*R2Bucket\b/g)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** Does the file call a storage method on a receiver known to be a bucket? */
export function callsBucketByName(source: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const code = stripCodeComments(source);
  const re = new RegExp(
    `\\b(?:${names.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\s*(?:\\?\\.|\\.)\\s*(?:get|head|put|delete|list)\\s*\\(`,
  );
  return re.test(code);
}

/** Is this file in scope for the register? */
export function touchesBucket(source: string, names: readonly string[], ruleChecks: readonly string[]): boolean {
  const sig = bucketSignature(source, ruleChecks);
  return sig.bucket > 0 || sig.readers > 0 || callsBucketByName(source, names);
}

export function sameSignature(a: BucketSignature, b: BucketSignature): boolean {
  return a.bucket === b.bucket && a.gets === b.gets && a.readers === b.readers && a.checks === b.checks;
}

export function formatSignature(s: BucketSignature): string {
  return `{ bucket: ${s.bucket}, gets: ${s.gets}, readers: ${s.readers}, checks: ${s.checks} }`;
}
