/**
 * parseExtraction — records-only responses must not poison ai_fields.
 *
 * Found while validating the D1 fix on real prod docs (2026-07-30). When the
 * model answers with `{ records: [...], page_metadata: {...} }` and no flat
 * `fields` block, parseExtraction's fallback treated the WHOLE top-level object
 * as the field map. `records` and `page_metadata` are objects, so they were
 * stringified into ai_fields as the literal "[object Object]" — and every real
 * field was lost, because the model had put them in page_metadata.
 *
 * That mattered more after D1 than before: the worker only posts `ai_records`
 * when a doc assembles to >= 2 records, so a ONE-page one-lot COA that answers
 * in records shape posts flat fields only. Garbage flat fields there means the
 * reviewer sees an empty editor for a document we extracted correctly.
 *
 * The fix: reserve the four records-shape keys in every branch, reconstruct the
 * flat view from page_metadata ∪ the sole record's fields (mirroring how
 * produceCoaRecords merges them), and never stringify a nested object into a
 * scalar field.
 *
 * process-worker is a plain-CJS daemon with no exports, so — as in the sibling
 * processWorker*.test.ts files — we load its source as a raw string; here we
 * additionally evaluate the two pure functions under test (parseExtraction and
 * its helper flattenFields), which depend on nothing else in the file.
 */

import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';

function sliceFn(name: string): string {
  const start = processWorkerSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in bin/process-worker`);
  // Walk braces from the first '{' after the signature to the matching close.
  const open = processWorkerSource.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < processWorkerSource.length; i++) {
    const c = processWorkerSource[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return processWorkerSource.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

type Parsed = {
  fields: Record<string, string | null>;
  tables: unknown[];
  records: unknown[] | null;
  pageMetadata: Record<string, string> | null;
};

const parseExtraction: (content: string) => Parsed = new Function(
  `${sliceFn('flattenFields')}\n${sliceFn('parseExtraction')}\nreturn parseExtraction;`
)() as (content: string) => Parsed;

describe('parseExtraction — documented { fields } shape is unchanged', () => {
  it('reads the flat fields block verbatim', () => {
    const out = parseExtraction(
      JSON.stringify({
        fields: { supplier_name: 'Darigold, Inc.', lot_number: '22026110', sub_lot_code: '02' },
        tables: [],
        _confidence: 0.9,
      })
    );
    expect(out.fields).toEqual({
      supplier_name: 'Darigold, Inc.',
      lot_number: '22026110',
      sub_lot_code: '02',
    });
  });
});

describe('parseExtraction — records-only shape', () => {
  const recordsOnly = JSON.stringify({
    record_cardinality: 'single',
    record_key_basis: 'lot',
    page_metadata: {
      supplier_name: 'Darigold, Inc.',
      product_name: 'DG HH Qt UP',
      lot_number: '22026110',
    },
    records: [{ fields: { sub_lot_code: '02' }, tables: [] }],
    _confidence: 0.8,
  });

  it('never emits "[object Object]" into the flat fields', () => {
    const out = parseExtraction(recordsOnly);
    for (const v of Object.values(out.fields)) {
      expect(String(v)).not.toContain('[object Object]');
    }
  });

  it('does not leak the records-shape keys into the flat fields', () => {
    const out = parseExtraction(recordsOnly);
    for (const k of ['records', 'record_cardinality', 'record_key_basis', 'page_metadata']) {
      expect(out.fields).not.toHaveProperty(k);
    }
  });

  it('reconstructs the flat view as page_metadata ∪ the sole record fields', () => {
    // Same merge the records producer performs (record wins), so the flat
    // editor shows what the records payload contains.
    const out = parseExtraction(recordsOnly);
    expect(out.fields).toEqual({
      supplier_name: 'Darigold, Inc.',
      product_name: 'DG HH Qt UP',
      lot_number: '22026110',
      sub_lot_code: '02',
    });
  });

  it('lets the record override a page_metadata value of the same key', () => {
    const out = parseExtraction(
      JSON.stringify({
        page_metadata: { lot_number: 'PAGE', product_name: 'Butter' },
        records: [{ fields: { lot_number: 'REC', sub_lot_code: '07' } }],
      })
    );
    expect(out.fields.lot_number).toBe('REC');
    expect(out.fields.sub_lot_code).toBe('07');
  });

  it('contributes page_metadata ONLY when the page carries several records', () => {
    // A flat view of several different lots would be a lie — the records
    // payload is the truth for a multi-sublot page.
    const out = parseExtraction(
      JSON.stringify({
        page_metadata: { product_name: 'DG Btr Elg 30-1lb', lot_code: '10326080' },
        records: [
          { fields: { sub_lot_code: '24' } },
          { fields: { sub_lot_code: '21' } },
        ],
      })
    );
    expect(out.fields).toEqual({ product_name: 'DG Btr Elg 30-1lb', lot_code: '10326080' });
    expect(out.fields).not.toHaveProperty('sub_lot_code');
  });

  it('still passes records / page_metadata through untouched for mergeCoaRecords', () => {
    const out = parseExtraction(recordsOnly);
    expect(out.records).toHaveLength(1);
    expect(out.pageMetadata).toMatchObject({ lot_number: '22026110' });
  });
});

describe('parseExtraction — legacy top-level-fields shape still works', () => {
  it('treats a bare top-level object as the field map', () => {
    const out = parseExtraction(
      JSON.stringify({ supplier_name: 'Andersen Dairy Inc.', lot_number: '122' })
    );
    expect(out.fields).toEqual({ supplier_name: 'Andersen Dairy Inc.', lot_number: '122' });
  });

  it('drops nested objects rather than stringifying them into a scalar field', () => {
    const out = parseExtraction(
      JSON.stringify({ supplier_name: 'X', junk: { a: 1 }, list: [1, 2] })
    );
    expect(out.fields).toEqual({ supplier_name: 'X' });
  });
});
