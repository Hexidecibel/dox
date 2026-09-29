# Search golden corpus

A synthetic tenant with the real tenant's SHAPES and invented values — four
suppliers (a declared plant · YY · Julian + sublot format, a declared best-by
MMDDYY + suffix format, two with none), seven products with identifiers
(including one supplier name on two products), 25 approved documents, three WMS
orders, two Review Queue files and a second tenant holding the same lot and PO.
`corpus.ts` seeds it through the app's own writers (`findOrCreateLot`,
`declareLotScheme`, `insertProductIdentifier`, `rebuildDocumentKeys`, the FTS
triggers), so keys and provenance come out the way approval produces them.

`tests/api/search-golden.test.ts` asks it questions through the real
`POST /api/search/interpret` and `POST /api/search/query` handlers, in-worker.
It runs in `npx vitest run`, so every deploy is gated on it.

## "I searched X and got nothing" — add a row

1. Find (or add, in `corpus.ts`) a document shaped like the one the person
   expected: same lot shape, same way the PO or date is printed.
2. Add ONE line to the matching block in `tests/api/search-golden.test.ts`:

   ```ts
   { q: 'what they typed', why: 'who reported it and why it should work', expect: { coverage: 'covered', covering: [DOC.theDocument] } },
   ```

   Use `likely` instead of `covering` when the only evidence is a legacy
   code date, a lot-code decode or a pending WMS suggestion, and put the
   "must never find" cases in `NEGATIVES` with `coverage: 'none', covering: []`.
3. `npx vitest run tests/api/search-golden.test.ts` — a failing row prints what
   came back in each band and the answer's own summary line.

Rows that depend on a reader capability still being built (month and range
phrases, product words as chips) live in their own blocks that switch on when
the capability is detected at the start of the run; until then they show as
skipped, never silently absent.

`bin/eval-search` (no `--url`) runs the probe generator over this same corpus.
