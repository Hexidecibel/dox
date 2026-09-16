/**
 * The alias gap, derived: shared/unmatchedAnalytes.ts.
 *
 * WHAT THESE PIN, in order of how much a regression would cost:
 *
 *  1. A spelling a configured analyte DOES answer to never appears. The whole
 *     panel is an argument that these names are being skipped, and a false
 *     entry would send someone to add an alias that already exists.
 *  2. Spellings fold by the MATCH KEY, so "Flavor"/"FLAVOR" and "FAT"/"%FAT"
 *     are one row each. Listing them separately asks a person to do the same
 *     job twice and then leaves one of the two still on the list.
 *  3. A missing LIMIT is not a missing ALIAS. A name that matches an analyte
 *     with no limit in scope is a different gap, and "add it as an alias" there
 *     is advice that changes nothing — so it is excluded.
 *  4. The counts are per RESULT, because that is the number that says what the
 *     gap costs; documents are counted too, and a crosstab printing one
 *     unrecognised analyte on twelve lot rows must not read as one result.
 *
 * The spellings used here are the real ones from the production tenant's
 * unmatched list (522 approved certificates), not invented strings.
 */

import { describe, it, expect } from 'vitest';
import {
  documentSpecSources,
  scanUnmatchedAnalytes,
  type UnmatchedScanDocument,
} from '../../shared/unmatchedAnalytes';
import { normalizeTestName } from '../../shared/specCheck';

const tests = [
  { id: 'st_coliform', name: 'Coliform', aliases: ['Total Coliform', 'COLIFORM AEROBIC'] },
  { id: 'st_spc', name: 'Standard Plate Count', aliases: ['SPC', 'APC'] },
  { id: 'st_ph', name: 'pH', aliases: [] },
];

const limit = {
  id: 'l_coliform',
  spec_test_id: 'st_coliform',
  operator: '<=' as const,
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert' as const,
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
};

/** A limit that only applies to one supplier — the scope-gap fixture. */
const phLimitForOtherSupplier = {
  ...limit,
  id: 'l_ph_other',
  spec_test_id: 'st_ph',
  operator: '<=' as const,
  value_max: 7,
  unit: null,
  supplier_id: 'sup_other',
};

function doc(
  id: string,
  rows: string[][],
  extra: Partial<UnmatchedScanDocument> = {}
): UnmatchedScanDocument {
  return {
    id,
    title: `COA ${id}`,
    supplier_id: 'sup_1',
    supplier_name: 'Country Morning Farms',
    document_type_id: 'dt_coa',
    extended_metadata: JSON.stringify({
      tables: [{ name: 'results', headers: ['test', 'result', 'units'], rows }],
    }),
    ...extra,
  };
}

describe('documentSpecSources', () => {
  it('reads the approved tables and groups a COA approval stored', () => {
    const sources = documentSpecSources(
      JSON.stringify({
        tables: [{ name: 't', headers: ['test', 'result'], rows: [['Coliform', '5']] }],
        groups: { chemistry: { fat: { value: '80', unit: '%' } } },
      })
    );
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.scope === 'ai_fields')).toBe(true);
  });

  it('survives a payload that is missing, empty or corrupt', () => {
    expect(documentSpecSources(null)).toEqual([]);
    expect(documentSpecSources('{ not json')).toEqual([]);
    expect(documentSpecSources(JSON.stringify({ tables: [] }))).toEqual([]);
  });

  it('takes an already-parsed object as well as text', () => {
    const sources = documentSpecSources({
      tables: [{ name: 't', headers: ['test', 'result'], rows: [['Flavor', 'Good']] }],
    });
    expect(sources).toHaveLength(1);
  });
});

describe('scanUnmatchedAnalytes', () => {
  it('never lists a spelling a configured analyte recognises', () => {
    const scan = scanUnmatchedAnalytes(
      [doc('d1', [['Coliform', '5', 'CFU/g'], ['Total Coliform', '<10', 'CFU/g'], ['APC', '200', 'CFU/g']])],
      tests,
      [limit]
    );
    expect(scan.groups.map((g) => g.name)).toEqual([]);
  });

  it('lists what nothing answers to, counted per result and per document', () => {
    const scan = scanUnmatchedAnalytes(
      [
        doc('d1', [['Flavor', 'Good'], ['Color', 'White']]),
        doc('d2', [['Flavor', 'Good'], ['Flavor', 'Clean']]),
      ],
      tests,
      [limit]
    );
    const flavor = scan.groups.find((g) => g.key === normalizeTestName('Flavor'));
    expect(flavor?.results).toBe(3);
    expect(flavor?.documents).toBe(2);
    expect(scan.total_results).toBe(4);
    expect(scan.documents_scanned).toBe(2);
    expect(scan.documents_with_results).toBe(2);
  });

  it('folds the spellings of one analyte onto one row', () => {
    // Every one of these is on the production tenant's list as its own entry.
    const scan = scanUnmatchedAnalytes(
      [
        doc('d1', [['FAT', '80.1'], ['%FAT', '80.3']]),
        doc('d2', [['Fat', '80.0'], ['%fat', '79.8'], ['Flavor', 'Good'], ['FLAVOR', 'GOOD']]),
      ],
      tests,
      [limit]
    );
    const fat = scan.groups.find((g) => g.key === 'fat');
    expect(fat?.results).toBe(4);
    expect(fat?.spellings.map((s) => s.name).sort()).toEqual(['%FAT', '%fat', 'FAT', 'Fat']);
    const flavor = scan.groups.find((g) => g.key === 'flavor');
    expect(flavor?.results).toBe(2);
    expect(flavor?.spellings).toHaveLength(2);
    expect(scan.total_groups).toBe(2);
  });

  it('shows the commonest spelling as the name', () => {
    const scan = scanUnmatchedAnalytes(
      [doc('d1', [['MOISTURE', '1.2'], ['MOISTURE', '1.3'], ['Moisture', '1.1']])],
      tests,
      [limit]
    );
    expect(scan.groups[0].name).toBe('MOISTURE');
  });

  it('orders by the results a spelling costs, most first', () => {
    const scan = scanUnmatchedAnalytes(
      [doc('d1', [['Color', 'White'], ['Aroma', 'Clean'], ['Aroma', 'Clean'], ['Aroma', 'Clean']])],
      tests,
      [limit]
    );
    expect(scan.groups.map((g) => g.name)).toEqual(['Aroma', 'Color']);
  });

  it('excludes a name that matches an analyte but has no limit in scope', () => {
    // pH IS configured; the only pH limit belongs to another supplier. That is a
    // missing limit, not a missing alias, and an alias would fix nothing.
    const scan = scanUnmatchedAnalytes(
      [doc('d1', [['pH', '6.7'], ['Aroma', 'Clean']])],
      tests,
      [limit, phLimitForOtherSupplier]
    );
    expect(scan.groups.map((g) => g.name)).toEqual(['Aroma']);
  });

  it('ignores a blank result — a heading is not a result', () => {
    const scan = scanUnmatchedAnalytes(
      [doc('d1', [['Flavor', ''], ['Flavor', 'Good']])],
      tests,
      [limit]
    );
    expect(scan.groups[0].results).toBe(1);
  });

  it('carries one example, with the value as printed, and the suppliers', () => {
    const scan = scanUnmatchedAnalytes(
      [
        doc('d1', [['Staph cp (cfu/g)', '<10']], {
          supplier_name: 'Willamette Egg Farms',
          supplier_id: 'sup_weg',
        }),
        doc('d2', [['Staph cp (cfu/g)', '<10']], {
          supplier_name: 'Andersen Dairy Inc.',
          supplier_id: 'sup_and',
        }),
      ],
      tests,
      [limit]
    );
    const g = scan.groups[0];
    expect(g.example).toMatchObject({
      document_id: 'd1',
      supplier_name: 'Willamette Egg Farms',
      test_name_raw: 'Staph cp (cfu/g)',
      value_raw: '<10',
    });
    expect(g.suppliers.map((s) => s.name).sort()).toEqual([
      'Andersen Dairy Inc.',
      'Willamette Egg Farms',
    ]);
  });

  it('drops the spellings a person has dismissed, whatever their case', () => {
    const docs = [doc('d1', [['LOT CODE', 'A1'], ['Aroma', 'Clean']])];
    const all = scanUnmatchedAnalytes(docs, tests, [limit]);
    expect(all.groups).toHaveLength(2);
    const filtered = scanUnmatchedAnalytes(docs, tests, [limit], { ignoreKeys: ['lot code'] });
    expect(filtered.groups.map((g) => g.name)).toEqual(['Aroma']);
    expect(filtered.total_groups).toBe(1);
  });

  it('counts a crosstab row by row rather than once per document', () => {
    // Two analyte columns make a crosstab; each lot row is its own result.
    const crosstab: UnmatchedScanDocument = {
      id: 'd_cross',
      title: 'Multi-lot COA',
      supplier_id: 'sup_1',
      supplier_name: 'Andersen Dairy Inc.',
      extended_metadata: JSON.stringify({
        tables: [
          {
            name: 'micro',
            headers: ['Sample', 'Coliform', 'SPC', 'Titratable Acidity'],
            rows: [
              ['Lot 1', '<10', '200', '0.15'],
              ['Lot 2', '<10', '250', '0.16'],
              ['Lot 3', '<10', '210', '0.14'],
            ],
          },
        ],
      }),
    };
    const scan = scanUnmatchedAnalytes([crosstab], tests, [limit]);
    const acidity = scan.groups.find((g) => g.key === normalizeTestName('Titratable Acidity'));
    expect(acidity?.results).toBe(3);
    expect(acidity?.documents).toBe(1);
  });

  it('says nothing about a document with no extraction at all', () => {
    const scan = scanUnmatchedAnalytes(
      [{ id: 'd_empty', extended_metadata: null }],
      tests,
      [limit]
    );
    expect(scan.groups).toEqual([]);
    expect(scan.documents_scanned).toBe(1);
    expect(scan.documents_with_results).toBe(0);
  });
});
