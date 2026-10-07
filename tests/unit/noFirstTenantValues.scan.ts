/**
 * The scanner behind tests/unit/noFirstTenantValues.test.ts: strip comments,
 * then look for the first tenant's names and numbers in what is left.
 *
 * WHY COMMENTS ARE STRIPPED. This codebase explains itself by citing the cases
 * that taught it something, and there are hundreds of those in comments. A
 * comment never reaches a model, a screen or a second tenant; a string does.
 * The guard is about what SHIPS.
 *
 * The stripper is a small state machine, not a regex, because the interesting
 * failure is `'https://example.com'`: a naive `//` rule would delete the rest of
 * that line and hide whatever followed it. It errs toward KEEPING text when it
 * is unsure (an apostrophe in JSX text opens a "string" that ends at the line
 * break), so a mistake shows up as a false alarm somebody can read rather than
 * as a violation nobody sees. Line structure is preserved so a finding can name
 * its line.
 */

export interface DenyEntry {
  /** What it is, for the failure message. */
  label: string;
  pattern: RegExp;
}

/**
 * The first tenant's suppliers, customers and people, and the specific real
 * numbers that had made their way into prompts, examples and help text.
 * Case-insensitive; `CMF` only as a whole word.
 */
export const DENYLIST: DenyEntry[] = [
  { label: 'Medosweet', pattern: /medo\s*sweet/i },
  { label: 'Darigold', pattern: /darigold/i },
  { label: 'Country Morning', pattern: /country\s*morning/i },
  { label: 'CMF', pattern: /\bCMF\b/ },
  { label: 'Andersen', pattern: /andersen/i },
  { label: 'Smith Brothers', pattern: /smith\s*brothers/i },
  { label: 'Savencia', pattern: /savencia/i },
  { label: 'Fleur de Lait', pattern: /fleur\s*de\s*lait/i },
  { label: 'Chuckanut', pattern: /chuckanut/i },
  { label: 'Cush Co', pattern: /\bcush\s*co\b/i },
  { label: 'AJ Clean', pattern: /\baj\s*clean\b/i },
  // Real identifiers. Long enough that none can be an accident.
  { label: 'real lot 10426203', pattern: /10426203/ },
  { label: 'real supplier PO K134273', pattern: /K\s?134273/i },
  { label: 'real supplier PO K134514', pattern: /K\s?134514/i },
  { label: 'real supplier PO K 135680', pattern: /K\s?135680/i },
  { label: 'real invoice 261149', pattern: /\b261149\b/ },
  { label: 'real order 1784767', pattern: /\b1784767\b/ },
  { label: 'real order 1797062', pattern: /\b1797062\b/ },
  { label: 'real customer number K00166', pattern: /K00166/i },
  { label: 'real supplier item 810004', pattern: /\b810004\b/ },
  { label: 'real supplier item 310348', pattern: /\b310348\b/ },
];

export interface AllowEntry {
  /** Repo-relative path, exact. */
  path: string;
  /** Matched against the offending LINE (comments already removed). */
  pattern: RegExp;
  /** Why this one stays. Required: an allow-list without reasons is a mute button. */
  reason: string;
}

export interface Finding {
  path: string;
  line: number;
  label: string;
  text: string;
}

const REGEX_MAY_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);

/**
 * Remove `//` and block comments from TypeScript / TSX / JavaScript source
 * (JSX comments are block comments inside braces, so they go too). Newlines
 * inside a removed block comment are kept.
 */
export function stripCodeComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  let lastSignificant = '';
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // Ends at the matching quote or the end of the line, whichever is first.
      out += c;
      i++;
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < n && source[i + 1] !== '\n') {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n && source[i] === c) {
        out += c;
        i++;
      }
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      // A template literal is kept whole, `${...}` and all: what is inside one
      // is exactly the text this guard exists to read.
      out += c;
      i++;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += '`';
        i++;
      }
      lastSignificant = '`';
      continue;
    }
    if (c === '/' && REGEX_MAY_FOLLOW.has(lastSignificant)) {
      // A regex literal: copy to the closing slash so a quote or `//` inside it
      // is not mistaken for a string or a comment.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += source.slice(i, j + 1);
        i = j + 1;
        lastSignificant = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/** Remove `--` line comments and block comments from SQL. */
export function stripSqlComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") quoted = !quoted;
        else if (!quoted && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

export function stripComments(path: string, source: string): string {
  if (/\.sql$/i.test(path)) return stripSqlComments(source);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return stripCodeComments(source);
  return source; // JSON, markdown, anything else: every character ships.
}

export function scanSource(path: string, source: string, allow: AllowEntry[] = []): Finding[] {
  const findings: Finding[] = [];
  const lines = stripComments(path, source).split('\n');
  const allowed = allow.filter((a) => a.path === path);
  lines.forEach((text, index) => {
    for (const entry of DENYLIST) {
      if (!entry.pattern.test(text)) continue;
      if (allowed.some((a) => a.pattern.test(text))) continue;
      findings.push({ path, line: index + 1, label: entry.label, text: text.trim().slice(0, 160) });
    }
  });
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${f.path}:${f.line}  [${f.label}]  ${f.text}`).join('\n');
}
