/**
 * "Is this a second copy of something we already have?" (shared/duplicateConcept.ts)
 *
 * The real cases come first, because they are why the rule exists:
 * `bin/retire-duplicate-requirements` was written to merge three pairs of
 * requirements one organisation held twice, and "Spec Sheet" / "Specification
 * Sheet" is the document-type pair the client named. Each of those is now an
 * `aliases` entry in the fsqa pack, and each must be refused.
 */

import { describe, it, expect } from 'vitest';
import {
  conceptKey,
  describeDuplicateConcept,
  findDuplicateConcept,
  type ConceptPackItem,
  type ConceptRow,
} from '../../shared/duplicateConcept';
import { conceptKey as conceptKeyMjs, normalizePack } from '../../bin/lib/starter-packs.mjs';
import { STARTER_PACKS } from '../../functions/lib/starterPacks.generated';
import duplicatePlanRaw from '../../bin/lib/duplicateRequirementPlan.js?raw';

const packItems = (vocab: 'document_types' | 'requirements' | 'claim_types'): ConceptPackItem[] =>
  STARTER_PACKS.fsqa[vocab].map((i) => ({ pack: 'fsqa', name: i.name, slug: i.slug, aliases: i.aliases }));

const row = (name: string, slug: string, active = true): ConceptRow => ({ id: `id-${slug}`, name, slug, active });

/** An organisation holding every fsqa row of a vocabulary, as the pack wrote it. */
const seeded = (vocab: 'document_types' | 'requirements' | 'claim_types'): ConceptRow[] =>
  STARTER_PACKS.fsqa[vocab].map((i) => row(i.name, i.slug));

describe('conceptKey', () => {
  it('folds case, spacing and punctuation, and nothing else', () => {
    expect(conceptKey('Spec-Sheet')).toBe(conceptKey('spec sheet'));
    expect(conceptKey('  SPEC   SHEET ')).toBe('specsheet');
    expect(conceptKey('W-9')).toBe('w9');
    // Not fuzzy: these are different keys, and only an alias makes them one concept.
    expect(conceptKey('Specification Sheet')).not.toBe(conceptKey('Spec Sheet'));
    expect(conceptKey(null)).toBe('');
  });

  it('is the same rule in the pack compiler', () => {
    for (const text of ['Spec-Sheet', 'Certificate of Analysis (COA)', 'W-9', '  3rd Party  ', 'Été', '']) {
      expect(conceptKeyMjs(text)).toBe(conceptKey(text));
    }
  });
});

describe('the real duplicate pairs are recognised', () => {
  it('every default pair in bin/retire-duplicate-requirements is an alias of its canonical requirement', () => {
    // Read out of the script itself so a pair added there has to be added to the pack.
    const block = duplicatePlanRaw.match(/DEFAULT_DUPLICATE_SLUGS = Object\.freeze\(\{([\s\S]*?)\}\)/)![1];
    const pairs = [...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    for (const [duplicateSlug, canonicalSlug] of pairs) {
      const name = duplicateSlug.replace(/-/g, ' ');
      const hit = findDuplicateConcept({
        name,
        slug: duplicateSlug,
        rows: seeded('requirements'),
        packItems: packItems('requirements'),
      });
      expect(hit, `"${name}" should be refused as ${canonicalSlug}`).toMatchObject({
        source: 'existing',
        slug: canonicalSlug,
        matched_on: 'pack_alias',
      });
    }
  });

  it('"Spec Sheet" is the Specification Sheet document type', () => {
    const hit = findDuplicateConcept({
      name: 'Spec Sheet',
      slug: 'spec-sheet',
      rows: seeded('document_types'),
      packItems: packItems('document_types'),
    });
    expect(hit).toMatchObject({ source: 'existing', slug: 'specification-sheet', matched_on: 'pack_alias' });
    expect(describeDuplicateConcept('document type', 'Spec Sheet', hit!)).toMatch(
      /another name for the document type "Specification Sheet" \(specification-sheet\)/,
    );
  });
});

describe('findDuplicateConcept', () => {
  const rows = [row('Certificate of Analysis', 'certificate-of-analysis'), row('Old Thing', 'old-thing', false)];

  it('finds an existing row by normalised name', () => {
    expect(
      findDuplicateConcept({ name: 'certificate  of ANALYSIS', slug: 'x', rows, packItems: [] }),
    ).toMatchObject({ source: 'existing', slug: 'certificate-of-analysis', matched_on: 'name' });
  });

  it('finds an existing row by its slug', () => {
    const renamed = [row('COA (ours)', 'certificate-of-analysis')];
    expect(
      findDuplicateConcept({ name: 'Certificate of Analysis', slug: 'y', rows: renamed, packItems: [] }),
    ).toMatchObject({ source: 'existing', matched_on: 'slug', name: 'COA (ours)' });
  });

  it('an INACTIVE row is still the concept, and the answer says it is switched off', () => {
    const hit = findDuplicateConcept({ name: 'Old Thing', slug: 'old-thing-2', rows, packItems: [] })!;
    expect(hit).toMatchObject({ source: 'existing', active: false });
    expect(describeDuplicateConcept('requirement', 'Old Thing', hit)).toMatch(/switched off \(reactivate it/);
  });

  it('a pack item the organisation does not hold is named as the PACK\'s', () => {
    const hit = findDuplicateConcept({ name: 'COA', slug: 'coa', rows: [], packItems: packItems('document_types') });
    expect(hit).toEqual({
      source: 'pack',
      pack: 'fsqa',
      name: 'Certificate of Analysis',
      slug: 'certificate-of-analysis',
      matched_on: 'alias',
    });
  });

  it('creating the pack\'s item under the pack\'s own slug is not a duplicate', () => {
    expect(
      findDuplicateConcept({
        name: 'Certificate of Analysis',
        slug: 'certificate-of-analysis',
        rows: [],
        packItems: packItems('document_types'),
      }),
    ).toBeNull();
  });

  it('a rename never trips over the row itself, or over its own pack item', () => {
    const all = seeded('document_types');
    const self = all.find((r) => r.slug === 'specification-sheet')!;
    // Renaming the pack's own type TO one of its aliases is that type, renamed.
    expect(
      findDuplicateConcept({
        name: 'Spec Sheet',
        slug: self.slug,
        rows: all,
        packItems: packItems('document_types'),
        excludeId: self.id,
      }),
    ).toBeNull();
    // Renaming it INTO another type's name is a duplicate.
    expect(
      findDuplicateConcept({
        name: 'Safety Data Sheet',
        slug: self.slug,
        rows: all,
        packItems: packItems('document_types'),
        excludeId: self.id,
      }),
    ).toMatchObject({ source: 'existing', slug: 'safety-data-sheet' });
    // ...including by alias.
    expect(
      findDuplicateConcept({
        name: 'MSDS',
        slug: self.slug,
        rows: all,
        packItems: packItems('document_types'),
        excludeId: self.id,
      }),
    ).toMatchObject({ source: 'existing', slug: 'safety-data-sheet', matched_on: 'pack_alias' });
  });

  it('an unrelated name is nobody\'s duplicate', () => {
    expect(
      findDuplicateConcept({
        name: 'Dock Receiving Log',
        slug: 'dock-receiving-log',
        rows: seeded('document_types'),
        packItems: packItems('document_types'),
      }),
    ).toBeNull();
    expect(findDuplicateConcept({ name: '  ', slug: '', rows, packItems: [] })).toBeNull();
  });
});

describe('aliases in a pack are validated where they are edited', () => {
  const base = () => ({
    pack: 'test',
    version: 1,
    document_types: [
      { name: 'Specification Sheet', aliases: ['Spec Sheet'] },
      { name: 'Certificate of Analysis' },
    ],
  });

  it('carries them through, deduped on the comparison key', () => {
    const pack = base() as any;
    pack.document_types[0].aliases = ['Spec Sheet', 'spec-sheet', 'Specification Sheet'];
    expect(normalizePack(pack).document_types[0].aliases).toEqual(['Spec Sheet']);
    expect(normalizePack(pack).document_types[1].aliases).toEqual([]);
  });

  it('refuses an alias another item already answers to', () => {
    const pack = base() as any;
    pack.document_types[1].aliases = ['spec sheet'];
    expect(() => normalizePack(pack)).toThrow(/"spec sheet" is already a name, slug or alias of "Specification Sheet"/);
    const second = base() as any;
    second.document_types[0].aliases = ['Certificate of Analysis'];
    expect(() => normalizePack(second)).toThrow(/one spelling may only mean one item/);
  });

  it('refuses a malformed list', () => {
    const pack = base() as any;
    pack.document_types[0].aliases = 'Spec Sheet';
    expect(() => normalizePack(pack)).toThrow(/"aliases" must be an array/);
    const empty = base() as any;
    empty.document_types[0].aliases = ['  '];
    expect(() => normalizePack(empty)).toThrow(/empty entry/);
  });
});
