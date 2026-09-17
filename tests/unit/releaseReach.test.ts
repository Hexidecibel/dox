/**
 * Who a shipped change reaches — the convention, its guard, and the backfill.
 *
 * AJ Conner, reviewing v2.7.0-v2.20.0: "Mark in each release which changes
 * reach existing tenants and which only land on new ones. The GFSI change is
 * right ... but it applies to newly set-up orgs only, so our config keeps the
 * old rule. That is the first product default to drift from our tenant and it
 * will not be the last."
 *
 * Three things are worth a test, and none of them is "the regex works":
 *
 *   1. AN UNMARKED BULLET IS UNCHANGED. The convention was introduced onto
 *      notes written before it existed; if a missing marker mangled a line,
 *      the safe thing would be never to adopt it.
 *   2. THE GUARD AND THE CHIP READ THE SAME WORDS. `bin/release` refuses a
 *      release through the esbuild mirror of this module, and the in-app
 *      renderer imports the source. A drift between them is a release that
 *      passes the gate and renders a literal `[existing]` on the page.
 *   3. EVERY SHIPPED RELEASE FROM v2.8.0 ON ANSWERS THE QUESTION, in both the
 *      authored copy and the public mirror the app actually fetches.
 */

import { describe, it, expect } from 'vitest';
import {
  RELEASE_REACH_LABEL,
  RELEASE_REACH_TOKENS,
  hasReachMarker,
  isReleaseReach,
  splitReachToken,
} from '../../shared/releaseReach';
import compiledReach from '../../bin/lib/shared/releaseReach.js';

const NOTES = import.meta.glob(['../../releases/v*.md', '../../public/releases/v*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Release notes written before the convention existed and left alone. */
const BEFORE_THE_CONVENTION = new Set([
  '2.4.1',
  '2.4.2',
  '2.4.3',
  '2.5.0',
  '2.6.0',
  '2.7.0',
]);

function versionOf(file: string): string {
  return file.replace(/^.*\/v/, '').replace(/\.md$/, '');
}

describe('the marker itself', () => {
  it('splits a leading token off and leaves everything else alone', () => {
    expect(splitReachToken('[existing] **Something.** Body.')).toEqual({
      reach: 'existing',
      rest: '**Something.** Body.',
    });
    expect(splitReachToken('[new-orgs] A changed default.').reach).toBe('new-orgs');
    expect(splitReachToken('[config] Inert until set up.').reach).toBe('config');
  });

  it('leaves a bullet with no marker byte-identical', () => {
    const plain = '**Plain bullet** that nobody classified.';
    expect(splitReachToken(plain)).toEqual({ reach: null, rest: plain });
    // A bracketed word that is not one of ours is text, not a broken marker.
    const other = '[wontfix] not a reach token';
    expect(splitReachToken(other)).toEqual({ reach: null, rest: other });
    // The token only counts at the START. A mention mid-sentence is prose.
    const mid = 'this is [existing] behaviour';
    expect(splitReachToken(mid)).toEqual({ reach: null, rest: mid });
  });

  it('every token has words a reader can act on', () => {
    for (const t of RELEASE_REACH_TOKENS) {
      expect(isReleaseReach(t)).toBe(true);
      expect(RELEASE_REACH_LABEL[t].length).toBeGreaterThan(8);
    }
    expect(isReleaseReach('everyone')).toBe(false);
  });
});

describe("bin/release's guard", () => {
  it('passes on one marker anywhere and fails on notes with none', () => {
    expect(hasReachMarker('## Title\n\n- [config] Needs setting up.\n')).toBe(true);
    expect(hasReachMarker('## Title\n\n- Something shipped.\n')).toBe(false);
    // Indented sub-bullets count too — a nested list is still the notes.
    expect(hasReachMarker('- a\n  - [existing] b\n')).toBe(true);
  });

  it('is NOT satisfied by the instructions the draft carries', () => {
    // The draft `bin/release` writes explains the convention in an HTML
    // comment. A guard that its own boilerplate satisfied would pass forever
    // and never once make anybody answer the question.
    const draft =
      '<!--\n  - [existing] ...  live for every organisation on deploy\n-->\n\n## TODO\n\n- feat: something (abc1234)\n';
    expect(hasReachMarker(draft)).toBe(false);
  });

  it('reads the same words in bin/ as the app does — one vocabulary, two consumers', () => {
    // `bin/release` requires the esbuild mirror; the modal imports the source.
    // If `npm run build:worker-shared` were not re-run after a change here,
    // the guard would accept a token the chip cannot render.
    expect(compiledReach.RELEASE_REACH_TOKENS).toEqual([...RELEASE_REACH_TOKENS]);
    expect(compiledReach.RELEASE_REACH_LABEL).toEqual(RELEASE_REACH_LABEL);
    expect(compiledReach.hasReachMarker('- [new-orgs] x')).toBe(true);
    expect(compiledReach.hasReachMarker('- x')).toBe(false);
  });
});

describe('every release since the convention says who it reaches', () => {
  it('sees the notes at all', () => {
    expect(Object.keys(NOTES).length).toBeGreaterThan(20);
  });

  it('marks v2.8.0 onward, in the authored copy AND the public mirror', () => {
    // The app fetches /releases/*.md — the public copy. A marker in the
    // authored file and not the mirror is a marker nobody ever sees.
    const unmarked = Object.entries(NOTES)
      .filter(([file]) => !BEFORE_THE_CONVENTION.has(versionOf(file)))
      .filter(([, md]) => !hasReachMarker(md))
      .map(([file]) => file);
    expect(unmarked).toEqual([]);
  });

  it('keeps each public mirror byte-identical to its authored file', () => {
    for (const [file, md] of Object.entries(NOTES)) {
      if (!file.includes('/public/')) continue;
      const authored = NOTES[file.replace('/public/releases/', '/releases/')];
      expect(authored, `no authored copy for ${file}`).toBeDefined();
      expect(md, `${file} has drifted from its authored copy`).toBe(authored);
    }
  });

  it("records AJ's own example as new-organisations-only", () => {
    // The change that produced this convention: the GFSI claim rule moved in
    // v2.17.0 and the live tenant's configuration deliberately did not.
    const gfsi = Object.entries(NOTES).find(
      ([file, md]) => versionOf(file) === '2.17.0' && md.includes('GFSI'),
    );
    expect(gfsi).toBeDefined();
    const line = gfsi![1].split('\n').find((l) => l.includes('GFSI'))!;
    expect(splitReachToken(line.replace(/^\s*[-*+]\s+/, '')).reach).toBe('new-orgs');
  });
});
