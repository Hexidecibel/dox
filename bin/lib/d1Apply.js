/**
 * bin/lib/d1Apply.js — the WRITE half every guarded bin/ apply script needs:
 * run a batch of statements through `wrangler d1 execute --file`, and ask a
 * person to type a confirmation word before a production write.
 *
 * bin/lib/d1.js is read-only on purpose (its query() refuses anything that is
 * not a SELECT); this is the deliberate, separate door. Fourteen scripts carry
 * their own copy of these two functions; new scripts use this one.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PROJECT_ROOT, DEFAULT_DB } = require('./d1');

/**
 * Write `statements` to a temp .sql file and execute it. D1 runs a --file as
 * one batch, so either every statement lands or none does.
 */
function execSql(statements, { remote = false, db = DEFAULT_DB, label = 'apply' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dox-${label}-`));
  const file = path.join(dir, `${label}.sql`);
  fs.writeFileSync(file, `${statements.join('\n')}\n`, 'utf8');
  try {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', db, remote ? '--remote' : '--local', `--file=${file}`],
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    throw new Error(`Writing to D1 failed. The SQL is at ${file}\n${stderr || err.message}${stdout ? `\n${stdout}` : ''}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Read one line from the controlling terminal (works under npx / pipes). */
function promptSync(question) {
  process.stdout.write(question);
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'rs');
  } catch {
    console.error('\nNo terminal to confirm on. Re-run interactively, or pass --yes.');
    process.exit(1);
  }
  const buf = Buffer.alloc(256);
  let out = '';
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    out += buf.toString('utf8', 0, n);
    if (out.includes('\n')) break;
  }
  fs.closeSync(fd);
  return out.split('\n')[0];
}

/**
 * Production guard: the person types `word` or nothing is written. Exits the
 * process on a mismatch.
 */
function confirmOrExit(summary, word) {
  const answer = promptSync(`\n${summary}\nType ${JSON.stringify(word)} to continue: `);
  if (answer.trim() !== word) {
    console.error('That did not match. Nothing was written.');
    process.exit(1);
  }
}

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Load CLOUDFLARE_* from .dev.vars when the shell did not export them. */
function loadDevVars() {
  if (process.env.CLOUDFLARE_API_TOKEN) return;
  const devVars = path.join(PROJECT_ROOT, '.dev.vars');
  if (!fs.existsSync(devVars)) return;
  for (const line of fs.readFileSync(devVars, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

module.exports = { execSql, promptSync, confirmOrExit, sqlStr, loadDevVars };
