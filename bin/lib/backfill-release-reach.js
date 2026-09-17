/**
 * ONE-OFF: put the reach markers onto the release notes written before the
 * convention existed (v2.8.0 - v2.20.0).
 *
 * Kept as a file rather than typed into a shell so the classification is
 * reviewable as a diff of DECISIONS rather than a diff of prose: each entry
 * below is a bullet's opening words and the answer to "does this reach an
 * organisation that is already running?". Idempotent - a bullet that already
 * carries a marker is left alone.
 *
 * Run: node bin/lib/backfill-release-reach.js [--check]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

/**
 * version -> [[prefix of the bullet, reach], ...].
 *
 * The prefix is matched after the list marker, so it is the first words the
 * bullet actually says. A prefix that matches nothing is an error, not a
 * silent skip: the notes and this table have to stay in step.
 */
const PLAN = {
  '2.8.0': [
    // The wizard is a screen every organisation gets on deploy. What it WRITES
    // is configuration, but the surface itself is not waiting on anybody.
    ['**Setup wizard.**', 'existing'],
    // 0099 inserts zero rows: absence resolves to the code default, so every
    // existing user's visible set was byte-identical the day after. Surfaces
    // narrow only when a named admin clicks a toggle.
    ['**Module visibility.**', 'config'],
    // 0100 is gated on document_type_requirements rows existing, so a tenant
    // with no mappings behaves byte-identically.
    ['**Approved documents close checklist items.**', 'config'],
    ['**Request composer + supplier portal.**', 'existing'],
    // The renewal rule itself (annual, three years for a spec sheet, never for
    // a COA) applies to every organisation with nothing to set up. Who hears
    // about it is v2.17.0's configuration story.
    ['**Renewals that route to an owner.**', 'existing'],
    ['**Spec engine reads more of the page, and invents less.**', 'existing'],
    ['**Register provenance + history backfill.**', 'existing'],
  ],
  '2.9.0': [
    ['**Arrivals inbox.**', 'existing'],
    ['**"What came back" on each request.**', 'existing'],
    ['**Decide dialog.**', 'existing'],
    ['**Review Queue context.**', 'existing'],
    ['**File stays viewable after approval.**', 'existing'],
  ],
  '2.10.0': [
    ['**Reviewed at approval, or found by the re-check over history.**', 'existing'],
    ['**Each result shows where on the certificate it came from.**', 'existing'],
    ['**"Checklist" is now "Requirements".**', 'existing'],
  ],
  '2.11.0': [
    ['**"No covering document on file."**', 'existing'],
    ['**Near misses are listed separately, with the reason.**', 'existing'],
    ['**Files still waiting for review are marked as not reviewed.**', 'existing'],
    ['**AI search shows what it could not apply.**', 'existing'],
    ['**Plurals and gallons match.**', 'existing'],
    ['The Search help panel now describes all five tabs', 'existing'],
    ['**Approve and decide in one step.**', 'existing'],
    ['**"Sales sheet, not a spec sheet."**', 'existing'],
    ['**A person confirms every lot match.**', 'existing'],
  ],
  '2.12.0': [
    ['**A lot number is found however it is typed.**', 'existing'],
    ['**Each result names the lot row that matched.**', 'existing'],
    ['**Production date is a real field on every lot.**', 'existing'],
    ['**Older certificates are shown as "likely — confirm".**', 'existing'],
    ['**A multi-lot certificate only matches on its own row.**', 'existing'],
    ['**A row produced after its expiry is flagged**', 'existing'],
    ['**One lot with two production dates is flagged**', 'existing'],
  ],
  '2.13.0': [
    ['**Name a product however you know it.**', 'existing'],
    ['**When a phrase could mean more than one product, you see each one.**', 'existing'],
    ['**A match that relies on an unconfirmed identifier says so.**', 'existing'],
    ['**Pack weights match across units.**', 'existing'],
    ['**An order number follows its lines to the certificates.**', 'existing'],
    ['**A suggested match for a different product is flagged**', 'existing'],
    ['**Product pages list every identifier the product goes by**', 'existing'],
    ['**The customer item number is read into its own field.**', 'existing'],
  ],
  '2.14.0': [
    ['**An exact copy of a document you already approved', 'existing'],
    ['**An exact copy of a file already waiting is folded into that card**', 'existing'],
    ['**A copy of a file that was rejected comes back with a note**', 'existing'],
    ['**Suppliers see their upload received exactly as before.**', 'existing'],
    ['**Only byte-identical files are recognised.**', 'existing'],
  ],
  '2.15.0': [
    // A watch is nothing until somebody names the supplier, the analytes and
    // the tighter limit. bin/seed-supplier-watch exists precisely because no
    // watch was configured anywhere on deploy.
    ['**A supplier can be put on watch.**', 'config'],
    // The five states are how every result is reported from the deploy on,
    // watch or no watch.
    ['**Every result now shows one of five states:**', 'existing'],
    ['**A new Test results panel on each document**', 'existing'],
    ['**Out of Spec has Incomplete and No limit configured tabs.**', 'existing'],
    ['**Settings › Spec Limits has a Suppliers on watch section**', 'existing'],
    ['**A unit conversion used in a comparison is shown on the value**', 'existing'],
    ['Results reported per 0.1 g were read as per gram.', 'existing'],
  ],
  '2.16.0': [
    ['**A supplier’s lot format can now be declared on the supplier**', 'config'],
    // Both of these read a DECLARED format; with no declaration nothing is
    // flagged and nothing is decoded.
    ['**The review queue flags a lot that does not fit its supplier’s format**', 'config'],
    ['**When a certificate states no production date', 'config'],
    // The prompt change is in every extraction from the deploy on.
    ['**Extraction no longer converts Julian date codes itself.**', 'existing'],
    ['**API keys: an expiry date now means the key works', 'existing'],
  ],
  '2.16.1': [
    ['**ppm, mg/kg', 'existing'],
    ['**mg/L, log counts and cell counts', 'existing'],
    ['**"oz" is treated as ambiguous**', 'existing'],
    ['**A count written "per mL"', 'existing'],
    ['**A combined yeast & mold result is never checked', 'existing'],
  ],
  '2.17.0': [
    // 0111 inserts zero rows: every organisation keeps the 60-day default
    // until somebody chooses otherwise.
    ['**Choose how far ahead owners are warned**', 'config'],
    ['**See the effect before you save.**', 'config'],
    // This one DID change for everyone: window_days is ignored wherever it is
    // sent, so the dashboard look-ahead stopped deciding who is emailed.
    ['**The Renewals look-ahead is now just a view.**', 'existing'],
    ['**Requirements can come from your verified supplier list.**', 'config'],
    ['**Nothing a person set is changed.**', 'config'],
    ['**Apply a requirement packet to one or many suppliers**', 'config'],
    // The tab is there for everybody on deploy, and on the live tenant it had
    // 294 rows in it immediately (source NULL, the initial bulk seed).
    ['**A Needs review tab**', 'existing'],
    // AJ's own example, and the reason this convention exists.
    ['**The GFSI claim now requires the audit certificate', 'new-orgs'],
  ],
  '2.18.0': [
    ['**One place for what a product goes by.**', 'existing'],
    ['**Certificate products not yet identified are listed**', 'existing'],
    ['**Lot-match suggestions read the supplier’s item number first**', 'existing'],
    ['**A confirmed item number that shows a certificate is for a different', 'existing'],
    ['**Mapping a product during review now records it as a confirmed', 'existing'],
  ],
  '2.19.0': [
    ['**Spec Limits now shows the analyte names printed on certificates', 'existing'],
    ['**One click per fix:**', 'existing'],
    ["**A limit's version number now changes only when its threshold does.**", 'existing'],
    ['**The spreadsheet importer can set how much a limit matters**', 'existing'],
    ['**The review queue says when a buffer or control row was recognised**', 'existing'],
  ],
  '2.20.0': [
    ['**Select results in search and take them with you.**', 'existing'],
    ["**Download a ZIP with a manifest of what's inside.**", 'existing'],
    ['**Or send them to someone as a link that expires in 30 days.**', 'existing'],
    ['**Every export is recorded**', 'existing'],
    ['**Documents are now marked classified or needing review as they are', 'existing'],
    ['**GraphQL says when something is forbidden or not found**', 'existing'],
    ['**The help and the API reference no longer describe features', 'existing'],
  ],
};

const TOKENS = new Set(['existing', 'new-orgs', 'config']);
const LIST_RE = /^(\s*[-*+]\s+)(.*)$/;

/**
 * Compare on text, not on typography. Some of these notes were written with a
 * curly apostrophe and some with a straight one, and a table that had to guess
 * which would be wrong every time somebody edited a line.
 */
function norm(text) {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
}

function markFile(file, pairs, check) {
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const used = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) continue;
    const [, marker, body] = m;
    // Already marked (a re-run, or a hand edit)? Leave the line exactly as it
    // is — but still MATCH it, so a second run is a clean no-op rather than a
    // pile of "no bullet starts with" errors against work already done.
    const alreadyMarked =
      /^\[[a-z-]+\]/.test(body) && TOKENS.has(body.slice(1, body.indexOf(']')));
    const text = alreadyMarked ? body.slice(body.indexOf(']') + 1).trimStart() : body;
    for (let p = 0; p < pairs.length; p++) {
      const [prefix, reach] = pairs[p];
      if (!norm(text).startsWith(norm(prefix))) continue;
      used.add(p);
      if (!alreadyMarked) lines[i] = `${marker}[${reach}] ${body}`;
      break;
    }
  }

  // A prefix that matched nothing means the notes moved and the table did not.
  // That is an error rather than a silent skip: a classification that quietly
  // failed to land would leave a bullet unmarked and nobody would know.
  const unmatched = pairs.filter((_p, i) => !used.has(i)).map(([prefix]) => prefix);
  if (unmatched.length > 0) {
    throw new Error(`${path.basename(file)}: no bullet starts with ${JSON.stringify(unmatched)}`);
  }

  const out = lines.join('\n');
  if (out === original) return false;
  if (!check) fs.writeFileSync(file, out);
  return true;
}

function main() {
  const check = process.argv.includes('--check');
  let changed = 0;
  for (const [version, pairs] of Object.entries(PLAN)) {
    for (const dir of ['releases', 'public/releases']) {
      const file = path.join(ROOT, dir, `v${version}.md`);
      if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
      if (markFile(file, pairs, check)) {
        changed++;
        console.log(`${check ? 'would mark' : 'marked'} ${dir}/v${version}.md`);
      }
    }
  }
  console.log(`${changed} file(s) ${check ? 'would change' : 'changed'}.`);
}

main();
