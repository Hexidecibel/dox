// Pure commit classifier used by bin/release.
//
// Exports a CommonJS module so the bash release script can spawn
// `node -e "require('./bin/lib/classifyCommit.js')..."` without TS
// compile gymnastics, and a vitest can import it via dynamic import.

const SKIP_PREFIXES = [/^merge\b/i, /^release v/i];

const ADDED_PATTERNS = [
  /^feat(\(|:|!|\b)/i,
  /^add\b/i,
  /^new\b/i,
  /^introduce\b/i,
  /^phase\b/i, // Phase commits historically introduce new features
];

const FIXED_PATTERNS = [/^fix(\(|:|!|\b)/i, /^bug(fix)?\b/i, /^hotfix\b/i];

const INTERNAL_PATTERNS = [
  /^refactor(\(|:|!|\b)/i,
  /^cleanup\b/i,
  /^chore(\(|:|!|\b)/i,
  /^internal\b/i,
  /^test(\(|:|!|\b)/i,
  /^ci(\(|:|!|\b)/i,
  /^docs?(\(|:|!|\b)/i,
  /^style(\(|:|!|\b)/i,
  /^build(\(|:|!|\b)/i,
];

/**
 * Classify a commit by subject + body.
 *
 * @param {{subject: string, body?: string}} commit
 * @returns {'skip' | 'added' | 'changed' | 'fixed' | 'internal'}
 */
function classifyCommit(commit) {
  const subject = (commit.subject || '').trim();
  if (!subject) return 'skip';

  for (const re of SKIP_PREFIXES) {
    if (re.test(subject)) return 'skip';
  }

  for (const re of FIXED_PATTERNS) {
    if (re.test(subject)) return 'fixed';
  }

  for (const re of INTERNAL_PATTERNS) {
    if (re.test(subject)) return 'internal';
  }

  for (const re of ADDED_PATTERNS) {
    if (re.test(subject)) return 'added';
  }

  return 'changed';
}

module.exports = { classifyCommit };
