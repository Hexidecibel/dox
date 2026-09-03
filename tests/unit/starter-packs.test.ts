/**
 * Starter-pack compiler tests (P2, extended for the setup wizard).
 *
 * The packs are the artifact that decides whether "a new vertical is a
 * configuration exercise" is true. These tests hold three lines:
 *   1. The compiler is safe — validation catches the mistakes a NON-ENGINEER
 *      editing the JSON would actually make (typo'd slug reference, duplicate
 *      slug, bad grain, a `closes` pointing at nothing) with a message naming
 *      the offending entry.
 *   2. The shipped packs are honest — fsqa carries the two audit documents as
 *      genuinely distinct rows, and finance invents no retention precision.
 *   3. A seeded tenant can DEMONSTRATE the system, not merely hold a
 *      vocabulary: every type says what it closes and who owns it, every
 *      analyte carries the spellings suppliers print, and the four things a
 *      pack must never write stay unwritten.
 *
 * Two of these assertions deliberately reach into the REAL implementations
 * rather than restating the rule: `validateLimitShape` and `matchSpecTest`
 * from shared/specCheck.ts, so a pack that compiles but would be rejected by
 * the database — or an alias map that judges nothing — fails here.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePack,
  packToStatements,
  packSummary,
  summaryLine,
  slugify,
  sqlQuote,
  sqlNum,
} from '../../bin/lib/starter-packs.mjs';
import { MODULE_KEYS } from '../../shared/modules';
import { validateLimitShape, matchSpecTest } from '../../shared/specCheck';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';
import financeRaw from '../../starter-packs/finance.json?raw';
import seedScriptRaw from '../../bin/seed-doctype-extraction-instructions?raw';

const fsqa = JSON.parse(fsqaRaw);
const finance = JSON.parse(financeRaw);
const PACKS: Array<[string, any]> = [
  ['fsqa', fsqa],
  ['finance', finance],
];

const TENANT = { tenantId: 'tenant_x', tenantSlug: 'acme-foods' };

describe('starter packs — shipped packs are valid', () => {
  it('fsqa normalizes without error', () => {
    expect(() => normalizePack(fsqa)).not.toThrow();
  });

  it('finance normalizes without error', () => {
    expect(() => normalizePack(finance)).not.toThrow();
  });

  it('every claim rule points at a claim and requirement defined in the same pack', () => {
    // normalizePack throws on a dangling reference; the assertion here is that
    // the shipped packs resolve every rule to real rows.
    for (const pack of [fsqa, finance]) {
      const norm = normalizePack(pack);
      const reqSlugs = new Set(norm.requirements.map((r: any) => r.slug));
      const claimSlugs = new Set(norm.claim_types.map((c: any) => c.slug));
      for (const rule of norm.claim_rules) {
        expect(claimSlugs.has(rule.claim)).toBe(true);
        for (const slug of [...rule.requires, ...rule.recommends]) {
          expect(reqSlugs.has(slug)).toBe(true);
        }
      }
    }
  });

  it('slugs are unique within each vocabulary', () => {
    for (const pack of [fsqa, finance]) {
      const norm = normalizePack(pack);
      for (const key of ['document_types', 'requirements', 'claim_types'] as const) {
        const slugs = norm[key].map((i: any) => i.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
      }
    }
  });
});

describe('fsqa pack — the two audit documents are distinct', () => {
  const norm = normalizePack(fsqa);

  it('carries the audit REPORT and the audit CERTIFICATE as separate document types', () => {
    const report = norm.document_types.find(
      (d: any) => d.slug === '3rd-party-food-safety-audit-report',
    );
    const cert = norm.document_types.find((d: any) => d.slug === '3rd-party-audit-certificate');
    expect(report).toBeDefined();
    expect(cert).toBeDefined();
    expect(report.slug).not.toBe(cert.slug);
    // Their different expiry behaviour is stated on the row, since
    // document_types has no renewal columns to encode it structurally.
    expect(report.description).toMatch(/superseded/i);
    expect(cert.description).toMatch(/expir/i);
  });

  it('carries them as separate checklist line items too', () => {
    const slugs = norm.requirements.map((r: any) => r.slug);
    expect(slugs).toContain('third-party-audit-report');
    expect(slugs).toContain('third-party-audit-certificate');
  });

  it('a GFSI-certified claim opens BOTH audit requirements', () => {
    const rule = norm.claim_rules.find((r: any) => r.claim === 'gfsi-certified');
    expect(rule).toBeDefined();
    expect(rule.requires).toContain('third-party-audit-report');
    expect(rule.requires).toContain('third-party-audit-certificate');
  });

  it('seeds the claim types a food-safety tenant needs', () => {
    const slugs = norm.claim_types.map((c: any) => c.slug);
    for (const expected of ['organic', 'kosher', 'gluten-free', 'non-gmo']) {
      expect(slugs).toContain(expected);
    }
  });

  it('maps each certification claim to its proving certificate', () => {
    const byClaim = Object.fromEntries(norm.claim_rules.map((r: any) => [r.claim, r]));
    expect(byClaim['organic'].requires).toContain('organic-certificate');
    expect(byClaim['kosher'].requires).toContain('kosher-certificate');
    expect(byClaim['gluten-free'].requires).toContain('gluten-free-certificate');
    expect(byClaim['non-gmo'].requires).toContain('non-gmo-certificate');
  });
});

describe('finance pack — minimal and honest', () => {
  const norm = normalizePack(finance);

  it('documents what was deliberately left out', () => {
    expect(Array.isArray(finance._deliberately_omitted)).toBe(true);
    expect(finance._deliberately_omitted.join(' ')).toMatch(/retention/i);
  });

  it('invents no retention periods', () => {
    const text = JSON.stringify({
      document_types: norm.document_types,
      requirements: norm.requirements,
      claim_types: norm.claim_types,
    });
    // No "7 years", "permanent retention", etc. anywhere in the seeded rows.
    expect(text).not.toMatch(/\b\d+\s*years?\b/i);
    expect(text).not.toMatch(/\bretain(ed)? for\b/i);
  });

  it('seeds only the claims that unambiguously open a named document', () => {
    expect(norm.claim_types.length).toBeLessThanOrEqual(3);
    for (const claim of norm.claim_types) {
      const rule = norm.claim_rules.find((r: any) => r.claim === claim.slug);
      expect(rule, `claim ${claim.slug} has no rule`).toBeDefined();
      expect(rule.requires.length).toBeGreaterThan(0);
    }
  });

  it('carries no food-specific vocabulary', () => {
    const text = JSON.stringify(norm).toLowerCase();
    for (const word of ['allergen', 'haccp', 'kosher', 'organic', 'gtin']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('starter packs — validation catches editing mistakes', () => {
  const base = () => ({
    pack: 'test',
    document_types: [],
    requirements: [{ name: 'Thing on file', slug: 'thing' }],
    claim_types: [{ name: 'Claimy', slug: 'claimy' }],
    claim_rules: [{ claim: 'claimy', requires: ['thing'] }],
  });

  it('rejects a claim rule pointing at an undefined requirement', () => {
    const pack = base();
    pack.claim_rules[0].requires = ['not-a-thing'];
    expect(() => normalizePack(pack)).toThrow(/not defined in requirements/);
  });

  it('rejects a claim rule pointing at an undefined claim', () => {
    const pack = base();
    pack.claim_rules[0].claim = 'ghost';
    expect(() => normalizePack(pack)).toThrow(/not defined in claim_types/);
  });

  it('rejects duplicate slugs in one vocabulary', () => {
    const pack = base();
    pack.requirements.push({ name: 'Thing again', slug: 'thing' });
    expect(() => normalizePack(pack)).toThrow(/duplicate slug "thing"/);
  });

  it('rejects an unknown subject_grain and names the offender', () => {
    const pack = base() as any;
    pack.claim_types[0].subject_grain = 'lot';
    expect(() => normalizePack(pack)).toThrow(/Claimy.*subject_grain/s);
  });

  it('rejects an entry with no name', () => {
    const pack = base() as any;
    pack.requirements.push({ slug: 'nameless' });
    expect(() => normalizePack(pack)).toThrow(/missing "name"/);
  });

  it('rejects a pack with no pack name', () => {
    expect(() => normalizePack({ requirements: [] } as any)).toThrow(/"pack" name/);
  });

  it('derives a slug from the name when none is given', () => {
    const norm = normalizePack({
      pack: 'test',
      requirements: [{ name: '100g Nutritionals!' }],
    } as any);
    expect(norm.requirements[0].slug).toBe('100g-nutritionals');
  });
});

describe('starter packs — SQL generation', () => {
  it('emits only INSERT OR IGNORE statements', () => {
    const statements = packToStatements(fsqa, TENANT);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s.startsWith('INSERT OR IGNORE INTO ')).toBe(true);
  });

  it('emits one statement per row, across every table it writes', () => {
    const summary = packSummary(fsqa);
    const statements = packToStatements(fsqa, TENANT);
    const count = (table: string) => statements.filter((s) => s.includes(`INTO ${table} `)).length;
    expect(count('document_types')).toBe(summary.document_types);
    expect(count('requirements')).toBe(summary.requirements);
    expect(count('claim_types')).toBe(summary.claim_types);
    expect(count('claim_type_requirements')).toBe(summary.claim_rules);
    expect(count('owner_labels')).toBe(summary.owner_labels);
    expect(count('document_type_requirements')).toBe(summary.document_type_requirements);
    expect(count('document_type_extraction_instructions')).toBe(summary.extraction_instructions);
    expect(count('spec_tests')).toBe(summary.spec_tests);
    expect(count('spec_limits')).toBe(summary.spec_limits);
    expect(count('tenant_modules')).toBe(summary.modules_on + summary.modules_off);
    // Nothing else: every statement belongs to one of the ten tables above.
    expect(statements.length).toBe(
      summary.document_types +
        summary.requirements +
        summary.claim_types +
        summary.claim_rules +
        summary.owner_labels +
        summary.document_type_requirements +
        summary.extraction_instructions +
        summary.spec_tests +
        summary.spec_limits +
        summary.modules_on +
        summary.modules_off,
    );
  });

  it('writes NOTHING for the two things a pack only DEFINES', () => {
    const statements = packToStatements(fsqa, TENANT).join('\n');
    // A packet needs a supplier and a new tenant has none; bulk application is
    // the defect this format exists to avoid.
    expect(statements).not.toContain('supplier_requirements');
    // And the four the packs name in _deliberately_omitted.
    expect(statements).not.toContain('owner_routes');
    expect(statements).not.toContain('extraction_context');
    expect(statements).not.toContain('naming_templates');
    expect(normalizePack(fsqa).requirement_packets.length).toBeGreaterThan(0);
    expect(normalizePack(fsqa).teach).not.toBeNull();
  });

  it('derives deterministic ids from the tenant slug — the basis of idempotency', () => {
    const a = packToStatements(fsqa, TENANT);
    const b = packToStatements(fsqa, TENANT);
    expect(a).toEqual(b);
    expect(a.some((s) => s.includes("'req_acme-foods_spec-sheet'"))).toBe(true);
    expect(a.some((s) => s.includes("'clm_acme-foods_organic'"))).toBe(true);
    expect(a.some((s) => s.includes("'dt_acme-foods_specification-sheet'"))).toBe(true);
  });

  it('scopes every row to the given tenant', () => {
    const statements = packToStatements(fsqa, TENANT);
    for (const s of statements) expect(s).toContain("'tenant_x'");
  });

  it('marks recommends as is_required 0 and requires as 1', () => {
    const statements = packToStatements(fsqa, TENANT).filter((s) =>
      s.includes('INTO claim_type_requirements '),
    );
    const organic = statements.find((s) => s.includes('clm_acme-foods_organic'));
    expect(organic).toMatch(/'req_acme-foods_organic-certificate', 1,/);
    const rbst = statements.find((s) => s.includes('clm_acme-foods_rbst-free'));
    expect(rbst).toMatch(/'req_acme-foods_letter-of-guarantee', 0,/);
  });

  it('escapes apostrophes in seeded text', () => {
    const statements = packToStatements(
      {
        pack: 'test',
        requirements: [{ name: "Supplier's letter", slug: 'letter' }],
      } as any,
      TENANT,
    );
    expect(statements[0]).toContain("'Supplier''s letter'");
  });

  it('requires a tenant id and slug', () => {
    expect(() => packToStatements(fsqa, { tenantSlug: 'x' } as any)).toThrow(/tenantId/);
    expect(() => packToStatements(fsqa, { tenantId: 'x' } as any)).toThrow(/tenantSlug/);
  });
});

describe('starter packs — helpers', () => {
  it('slugify matches the document_types rule', () => {
    expect(slugify('3rd Party Audit Certificate')).toBe('3rd-party-audit-certificate');
    expect(slugify('  Gluten-Free  ')).toBe('gluten-free');
    expect(slugify('A/B & C')).toBe('a-b-c');
  });

  it('sqlQuote renders null as NULL and doubles quotes', () => {
    expect(sqlQuote(null)).toBe('NULL');
    expect(sqlQuote(undefined)).toBe('NULL');
    expect(sqlQuote("it's")).toBe("'it''s'");
  });
});


// ---------------------------------------------------------------------------
// The new keys: a seeded tenant that can DEMONSTRATE the system
// ---------------------------------------------------------------------------

describe('starter packs — every shipped pack is demonstrable', () => {
  it.each(PACKS)('%s: every document type says who owns it, and it is a declared department', (_n, pack) => {
    const norm = normalizePack(pack);
    const keys = new Set(norm.owner_labels.map((o: any) => o.owner_key));
    expect(keys.size).toBeGreaterThan(0);
    for (const dt of norm.document_types) {
      expect(dt.owner, `${dt.name} has no owner`).toBeTruthy();
      // documents.owner routes through owner_routes on a NORMALIZED key. An
      // owner that is not a declared department is a value that routes to
      // nobody, forever.
      expect(keys.has(dt.owner_key), `${dt.name}: owner "${dt.owner}" is not declared`).toBe(true);
    }
  });

  it.each(PACKS)('%s: every "closes" entry resolves to a requirement in the same pack', (_n, pack) => {
    const norm = normalizePack(pack);
    const reqs = new Set(norm.requirements.map((r: any) => r.slug));
    let total = 0;
    for (const dt of norm.document_types) {
      for (const slug of dt.closes) {
        expect(reqs.has(slug), `${dt.name} closes unknown "${slug}"`).toBe(true);
        total += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('fsqa: the Specification Sheet is the multi-close document the checklist depends on', () => {
    const norm = normalizePack(fsqa);
    const spec = norm.document_types.find((d: any) => d.slug === 'specification-sheet');
    // The lesson "one document, several line items" is only true if a document
    // in the shipped vocabulary actually behaves that way.
    expect(spec.closes.length).toBeGreaterThanOrEqual(3);
    expect(spec.closes).toContain('micro-limits');
  });

  it('fsqa: a certificate of analysis does NOT close the product-level limits line', () => {
    const norm = normalizePack(fsqa);
    const coa = norm.document_types.find((d: any) => d.slug === 'certificate-of-analysis');
    // A COA reports THIS LOT's results; micro-limits asks for the PRODUCT's
    // limits. This is the decoy the wizard teaches with, and it has to stay
    // wrong for the lesson to be honest.
    expect(coa.closes).not.toContain('micro-limits');
    expect(coa.closes).toContain('coa-on-file');
  });

  it.each(PACKS)('%s: every requirement packet resolves, and nothing is both required and recommended', (_n, pack) => {
    const norm = normalizePack(pack);
    const reqs = new Set(norm.requirements.map((r: any) => r.slug));
    expect(norm.requirement_packets.length).toBeGreaterThan(0);
    for (const packet of norm.requirement_packets) {
      for (const slug of [...packet.requirements, ...packet.recommends]) {
        expect(reqs.has(slug), `${packet.name}: unknown "${slug}"`).toBe(true);
      }
      for (const slug of packet.recommends) expect(packet.requirements).not.toContain(slug);
    }
    // Exactly one default, so the wizard has an unambiguous first offer.
    expect(norm.requirement_packets.filter((p: any) => p.default).length).toBe(1);
  });

  it.each(PACKS)('%s: names only modules this build actually has', (_n, pack) => {
    // The compiler WARNS rather than throws (a pack must not be a build
    // dependency of shared/modules.ts). This test is where the shipped packs
    // are held to the stricter standard, with the real MODULE_KEYS imported.
    const norm = normalizePack(pack, { moduleKeys: [...MODULE_KEYS] });
    expect(norm.warnings).toEqual([]);
    expect(norm.modules.default_on.length + norm.modules.default_off.length).toBeGreaterThan(0);
  });

  it('fsqa: order fulfillment starts OFF — COA convergence is the last phase', () => {
    const norm = normalizePack(fsqa);
    expect(norm.modules.default_off).toContain('fulfillment');
    expect(norm.modules.default_on).toContain('library');
  });

  it.each(PACKS)('%s: the teaching example is checked against the pack itself', (_n, pack) => {
    const norm = normalizePack(pack);
    expect(norm.teach).not.toBeNull();
    const type = norm.document_types.find((d: any) => d.slug === norm.teach.document_type);
    expect(type).toBeDefined();
    // Only tick what a document of this type really does close.
    for (const slug of norm.teach.closes) expect(type.closes).toContain(slug);
    // The decoy is the tempting WRONG answer, and the mirror names a type that
    // really does close it.
    expect(type.closes).not.toContain(norm.teach.decoy);
    expect(norm.teach.decoy_reason).toBeTruthy();
    const other = norm.document_types.find(
      (d: any) => d.slug === norm.teach.also_closed_by.document_type,
    );
    expect(other.closes).toContain(norm.teach.also_closed_by.requirement);
  });
});

describe('fsqa spec tests — the synonym map is the load-bearing part', () => {
  const norm = normalizePack(fsqa);

  it('ships an alias list for every analyte', () => {
    expect(norm.spec_tests.length).toBeGreaterThan(0);
    for (const test of norm.spec_tests) {
      // Matching is EXACT on the normalized printed name. An analyte with no
      // aliases only matches a supplier that prints our canonical spelling.
      expect(test.aliases.length, `${test.name} has no aliases`).toBeGreaterThan(0);
    }
  });

  it('resolves every printed spelling back to its own analyte — using the real matcher', () => {
    const defs = norm.spec_tests.map((t: any) => ({
      id: t.slug,
      name: t.name,
      aliases: t.aliases,
      default_unit: t.default_unit,
    }));
    for (const test of norm.spec_tests) {
      for (const spelling of [test.name, ...test.aliases]) {
        const hit = matchSpecTest(spelling, defs as any);
        expect(hit, `"${spelling}" matched nothing`).not.toBeNull();
        // The real failure mode is not "no match" but "matched the WRONG
        // analyte" — SPC's limit silently judging a coliform count.
        expect(hit!.name, `"${spelling}" resolved to ${hit!.name}`).toBe(test.name);
      }
    }
  });

  it('does not fold distinct tests into one another', () => {
    const defs = norm.spec_tests.map((t: any) => ({ id: t.slug, name: t.name, aliases: t.aliases }));
    // Three pairs that a careless alias list would merge, each with a
    // genuinely different threshold.
    expect(matchSpecTest('Total Coliform', defs as any)!.name).toBe('Coliform');
    expect(matchSpecTest('Fecal Coliforms', defs as any)!.name).toBe('Fecal Coliform');
    expect(matchSpecTest('E. coli', defs as any)!.name).toBe('E. coli');
  });

  it('every limit passes the SAME validator the database write path uses', () => {
    for (const test of norm.spec_tests) {
      if (!test.limit) continue;
      expect(validateLimitShape(test.limit), `${test.name}`).toBeNull();
    }
  });

  it('covers the operators that would otherwise never be exercised', () => {
    const ops = new Set(norm.spec_tests.filter((t: any) => t.limit).map((t: any) => t.limit.operator));
    expect(ops.has('<=')).toBe(true);
    expect(ops.has('absent')).toBe(true);
    expect(ops.has('between')).toBe(true);
  });

  it('carries a unit on every numeric limit, or declares the analyte dimensionless', () => {
    for (const test of norm.spec_tests) {
      if (!test.limit || test.limit.operator === 'absent') continue;
      const unit = test.limit.unit || test.default_unit;
      // pH and water activity are genuinely unit-less; they reach here as an
      // explicit null, which the compiler only accepts when the key is present.
      if (unit === null) expect(['pH', 'Water Activity']).toContain(test.name);
      else expect(typeof unit).toBe('string');
    }
  });
});

describe('extraction instructions — one copy, in the pack', () => {
  const norm = normalizePack(fsqa);

  it('fsqa carries type-level guidance for the heaviest types, Certificate of Analysis included', () => {
    const withText = norm.document_types.filter((d: any) => d.extraction_instructions);
    expect(withText.length).toBeGreaterThanOrEqual(11);
    const coa = norm.document_types.find((d: any) => d.slug === 'certificate-of-analysis');
    expect(coa.extraction_instructions).toBeTruthy();
    // The type the corpus is heaviest in, and the defect the corpus is
    // heaviest in: one certificate covering several lots collapsed into one
    // record.
    expect(coa.extraction_instructions).toMatch(/ONE RECORD PER LOT/);
  });

  it('never tells the model what a page says', () => {
    for (const dt of norm.document_types) {
      const text: string = dt.extraction_instructions || '';
      if (!text) continue;
      // TABLE EXTRACTION RULE 14: a result carrying an invented unit cannot be
      // matched against a configured limit and drops out of spec checking with
      // nobody told. Guidance must never license one.
      expect(text, `${dt.name}`).not.toMatch(/results (on|in) this (certificate|document) are in /i);
    }
  });

  it('bin/seed-doctype-extraction-instructions holds no second copy of the texts', () => {
    // The two used to be independent copies of the same opinions, free to
    // drift. The script now resolves them from the pack by slug; this is the
    // lock that keeps it that way.
    expect(seedScriptRaw).toContain('PACK_FILE');
    expect(seedScriptRaw).toContain('extraction_instructions');
    expect(seedScriptRaw).not.toContain('instructions: [');
    // And the reuse is real: a distinctive sentence from the original script
    // is now only in the pack.
    const spec = norm.document_types.find((d: any) => d.slug === 'specification-sheet');
    expect(spec.extraction_instructions).toContain('A spec sheet describes a PRODUCT, not a lot.');
  });
});

describe('starter packs — the new keys are validated for the JSON editor', () => {
  const base = () => ({
    pack: 'test',
    owner_labels: [{ label: 'QA' }],
    document_types: [{ name: 'Thing Sheet', slug: 'thing-sheet', owner: 'QA', closes: ['thing'] }],
    requirements: [
      { name: 'Thing on file', slug: 'thing' },
      { name: 'Other on file', slug: 'other' },
    ],
  });

  it('rejects a "closes" pointing at a requirement that does not exist', () => {
    const pack = base() as any;
    pack.document_types[0].closes = ['ghost'];
    expect(() => normalizePack(pack)).toThrow(/closes "ghost" is not defined in requirements/);
  });

  it('rejects an owner that is not a declared department, and lists the ones that are', () => {
    const pack = base() as any;
    pack.document_types[0].owner = 'Purchasing';
    expect(() => normalizePack(pack)).toThrow(/owner "Purchasing" is not one of this pack's owner_labels \(QA\)/);
  });

  it('accepts an owner that differs only in case or spacing', () => {
    const pack = base() as any;
    pack.document_types[0].owner = ' qa ';
    // owner_key is normalized the way alert-routing normalizes it, so these
    // are the same department rather than two.
    expect(normalizePack(pack).document_types[0].owner_key).toBe('qa');
  });

  it('rejects two departments that normalize to the same key', () => {
    const pack = base() as any;
    pack.owner_labels.push({ label: 'qa' });
    expect(() => normalizePack(pack)).toThrow(/duplicate department/);
  });

  it('rejects empty extraction instructions rather than pinning an empty row', () => {
    const pack = base() as any;
    pack.document_types[0].extraction_instructions = '   ';
    expect(() => normalizePack(pack)).toThrow(/is empty — omit the key instead/);
  });

  it('accepts extraction instructions as an array of lines', () => {
    const pack = base() as any;
    pack.document_types[0].extraction_instructions = ['One.', '', 'Two.'];
    expect(normalizePack(pack).document_types[0].extraction_instructions).toBe('One.\n\nTwo.');
  });

  it('rejects a packet naming a requirement that does not exist', () => {
    const pack = base() as any;
    pack.requirement_packets = [{ name: 'Baseline', requirements: ['ghost'] }];
    expect(() => normalizePack(pack)).toThrow(/Baseline.*not defined in requirements/s);
  });

  it('rejects a packet that both requires and recommends the same item', () => {
    const pack = base() as any;
    pack.requirement_packets = [{ name: 'Baseline', requirements: ['thing'], recommends: ['thing'] }];
    expect(() => normalizePack(pack)).toThrow(/both required and recommended/);
  });

  it('rejects a spec limit with a missing bound', () => {
    const pack = base() as any;
    pack.spec_tests = [{ name: 'Coliform', aliases: ['Coliforms'], limit: { operator: '<=', unit: 'CFU/g' } }];
    expect(() => normalizePack(pack)).toThrow(/needs "value_max"/);
  });

  it('rejects a reversed "between" range', () => {
    const pack = base() as any;
    pack.spec_tests = [
      { name: 'pH', limit: { operator: 'between', value_min: 7, value_max: 6, unit: null } },
    ];
    expect(() => normalizePack(pack)).toThrow(/greater than value_max/);
  });

  it('rejects bounds on an "absent" limit', () => {
    const pack = base() as any;
    pack.spec_tests = [{ name: 'Salmonella', limit: { operator: 'absent', value_max: 0 } }];
    expect(() => normalizePack(pack)).toThrow(/takes no value_min/);
  });

  it('rejects an unknown operator, severity or criticality', () => {
    const mk = (limit: any) => {
      const pack = base() as any;
      pack.spec_tests = [{ name: 'Coliform', limit }];
      return () => normalizePack(pack);
    };
    expect(mk({ operator: '≤', value_max: 10, unit: 'CFU/g' })).toThrow(/must be one of/);
    expect(mk({ operator: '<=', value_max: 10, unit: 'CFU/g', severity: 'blocking' })).toThrow(/severity/);
    expect(mk({ operator: '<=', value_max: 10, unit: 'CFU/g', criticality: 'critical' })).toThrow(/criticality/);
  });

  it('demands a unit, a default_unit, or an explicit null', () => {
    const pack = base() as any;
    pack.spec_tests = [{ name: 'Coliform', limit: { operator: '<=', value_max: 10 } }];
    expect(() => normalizePack(pack)).toThrow(/declare the analyte dimensionless/);
    pack.spec_tests[0].limit.unit = null;
    expect(() => normalizePack(pack)).not.toThrow();
  });

  it('refuses to let two analytes claim the same printed spelling', () => {
    const pack = base() as any;
    pack.spec_tests = [
      { name: 'Coliform', aliases: ['Total Coliform'] },
      { name: 'Fecal Coliform', aliases: ['total coliform'] },
    ];
    // matchSpecTest takes the FIRST hit, so the second limit would silently
    // never fire.
    expect(() => normalizePack(pack)).toThrow(/already claimed by "Coliform"/);
  });

  it('refuses a teaching decoy the type actually closes', () => {
    const pack = base() as any;
    pack.teach = { document_type: 'thing-sheet', closes: ['thing'], decoy: 'thing' };
    expect(() => normalizePack(pack)).toThrow(/a decoy has to be the wrong answer/);
  });

  it('refuses a teaching tick the type does not close', () => {
    const pack = base() as any;
    pack.teach = { document_type: 'thing-sheet', closes: ['other'] };
    expect(() => normalizePack(pack)).toThrow(/may only tick what a document of this type actually closes/);
  });

  it('refuses a mirror that names a type closing nothing of the sort', () => {
    const pack = base() as any;
    pack.document_types.push({ name: 'Other Sheet', slug: 'other-sheet', owner: 'QA', closes: [] });
    pack.teach = {
      document_type: 'thing-sheet',
      closes: ['thing'],
      also_closed_by: { requirement: 'other', document_type: 'other-sheet' },
    };
    expect(() => normalizePack(pack)).toThrow(/does not list "other" in its closes/);
  });

  it('WARNS but does not throw on a module key this build does not have', () => {
    const pack = base() as any;
    pack.modules = { default_off: ['telepathy'] };
    const norm = normalizePack(pack, { moduleKeys: [...MODULE_KEYS] });
    expect(norm.warnings.join(' ')).toMatch(/telepathy/);
    expect(norm.modules.default_off).toEqual(['telepathy']);
  });

  it('rejects a module key listed as both on and off', () => {
    const pack = base() as any;
    pack.modules = { default_on: ['library'], default_off: ['library'] };
    expect(() => normalizePack(pack)).toThrow(/both default_on and default_off/);
  });

  it('leaves a pack with none of the new keys entirely valid', () => {
    // Every existing pack must stay valid: additive means additive.
    const norm = normalizePack({
      pack: 'legacy',
      document_types: [{ name: 'Invoice' }],
      requirements: [{ name: 'Invoice on file' }],
    } as any);
    expect(norm.document_types[0].closes).toEqual([]);
    expect(norm.document_types[0].owner).toBeNull();
    expect(norm.owner_labels).toEqual([]);
    expect(norm.spec_tests).toEqual([]);
    expect(norm.teach).toBeNull();
    expect(norm.modules).toEqual({ default_on: [], default_off: [] });
    expect(packToStatements({ pack: 'legacy', requirements: [{ name: 'X' }] } as any, TENANT).length).toBe(1);
  });
});

describe('starter packs — SQL for the new tables', () => {
  const statements = packToStatements(fsqa, TENANT);
  const of = (table: string) => statements.filter((s: string) => s.includes(`INTO ${table} `));

  it('keys a type→requirement default on both slugs, so a re-run collides instead of duplicating', () => {
    expect(of('document_type_requirements').some((s: string) =>
      s.includes("'dtr_acme-foods_specification-sheet__micro-limits'"),
    )).toBe(true);
    // source 'pack' is what makes a wrong default discoverable later.
    for (const s of of('document_type_requirements')) expect(s).toContain("'pack'");
  });

  it('writes the department a type routes to onto document_types.default_owner', () => {
    const coi = of('document_types').find((s: string) => s.includes("'dt_acme-foods_certificate-of-insurance'"));
    expect(coi).toContain("'Insurance'");
  });

  it('writes owner_labels with the normalized key, not the display label', () => {
    const fs = of('owner_labels').find((s: string) => s.includes("'Food Safety'"));
    expect(fs).toContain("'food safety'");
  });

  it('renders spec_limits with all three scope columns literally NULL', () => {
    for (const s of of('spec_limits')) {
      expect(s).toMatch(/spec_test_id, supplier_id, document_type_id, product_id,/);
      expect(s).toMatch(/NULL, NULL, NULL,/);
    }
  });

  it('renders aliases as a JSON array, the shape spec_tests.aliases is read as', () => {
    const spc = of('spec_tests').find((s: string) => s.includes("'Standard Plate Count'"));
    const json = spc!.match(/'(\[.*?\])'/)![1];
    expect(JSON.parse(json)).toContain('APC');
  });

  it('writes both sides of the module decision, not only the off ones', () => {
    const rows = of('tenant_modules');
    expect(rows.some((s: string) => s.includes("'fulfillment', 0"))).toBe(true);
    expect(rows.some((s: string) => s.includes("'library', 1"))).toBe(true);
  });

  it('is byte-identical on a second render — the basis of a safe re-run', () => {
    expect(packToStatements(fsqa, TENANT)).toEqual(statements);
  });

  it('emits nothing but INSERT OR IGNORE, including for the new tables', () => {
    for (const s of statements) expect(s.startsWith('INSERT OR IGNORE INTO ')).toBe(true);
  });
});

describe('starter packs — the CLI summary stays truthful', () => {
  it('counts what is written AND names what is only defined', () => {
    const s = packSummary(fsqa);
    const line = summaryLine(s);
    expect(line).toContain(`${s.document_type_requirements} type→requirement defaults`);
    expect(line).toContain(`${s.spec_tests} spec tests`);
    expect(line).toContain('defined but not seeded');
  });

  it('drops sections a pack does not have rather than printing zeros', () => {
    const line = summaryLine(packSummary(finance));
    // finance seeds no spec tests on purpose — see its _deliberately_omitted.
    expect(line).not.toContain('spec tests');
    expect(line).toContain('document types');
  });

  it('sqlNum renders NULL and refuses a non-finite number', () => {
    expect(sqlNum(null)).toBe('NULL');
    expect(sqlNum(0)).toBe('0');
    expect(() => sqlNum(Infinity)).toThrow();
  });
});
