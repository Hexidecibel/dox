/**
 * The sharing rule, as a pure function (decision C-003; C-038..C-042).
 *
 * What is pinned here is the table of answers, because every exit reads it:
 * which rule a document has, and which exits that rule passes for whom.
 */
import { describe, it, expect } from 'vitest';
import {
  SHARING_EXITS,
  SHARING_RULES,
  SHARING_RULE_LABELS,
  defaultSharingRuleForTypeName,
  describeRefusals,
  effectiveSharingRule,
  judgeExit,
  loosens,
  matchSharingRuleTable,
  parseRefusedHeader,
  parseSharingRule,
  sharingRefusalMessage,
  strictest,
  type ExitActor,
  type SharingExit,
  type SharingRule,
} from '../../shared/sharingRule';
import fsqa from '../../starter-packs/fsqa.json';
import finance from '../../starter-packs/finance.json';

const READER: ExitActor = { method: 'jwt', canReleaseQa: false };
const QA: ExitActor = { method: 'jwt', canReleaseQa: true };
const KEY: ExitActor = { method: 'api_key', canReleaseQa: false };
const LINK: ExitActor = { method: 'link', canReleaseQa: false };

describe('parseSharingRule', () => {
  it('accepts the three words and nothing else', () => {
    expect(parseSharingRule('free')).toBe('free');
    expect(parseSharingRule(' QA ')).toBe('qa');
    expect(parseSharingRule('locked')).toBe('locked');
    for (const bad of [null, undefined, '', 'open', 'public', 0, {}, 'freee']) {
      expect(parseSharingRule(bad)).toBeNull();
    }
  });

  it('has plain words for each rule', () => {
    expect(SHARING_RULE_LABELS).toEqual({
      free: 'Send freely',
      qa: 'Needs QA approval',
      locked: 'Locked',
    });
  });
});

describe('the starting table (C-003)', () => {
  it.each([
    ['Certificate of Analysis', 'free'],
    ['COA', 'free'],
    ['Specification Sheet', 'free'],
    ['Product Spec', 'free'],
    ['Allergen Statement', 'free'],
    ['Kosher Certificate', 'free'],
    ['Halal Certificate', 'free'],
    ['Organic Certificate', 'free'],
    ['Safety Data Sheet', 'free'],
    ['SDS', 'free'],
    ['MSDS', 'free'],
    ['3rd Party Audit Certificate', 'qa'],
    ['HACCP Plan', 'qa'],
    ['Food Safety Plan', 'qa'],
    ['Letter of Guarantee', 'qa'],
    ['Certificate of Insurance', 'qa'],
    ['Insurance Policy', 'qa'],
    ['3rd Party Food Safety Audit Report', 'locked'],
    ['External Audit Report', 'locked'],
    ['W-9', 'locked'],
    ['W9', 'locked'],
  ] as [string, SharingRule][])('%s -> %s', (name, rule) => {
    expect(matchSharingRuleTable(name)).toBe(rule);
    expect(defaultSharingRuleForTypeName(name)).toBe(rule);
  });

  it('a name nobody recognises is qa, and the table says it did not match (C-038)', () => {
    for (const name of ['Business License', 'Invoice', 'Product Label', 'Gluten-Free Certificate', '', '   ']) {
      expect(matchSharingRuleTable(name)).toBeNull();
      expect(defaultSharingRuleForTypeName(name)).toBe('qa');
    }
    expect(defaultSharingRuleForTypeName(null)).toBe('qa');
  });

  it('locked is asked first, and free needs the document\'s own noun', () => {
    // A report is a report whatever it is about.
    expect(defaultSharingRuleForTypeName('Organic Audit Report')).toBe('locked');
    expect(defaultSharingRuleForTypeName('Kosher Audit Certificate')).toBe('qa');
    // The subject alone is not the document.
    expect(defaultSharingRuleForTypeName('Allergen Control Program')).toBe('qa');
    expect(defaultSharingRuleForTypeName('Organic System Plan')).toBe('qa');
    // A COA synonym the renewal default does not treat as a COA is not one here either.
    expect(defaultSharingRuleForTypeName('Certificate of Compliance')).toBe('qa');
    expect(defaultSharingRuleForTypeName('Certificate of Insurance')).toBe('qa');
  });

  it('every starter-pack type gets the rule this table says, and it is written down here', () => {
    const got = (pack: { document_types: { name: string }[] }) =>
      Object.fromEntries(pack.document_types.map((t) => [t.name, defaultSharingRuleForTypeName(t.name)]));

    expect(got(fsqa)).toEqual({
      'Specification Sheet': 'free',
      'Certificate of Analysis': 'free',
      'Safety Data Sheet': 'free',
      '3rd Party Food Safety Audit Report': 'locked',
      '3rd Party Audit Certificate': 'qa',
      'Organic Certificate': 'free',
      'Kosher Certificate': 'free',
      'Halal Certificate': 'free',
      'Gluten-Free Certificate': 'qa',
      'Non-GMO Certificate': 'qa',
      'Animal Welfare Certificate': 'qa',
      'Sustainability Certificate': 'qa',
      'Allergen Statement': 'free',
      'Nutritional Information': 'qa',
      'Country of Origin Statement': 'qa',
      'Product Label': 'qa',
      'Letter of Guarantee': 'qa',
      'Certificate of Insurance': 'qa',
      'W-9': 'locked',
      'Business License': 'qa',
      'FDA Food Facility Registration': 'qa',
      'HACCP Plan': 'qa',
      'Food Safety Plan': 'qa',
      'Food Defense Plan': 'qa',
      'Recall Program': 'qa',
      'Pest Control Program': 'qa',
      'Sanitation Program': 'qa',
      'GMP Self Audit': 'qa',
      'Process Flow Diagram': 'qa',
    });

    expect(got(finance)).toEqual({
      Invoice: 'qa',
      'Purchase Order': 'qa',
      Receipt: 'qa',
      'Bank Statement': 'qa',
      'Bank Reconciliation': 'qa',
      'General Ledger Export': 'qa',
      'Trial Balance': 'qa',
      'Journal Entry Support': 'qa',
      'Financial Statement': 'qa',
      'Tax Return': 'qa',
      'Payroll Register': 'qa',
      'Fixed Asset Register': 'qa',
      'External Audit Report': 'locked',
      Contract: 'qa',
      'Insurance Policy': 'qa',
      'Board Minutes': 'qa',
      'W-9': 'locked',
      '1099': 'qa',
    });
    // Nothing in the finance pack starts out free.
    expect(Object.values(got(finance))).not.toContain('free');
  });
});

describe('effectiveSharingRule', () => {
  it('the override wins over everything, including no type', () => {
    expect(effectiveSharingRule({ override: 'free', hasType: false })).toEqual({ rule: 'free', source: 'override' });
    expect(effectiveSharingRule({ override: 'locked', typeRule: 'free', typeName: 'COA', hasType: true })).toEqual({
      rule: 'locked',
      source: 'override',
    });
  });

  it('a document with no type is locked (C-038)', () => {
    expect(effectiveSharingRule({ hasType: false })).toEqual({ rule: 'locked', source: 'no_type' });
    // A stored rule with no type behind it is not consulted.
    expect(effectiveSharingRule({ typeRule: 'free', typeName: 'COA', hasType: false }).rule).toBe('locked');
  });

  it('then the stored type rule, then the name, then qa', () => {
    expect(effectiveSharingRule({ typeRule: 'locked', typeName: 'COA', hasType: true })).toEqual({
      rule: 'locked',
      source: 'type',
    });
    expect(effectiveSharingRule({ typeRule: null, typeName: 'COA', hasType: true })).toEqual({
      rule: 'free',
      source: 'type_name',
    });
    expect(effectiveSharingRule({ typeRule: null, typeName: 'Invoice', hasType: true })).toEqual({
      rule: 'qa',
      source: 'unrecognised',
    });
  });

  it('a bad stored value can only tighten', () => {
    // Garbage on the type falls through to the name; garbage as an override is ignored.
    expect(effectiveSharingRule({ typeRule: 'public', typeName: 'Invoice', hasType: true }).rule).toBe('qa');
    expect(effectiveSharingRule({ override: 'open', hasType: false }).rule).toBe('locked');
  });
});

describe('strictest (C-042)', () => {
  it('takes the tightest rule on the file', () => {
    expect(strictest(['free', 'free'])).toBe('free');
    expect(strictest(['free', 'qa', 'free'])).toBe('qa');
    expect(strictest(['qa', 'locked', 'free'])).toBe('locked');
  });

  it('a file tied to no document is locked', () => {
    expect(strictest([])).toBe('locked');
  });
});

describe('judgeExit', () => {
  const LEAVING: SharingExit[] = ['zip', 'send', 'bundle', 'order_send'];

  it('a logged-in person opening one file is never asked (C-039)', () => {
    for (const rule of SHARING_RULES) {
      expect(judgeExit(rule, 'portal_file', READER)).toBe('allow');
      expect(judgeExit(rule, 'portal_file', QA)).toBe('allow');
    }
  });

  it('free leaves for anyone; qa only for a QA releaser; locked for nobody', () => {
    for (const exit of LEAVING) {
      expect(judgeExit('free', exit, READER)).toBe('allow');
      expect(judgeExit('free', exit, QA)).toBe('allow');
      expect(judgeExit('qa', exit, READER)).toBe('needs_qa');
      expect(judgeExit('qa', exit, QA)).toBe('allow');
      expect(judgeExit('locked', exit, READER)).toBe('locked');
      expect(judgeExit('locked', exit, QA)).toBe('locked');
    }
  });

  it('an API key reads free only, on every exit, whoever it belongs to (C-041)', () => {
    for (const exit of SHARING_EXITS) {
      expect(judgeExit('free', exit, KEY)).toBe('allow');
      expect(judgeExit('qa', exit, KEY)).toBe('needs_qa');
      expect(judgeExit('locked', exit, KEY)).toBe('locked');
      // Even if a caller wrongly marked the key's owner a releaser.
      expect(judgeExit('qa', exit, { method: 'api_key', canReleaseQa: true })).toBe('needs_qa');
    }
  });

  it('a public link serves free; qa only on the minter\'s authority; never locked (C-045)', () => {
    const MINTED_BY_RELEASER: ExitActor = { method: 'link', canReleaseQa: true };
    expect(judgeExit('free', 'public_link', LINK)).toBe('allow');
    expect(judgeExit('free', 'public_link', MINTED_BY_RELEASER)).toBe('allow');
    // "The mint was the approval" is only true of a releaser's mint.
    expect(judgeExit('qa', 'public_link', MINTED_BY_RELEASER)).toBe('allow');
    expect(judgeExit('qa', 'public_link', LINK)).toBe('needs_qa');
    expect(judgeExit('locked', 'public_link', LINK)).toBe('locked');
    expect(judgeExit('locked', 'public_link', MINTED_BY_RELEASER)).toBe('locked');
    // Nobody else borrows the door: a login or a key asking for this exit
    // gets no qa document through it, releaser or not.
    expect(judgeExit('qa', 'public_link', QA)).toBe('needs_qa');
    expect(judgeExit('qa', 'public_link', KEY)).toBe('needs_qa');
  });

  it('a link holder has no other door, whoever minted the link', () => {
    for (const actor of [LINK, { method: 'link', canReleaseQa: true } as ExitActor]) {
      for (const exit of ['portal_file', ...LEAVING] as SharingExit[]) {
        expect(judgeExit('qa', exit, actor)).toBe('needs_qa');
        expect(judgeExit('locked', exit, actor)).toBe('locked');
      }
    }
  });

  it('loosens: free < qa < locked', () => {
    expect(loosens('locked', 'qa')).toBe(true);
    expect(loosens('locked', 'free')).toBe(true);
    expect(loosens('qa', 'free')).toBe(true);
    expect(loosens('free', 'qa')).toBe(false);
    expect(loosens('qa', 'locked')).toBe(false);
    for (const r of SHARING_RULES) expect(loosens(r, r)).toBe(false);
  });

  it('refusals read in plain words', () => {
    expect(sharingRefusalMessage('locked')).toMatch(/^Locked/);
    expect(sharingRefusalMessage('needs_qa')).toMatch(/^Needs QA approval/);
    expect(sharingRefusalMessage('needs_qa', { apiKey: true })).toContain('API key');
  });
});

describe('saying what was left out', () => {
  it('names each document under its reason, locked first', () => {
    expect(
      describeRefusals([
        { title: 'Guarantee letter', reason: 'needs_qa' },
        { title: 'Tax form', reason: 'locked' },
        { title: 'Unsorted scan', reason: 'locked' },
      ]),
    ).toBe('3 documents were not included. Locked: Tax form, Unsorted scan. Needs QA approval: Guarantee letter.');
    expect(describeRefusals([{ title: 'Tax form', reason: 'locked' }])).toBe(
      '1 document was not included. Locked: Tax form.',
    );
  });

  it('says nothing when nothing was left out, and never prints an empty name', () => {
    expect(describeRefusals([])).toBe('');
    expect(describeRefusals([{ title: null, reason: 'locked' }, { reason: 'locked' }, { title: '  ', reason: 'locked' }])).toBe(
      '3 documents were not included. Locked: Untitled document, Untitled document, Untitled document.',
    );
  });

  it('counts the rest past six names rather than printing fifty', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `Doc ${i + 1}`, reason: 'locked' as const }));
    expect(describeRefusals(many)).toBe(
      '9 documents were not included. Locked: Doc 1, Doc 2, Doc 3, Doc 4, Doc 5, Doc 6, and 3 more.',
    );
  });

  it('reads the header a binary response carries, skipping anything malformed', () => {
    expect(parseRefusedHeader('abc:locked,def:needs_qa')).toEqual([
      { document_id: 'abc', reason: 'locked' },
      { document_id: 'def', reason: 'needs_qa' },
    ]);
    expect(parseRefusedHeader(null)).toEqual([]);
    expect(parseRefusedHeader('')).toEqual([]);
    expect(parseRefusedHeader('abc,def:maybe,:locked,ok:locked')).toEqual([{ document_id: 'ok', reason: 'locked' }]);
  });
});
