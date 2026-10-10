/**
 * A pack cannot change without its version changing.
 *
 * An organisation's ledger records the pack VERSION it was seeded from, and
 * "an update is available" means nothing more than "this build ships a higher
 * number". So a pack edited without a bump is an update no organisation is
 * ever offered: new organisations get it, existing ones silently do not, and
 * that is the drift the whole mechanism exists to end.
 *
 * `tests/fixtures/starter-pack-versions.json` pins, for every pack, each
 * version it has ever shipped to the hash of its content at that version. The
 * hash covers everything the compiled pack carries except the version number
 * (`aliases`, packets and the teaching example included) AND every row the pack
 * writes -- so a change to a name-derived default in `shared/renewalPeriod.ts`
 * or `shared/sharingRule.ts` is caught too. That is a pack change: it alters
 * what a new organisation gets, and only a version bump carries it to the old
 * ones.
 */

import { describe, it, expect } from 'vitest';
import { STARTER_PACKS, STARTER_PACK_NAMES } from '../../functions/lib/starterPacks.generated';
import { packContentForHash } from '../../shared/packItems';
import fixtureRaw from '../fixtures/starter-pack-versions.json?raw';

const FIXTURE = JSON.parse(fixtureRaw) as Record<string, Record<string, string>>;

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('starter pack versions are pinned to their content', () => {
  for (const name of STARTER_PACK_NAMES) {
    it(`${name}: the shipped version matches its recorded hash`, async () => {
      const pack = STARTER_PACKS[name];
      const hash = await sha256(packContentForHash(pack as never));
      const recorded = FIXTURE[name] ?? {};
      const versions = Object.keys(recorded).map(Number).sort((a, b) => a - b);
      const latest = versions.length ? versions[versions.length - 1] : 0;
      const known = recorded[String(pack.version)];

      if (known === hash) return;

      const file = `starter-packs/${name}.json`;
      if (known === undefined && pack.version === latest + 1) {
        throw new Error(
          `${name} is now version ${pack.version}, which has no recorded hash yet.\n\n` +
            `Add this line to "${name}" in tests/fixtures/starter-pack-versions.json (keep the older lines):\n\n` +
            `    "${pack.version}": "${hash}"\n`,
        );
      }
      if (known === undefined) {
        throw new Error(
          `${name} declares version ${pack.version}, but the last recorded version is ${latest}. ` +
            `Versions go up by exactly one: set "version": ${latest + 1} in ${file}, run 'npm run build:packs', ` +
            'and run this test again for the line to add.',
        );
      }
      throw new Error(
        `The content of the "${name}" pack changed, but it still says version ${pack.version}.\n\n` +
          `Either ${file} was edited, or a default the pack derives from a document type's NAME changed in ` +
          'shared/renewalPeriod.ts / shared/sharingRule.ts. Both are pack changes: an organisation already on ' +
          `version ${pack.version} would never be offered this one.\n\n` +
          'To ship it:\n' +
          `  1. set "version": ${pack.version + 1} in ${file}\n` +
          "  2. run 'npm run build:packs'\n" +
          `  3. add this line to "${name}" in tests/fixtures/starter-pack-versions.json, KEEPING the line for ${pack.version}:\n\n` +
          `         "${pack.version + 1}": "<run this test again; it prints the hash>"\n\n` +
          `Do NOT replace the hash recorded for version ${pack.version}: organisations are on it, and that hash is ` +
          'the record of what they were given.',
      );
    });

    it(`${name}: every earlier version is still on record`, () => {
      const recorded = FIXTURE[name] ?? {};
      for (let v = 1; v <= STARTER_PACKS[name].version; v++) {
        expect(recorded[String(v)], `${name} version ${v} is missing from the fixture`).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  }

  it('the fixture names no pack that does not ship', () => {
    for (const name of Object.keys(FIXTURE)) expect(STARTER_PACK_NAMES).toContain(name);
  });

  it('a non-applied field is content: an alias changes the hash', async () => {
    const pack = structuredClone(STARTER_PACKS.fsqa);
    const before = await sha256(packContentForHash(pack as never));
    pack.document_types[0].aliases = [...pack.document_types[0].aliases, 'Another Name'];
    expect(await sha256(packContentForHash(pack as never))).not.toBe(before);
    // ...and the version number is the one thing that is NOT content.
    const bumped = structuredClone(STARTER_PACKS.fsqa);
    bumped.version += 1;
    expect(await sha256(packContentForHash(bumped as never))).toBe(before);
  });
});
