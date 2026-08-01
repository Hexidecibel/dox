/**
 * Starter-pack compiler tests (P2).
 *
 * The packs are the artifact that decides whether "a new vertical is a
 * configuration exercise" is true. These tests hold two lines:
 *   1. The compiler is safe — validation catches the mistakes a NON-ENGINEER
 *      editing the JSON would actually make (typo'd slug reference, duplicate
 *      slug, bad grain) with a message naming the offending entry.
 *   2. The shipped packs are honest — fsqa carries the two audit documents as
 *      genuinely distinct rows, and finance invents no retention precision.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePack,
  packToStatements,
  packSummary,
  slugify,
  sqlQuote,
} from '../../bin/lib/starter-packs.mjs';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';
import financeRaw from '../../starter-packs/finance.json?raw';

const fsqa = JSON.parse(fsqaRaw);
const finance = JSON.parse(financeRaw);

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

  it('emits one statement per row, across all four tables', () => {
    const summary = packSummary(fsqa);
    const statements = packToStatements(fsqa, TENANT);
    expect(statements.length).toBe(
      summary.document_types + summary.requirements + summary.claim_types + summary.claim_rules,
    );
    const count = (table: string) => statements.filter((s) => s.includes(`INTO ${table} `)).length;
    expect(count('document_types')).toBe(summary.document_types);
    expect(count('requirements')).toBe(summary.requirements);
    expect(count('claim_types')).toBe(summary.claim_types);
    expect(count('claim_type_requirements')).toBe(summary.claim_rules);
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
