/**
 * "Is this a second copy of something we already have?" -- one pure answer for
 * the three vocabularies (document types, requirements, claim types).
 *
 * WHY. The client asked for "the same slugs for the same concepts across
 * tenants, so a starter-pack update rolls forward". A pack update reaches a row
 * through its SLUG. So the moment an organisation holds the same concept twice
 * -- the pack's `spec-sheet` requirement and a hand-made "Specification Sheet"
 * under `specification-sheet` -- one of them is invisible to every later
 * update, half the documents close one and half the other, and somebody ends
 * up writing a repair script. `bin/retire-duplicate-requirements` is that
 * script; its three default pairs are real, and they are the aliases this
 * release seeded into the fsqa pack.
 *
 * WHAT COUNTS AS THE SAME. Two names are the same concept when they are equal
 * after lower-casing and dropping everything that is not a letter or a digit
 * (`conceptKey`): "Spec-Sheet", "spec sheet" and "SPEC SHEET" are one name.
 * Nothing fuzzier. "Specification Sheet" and "Spec Sheet" are NOT equal by that
 * rule, and no amount of string distance would safely say so -- which is why
 * the pack carries `aliases`: a person wrote down that they are the same thing.
 * A refusal is always overridable by an admin (and the override is audited),
 * because the pack's author cannot know every organisation's vocabulary.
 *
 * WHAT IS COMPARED, for a proposed name:
 *   (a) every row the organisation holds in that vocabulary, ACTIVE OR NOT --
 *       its name and its slug. An inactive row is still the concept: creating a
 *       twin beside it is how "we deactivated the old one and made a new one"
 *       turns into two slugs for one thing. The answer says it is inactive, so
 *       the screen can say "reactivate it instead".
 *   On a CREATE the proposed SLUG is compared the same way as the name
 *   (`compareSlug`): requirements and claim types accept a caller's slug, and a
 *   second `specsheet` is a second spec sheet whatever name it travels under.
 *   (b) every item of the organisation's starter pack(s): name, slug, aliases.
 *       If the organisation already holds that item (a row with its slug), the
 *       answer names THAT ROW. If it does not, the answer names the pack item,
 *       and the caller may create the row under the PACK'S slug instead -- which
 *       is the outcome that keeps slugs the same everywhere.
 *
 * A name whose own slug IS the pack item's slug is not a duplicate of it: it is
 * the pack's item, being created under the pack's slug.
 */

/** The comparison key: lower-case, letters and digits only. */
export function conceptKey(text: string | null | undefined): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ConceptRow {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}

export interface ConceptPackItem {
  pack: string;
  name: string;
  slug: string;
  aliases: readonly string[];
}

export type DuplicateConcept =
  | {
      /** The organisation already holds this concept as a row. */
      source: 'existing';
      id: string;
      name: string;
      slug: string;
      active: boolean;
      /** What the proposed name equalled. `pack_alias`: the pack says the two are one thing. */
      matched_on: 'name' | 'slug' | 'pack_alias';
      /** Set when the match came through the pack: which item said so. */
      pack?: string;
      pack_item_name?: string;
    }
  | {
      /** The organisation's starter pack defines this concept and it holds no row for it. */
      source: 'pack';
      pack: string;
      name: string;
      slug: string;
      matched_on: 'name' | 'slug' | 'alias';
    };

export interface DuplicateConceptInput {
  /** The name being created, or renamed TO. */
  name: string;
  /** The slug the row has (rename) or would be given (create). */
  slug: string;
  rows: readonly ConceptRow[];
  packItems: readonly ConceptPackItem[];
  /** A rename: the row itself, which is never its own duplicate. */
  excludeId?: string | null;
  /**
   * A CREATE whose slug the caller may have chosen (requirements and claim
   * types accept one). The slug is then compared as well as the name:
   * otherwise `{ name: "Zed thing", slug: "specsheet" }` is a second
   * `spec-sheet` under a name nobody would recognise. Not set on a rename,
   * where the slug is the row's own and has been there all along.
   */
  compareSlug?: boolean;
}

export function findDuplicateConcept(input: DuplicateConceptInput): DuplicateConcept | null {
  const nameKey = conceptKey(input.name);
  const slugKey = input.compareSlug ? conceptKey(input.slug) : '';
  const keys = new Set([nameKey, slugKey].filter(Boolean));
  if (keys.size === 0) return null;
  const others = input.rows.filter((r) => r.id !== input.excludeId);

  for (const row of others) {
    if (keys.has(conceptKey(row.name))) {
      return { source: 'existing', id: row.id, name: row.name, slug: row.slug, active: row.active, matched_on: 'name' };
    }
  }
  for (const row of others) {
    if (keys.has(conceptKey(row.slug))) {
      return { source: 'existing', id: row.id, name: row.name, slug: row.slug, active: row.active, matched_on: 'slug' };
    }
  }

  for (const item of input.packItems) {
    let matchedOn: 'name' | 'slug' | 'alias' | null = null;
    if (keys.has(conceptKey(item.name))) matchedOn = 'name';
    else if (keys.has(conceptKey(item.slug))) matchedOn = 'slug';
    else if (item.aliases.some((a) => keys.has(conceptKey(a)))) matchedOn = 'alias';
    if (!matchedOn) continue;

    // The row's own concept (a rename back toward the pack's wording), or the
    // pack's item being created under the pack's slug: not a duplicate.
    if (item.slug === input.slug) continue;

    const held = others.find((r) => r.slug === item.slug);
    if (held) {
      return {
        source: 'existing',
        id: held.id,
        name: held.name,
        slug: held.slug,
        active: held.active,
        matched_on: 'pack_alias',
        pack: item.pack,
        pack_item_name: item.name,
      };
    }
    return { source: 'pack', pack: item.pack, name: item.name, slug: item.slug, matched_on: matchedOn };
  }

  return null;
}

/** One sentence a person can act on. `noun` is "document type", "requirement", "claim type". */
export function describeDuplicateConcept(noun: string, proposed: string, dup: DuplicateConcept): string {
  if (dup.source === 'existing') {
    const state = dup.active ? '' : ', which is switched off (reactivate it instead of creating a second one)';
    if (dup.matched_on === 'pack_alias') {
      return (
        `"${proposed}" is another name for the ${noun} "${dup.name}" (${dup.slug})${state}. ` +
        `The starter pack lists it as the same thing as "${dup.pack_item_name}". ` +
        'Use that one, or confirm that you really want a separate one.'
      );
    }
    return (
      `There is already a ${noun} called "${dup.name}" (${dup.slug})${state}. ` +
      'Use that one, or confirm that you really want a separate one.'
    );
  }
  return (
    `"${proposed}" is the starter pack's ${noun} "${dup.name}" (${dup.slug}), which this organisation does not have yet. ` +
    "Create it as the pack's item so later pack updates reach it, or confirm that you really want a separate one."
  );
}
