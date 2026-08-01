// Minimal READ-ONLY D1 query helper for bin/ analysis scripts.
//
// Shells out to `npx wrangler d1 execute` with --json and flattens whatever
// shape wrangler hands back (it has emitted both a bare array of statement
// results and a {result:[...]} envelope across versions) into a plain array of
// row objects. Same tolerant-parse approach bin/migrate uses inline.
//
// This module deliberately exposes ONLY a SELECT path: `query()` refuses any
// statement that is not a SELECT/WITH, so a measurement script cannot mutate
// prod by accident. Scripts that need to write should use their own helper.

const { execFileSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB = 'doc-upload-db';

/** True for statements that only read. Anything else is rejected. */
function isReadOnly(sql) {
  const stripped = String(sql)
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  return /^(select|with)\b/i.test(stripped);
}

/**
 * Flatten wrangler's --json output to an array of row objects.
 * Tolerates: [{results:[...]}, ...] | {result:[{results:[...]}]} | [...]
 */
function flattenRows(raw) {
  let data;
  try {
    // wrangler sometimes prints a banner line before the JSON.
    const start = raw.search(/[[{]/);
    data = JSON.parse(start >= 0 ? raw.slice(start) : raw);
  } catch {
    return [];
  }
  const rows = [];
  const visit = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === 'object') {
      if (Array.isArray(v.results)) {
        rows.push(...v.results);
        return;
      }
      if (Array.isArray(v.result)) {
        v.result.forEach(visit);
        return;
      }
    }
  };
  visit(data);
  return rows;
}

/**
 * Run a read-only SQL statement and return its rows.
 *
 * @param {string} sql      SELECT/WITH statement.
 * @param {object} [opts]
 * @param {boolean} [opts.remote]  target production D1 (default: local).
 * @param {string}  [opts.db]      D1 database name (default doc-upload-db).
 * @returns {Array<Record<string, unknown>>}
 */
function query(sql, opts = {}) {
  if (!isReadOnly(sql)) {
    throw new Error(`d1.query() refuses non-SELECT statement: ${String(sql).slice(0, 80)}`);
  }
  const db = opts.db || DEFAULT_DB;
  const args = [
    'wrangler',
    'd1',
    'execute',
    db,
    opts.remote ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
  ];
  let out;
  try {
    out = execFileSync('npx', args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`d1 query failed: ${stderr || err.message}`);
  }
  return flattenRows(out);
}

/**
 * Page through a read-only statement with LIMIT/OFFSET so a large table never
 * blows the D1 response-size limit. `sqlFor(limit, offset)` must return a
 * statement with a deterministic ORDER BY.
 *
 * Returns { rows, pages } — callers report `pages` so nothing looks silently
 * truncated.
 */
function queryPaged(sqlFor, opts = {}) {
  const pageSize = opts.pageSize || 100;
  const rows = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = query(sqlFor(pageSize, offset), opts);
    pages += 1;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (opts.maxRows && rows.length >= opts.maxRows) break;
  }
  return { rows, pages };
}

module.exports = { query, queryPaged, flattenRows, isReadOnly, DEFAULT_DB, PROJECT_ROOT };
