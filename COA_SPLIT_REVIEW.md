# COA multi-record split — how it works (please sanity-check)

We're making multi-page / multi-lot / multi-product COAs split into one **record per
lot/sublot (or per product)** instead of flattening to a single row. Below is exactly
what the pipeline does. **Please confirm the semantics are right (yes/no per section),
especially §4 where I think there's a real gap.**

## 1. The record model (how we SPLIT)

Every COA becomes a `CoaRecordsPayload`:
- `record_cardinality`: `single` | `multi_lot` | `multi_product`
- `record_key_basis`: `lot` | `lot+sublot` | `product`
- `page_metadata`: fields that are **constant across all records** (manufacturer,
  product, main lot, code date, plant…) — hoisted out so they're not repeated.
- `records[]`: one entry per lot/sublot/product, each with its own `fields`
  (lot_code, sub_lot_code, butterfat, etc.), its own test `tables`, `source_pages`,
  and a per-record confidence.

**Decision (from us):** the unit is **per lot/sublot** — each lot (and sublot) is its
own record → its own document + lots row, even when several share one product. Product
is keyed only when there's no per-lot split. *Is per-lot/sublot the right grain?*

## 2. How we PARSE (extraction → records)

1. Extract text from **all pages**; chunk it with `=== PAGE N ===` banners (≤6 chunks,
   ~24K chars each). Multi-page docs are NOT truncated.
2. The LLM, per chunk, returns records for the products/lots **on that chunk's pages**
   (+ cardinality + page_metadata), using the existing dairy rules (specs verbatim,
   lab-consumables ignored, lot-as-date-code, etc.).
3. A deterministic step (`mergeCoaRecords`) assembles across chunks:
   - key each record by `lot_code`(+`sub_lot_code`), or by product when no lot;
   - **merge** same-key records that span a chunk boundary (combine fields, concat
     tables, union source_pages);
   - **hoist** any field identical across ALL records into `page_metadata`;
   - derive cardinality; per-record confidence = min of its cells.

## 2b. Page = independent entity (EDI/PO bundling)  *(per us, 2026-06-06 — confirm?)*

A multi-page PDF is bundled by **PO / EDI order number** — an EDI/AR transmission
artifact, **not** a product relationship. **Each page is one independent product type /
its own COA.** So pages should ALWAYS split apart; the merge should **never** combine
products across pages. The shared **PO / EDI order number is the order-linkage key**
(used to match each product-page back to its order line), not a product grouping. *Confirm:
page = its own entity, split unconditionally, PO/EDI# is just the order key?*

## 2c. VERIFIED: each page is a self-sufficient COA (2026-06-06)

Checked the raw text of `EDI178057` (the "7-page" doc): **every page is literally
`Page 1 of 1`** — it's **7 independent single-page COAs** stitched together by the
EDI/PO. Each page has a complete header on its own: supplier (Darigold), item#, lot#,
plant, date. Seven distinct lots (10326103 / 10426069 / … / 10426110). So a page never
depends on another page — split unconditionally, no continuation, no merge. (v1 captured
only page 7's 810004 and dropped pages 1–6 = lost 6 of 7.)

## 3. How we RELINK (records → documents / lots / orders)  *(designed, not built yet)*

Each product-page record carries the shared **PO / EDI order number** (the bundle key)
plus its own product + lot/sublot, so on approval it becomes one document + one lots row,
matched to **that order's** line **per lot**.

On approval, each record becomes:
- one **document** (page-scoped to that record's `source_pages`);
- one **lots** row, keyed by `lot_code` (+`sub_lot_code`);
- linked to its **product** (by product_code/name);
- so order⇄COA matching happens **per lot** — each lot finds its own order line.

*Is "one document + one lots row per lot/sublot, matched to orders per lot" the right
target?*

## 4. ⚠️ OPEN ISSUE — multi-item-per-page (please confirm intended behavior)

**Real example — `Darigold EDI178057PO K134801.pdf` (7 pages):**
We produced: `multi_lot`, product **810004** (Sweet Cream Butter), main lot **10426110**,
**3 sublot records (05 / 04 / 02)** — 0.95 confidence. The sublot split looks right.

**But:** the document text also contains item **810002** (a different butterfat profile,
~4.9% vs 80%) — and our split did **not** capture it. Every record was tagged
`source_pages = [1–7]`, which suggests we treated the whole doc as one item's sublots
and **dropped 810002**.

Per your playbook, a Darigold can be **one item per page** (e.g. page 6 = butter 810004,
other pages = different items). So:
- **Q1:** Should `EDI178057` have produced records for **both** 810002 and 810004
  (each with its own lots/sublots)? (I believe yes → current output is losing 810002.)
- **Q2:** When one product has sublots AND the doc has other products, is the right
  shape a **two-level** split (product → its lots/sublots)? i.e. records grouped by
  item, sublots within each?
- **Q3:** Should `source_pages` be the **specific page(s)** each item/lot sits on (so
  each split document is just that item's page), not the whole range?

## 5. Other example for reference — `339028.pdf`
`multi_product`, **6 product records** (STK52703, STK08240, …) keyed by product — but
**no lot captured** on any (`lot = ?`). *Q4: should each of these products carry its own
lot, and are the lots actually on that COA?*

## 6. Validation run (shadow mode, real prod docs)

8 Darigolds reprocessed: all extracted clean (no errors), but only **2 emitted
multi-record splits** — the other **6 came out single-record** (cardinality `single`),
which for multi-lot Darigolds may mean they were genuinely single-lot **or** we
under-split them. The 4 splits we got:

| Doc | cardinality | records | products captured |
|---|---|---|---|
| `Darigold EDI178057` | multi_lot | 3 | **810004 only** (text also has 810002 → dropped) |
| `Darigold EDI175825` | multi_lot | 3 | **810004 only** (same pattern) |
| `339028.pdf` | multi_product | 6 | 6 products (STK…), **no lot on any** |
| `OP056_050526` | multi_product | 28 | 28 products (order-guide-like; *is this even a COA?*) |

Patterns to confirm: (a) **both** Darigolds collapsed to one item's sublots — consistent
bug, not a one-off; (b) 6 Darigolds didn't split at all — under-splitting or legit
single-lot?; (c) multi_product docs lose lots / may be mis-typed as COA.

---

**TL;DR for the yes/no:** §1–§3 (per-lot/sublot model, parse→merge→hoist, relink one
doc+lot per lot) — right or wrong? §4 — I'm fairly sure we're **collapsing multi-item
docs and losing items** (810002); confirm that's a real bug so I fix the merge to split
by item first, then lots/sublots within each item.
