-- Migration 0136: every tenant keeps the extraction context it has been
-- extracting with, written down as its own.
--
-- WHY
-- ---
-- tenants.extraction_context (0072) is the editable "industry layer" of the
-- extraction prompt. A tenant that had never written one fell back to a
-- constant in the code, and that constant was the FIRST tenant's dairy
-- playbook: dairy tests, dairy grades, raw-milk certification clauses and a
-- worked butter certificate. So the product default for every organisation,
-- whatever it buys or sells, was one client's configuration. The client's
-- definition of done for Phase 1 says a text search of the product finds no
-- first-tenant value, and a default is the most live place one can be.
--
-- The release this migration ships with changes that fallback to a generic
-- block (GENERIC_INDUSTRY_CONTEXT in functions/lib/llm.ts, mirrored in
-- bin/process-worker). Changing a fallback changes every extraction of every
-- tenant relying on it, silently, on deploy.
--
-- WHAT THIS DOES
-- --------------
-- Writes the dairy text into tenants.extraction_context for every tenant
-- whose value is NULL or the empty string -- exactly the two values the code
-- reads as "none" (`tenantContext || DEFAULT` in both the Pages path and the
-- worker). After this, those tenants send the model the same characters they
-- sent the day before, from their own record instead of from a constant, and
-- the constant is free to stop being dairy.
--
-- A whitespace-only value is NOT touched: the code already sends that as the
-- tenant's (empty) layer rather than falling back, so it relies on no default
-- and rewriting it would be the behaviour change.
--
-- WHICH COPY. The built-in default existed twice, once per prompt surface,
-- and the copies differed on ONE line of the worked example: the extraction
-- worker's said `"_confidence": 0.95` (the worker asks the model for a number)
-- and the Pages copy's said `"_confidence": "high"` (that surface asks for
-- high / medium / low). One column cannot hold both. The worker runs the
-- Review Queue, which is nearly every extraction, so THIS FILE STORES THE
-- WORKER'S TEXT and the worker goes on sending the same characters. The Pages
-- surface (email ingest) recognises this exact stored text and puts its own
-- line back (industryLayerForThisSurface in functions/lib/llm.ts), so its
-- prompt does not move either.
--
-- THE TEXT IS PINNED, NOT TRUSTED. tests/unit/extractionContextDefault.test.ts
-- runs this file against a tenant with no context and compares what lands,
-- byte for byte, with DAIRY_CONTEXT_AS_MIGRATED exported from
-- functions/lib/llm.ts, pins the SHA-256 of what each surface's default was
-- before the change, and pins the SHA-256 of the whole assembled prompt, so
-- none of it can drift from what was live.
--
-- ONE DELIBERATE DIFFERENCE FROM WHAT WAS LIVE. The worked example in the old
-- default named a real supplier. The text below names an invented one
-- ("Northfield Inc.") in the same three places and is otherwise the worker's
-- former default character for character -- the test proves exactly that, by
-- putting the old name back and comparing the SHA-256. A product migration
-- does not write a real company's name into every organisation's settings.
-- A database that applied this file BEFORE that change holds the earlier text;
-- the code recognises both by fingerprint (isMigratedDefaultContext).
--
-- NOTHING IS STAMPED. extraction_context_updated_at / _updated_by (0072) stay
-- NULL. Those columns say a PERSON edited the context, and the settings box
-- prints them as "Last edited by". Nobody edited anything here; a stamp would
-- assert a decision that was never made (the 0102 / 0116 rule).
--
-- WHY THE TEXT LOOKS LIKE THIS
-- ----------------------------
-- One string literal per line, each ending in char(10), and every character
-- outside ASCII written as char(<code point>) -- char(8212) is the long dash
-- the text uses. The whole file is therefore plain ASCII: D1's import API has
-- mis-handled non-ASCII bytes before (the 0110 finding), and a multi-line
-- literal is at the mercy of every tool that splits a file on line starts or
-- semicolons. This form survives all of them and SQLite rebuilds the exact
-- string.
--
-- The lines are parenthesised one by one and in groups of eight because D1
-- refuses an expression tree deeper than 100, and fifty-two lines joined in
-- one flat chain is deeper than that ("Expression tree is too large"). Grouped,
-- the deepest path is about twenty.
--
-- APPLY BEFORE THE CODE DEPLOYS. In that order extraction is identical on
-- both sides of the release. The other way round, a tenant with no stored
-- context extracts under the generic block until this runs.
--
-- Idempotent (a second run matches no row), additive, no schema change.
-- Roll back is not needed for correctness; to undo, set the column back to
-- NULL on the rows that hold this exact text and have no updated_at stamp.

UPDATE tenants
SET extraction_context =
    (
      ('' || char(10)) ||
      ('ORG CONTEXT:' || char(10)) ||
      ('[Describe your organization and what these documents are for ' || char(8212) || ' edit this. e.g. "We are a dairy distributor managing supplier Certificates of Analysis for regulatory compliance. Lot traceability is critical; every document must be tied to a lot."]' || char(10)) ||
      ('' || char(10)) ||
      ('INDUSTRY CONTEXT ' || char(8212) || ' Dairy & Food:' || char(10)) ||
      ('- Common COA tests: Standard Plate Count (SPC), coliform, E. coli, yeast & mold, somatic cell count, butterfat %, moisture %, pH, acidity, temperature' || char(10)) ||
      ('- Grade designations: Grade A, Grade AA, US Extra, USDA grades' || char(10)) ||
      ('- Plant/facility numbers: USDA plant numbers (e.g., "Plant 42-1234")' || char(10))
    )
    ||
    (
      ('- Code dates may be printed in Julian format (YDDD where Y=last digit of year, DDD=day) ' || char(8212) || ' copy them exactly as printed; never convert one to a calendar date' || char(10)) ||
      ('- Net weights: common units are lbs, gallons, kg' || char(10)) ||
      ('' || char(10)) ||
      ('DAIRY COA DOMAIN RULES (hard rules ' || char(8212) || ' follow exactly):' || char(10)) ||
      ('- Lab consumables are NEVER product data. Reagent / control / buffer lot numbers (e.g. 3M Petrifilm CC/AC/BUFFER lots and their expirations), dilution rows, plate-incubation tables, and incubator temperatures must never be bound to a product field. A reagent lot mistaken for the product''s lot is the single worst error.' || char(10)) ||
      ('- Certification / legal boilerplate numbers are reference, not results. Numbers inside raw-milk certification clauses or regulatory citations (e.g. "standard plate count 100,000 per ml", "somatic cell 400,000 per ml") are reference thresholds, NOT this product''s measured values. Do not extract them as results.' || char(10)) ||
      ('- Capture specifications verbatim; NEVER derive pass/fail. Copy the spec string exactly as printed. Leave pass/fail empty unless the document itself prints an explicit verdict ' || char(8212) || ' the human decides conformance.' || char(10)) ||
      ('- Result is not the spec. When a table has Spec and Result columns, the measured value is the Result; never report the spec/limit as the result.' || char(10))
    )
    ||
    (
      ('- Lot is the most important field and keys every record. If there is no explicit lot label but a CODE DATE / DATE CODE is present, it may serve as the lot ' || char(8212) || ' capture it as the lot, and also keep it in its own date field.' || char(10)) ||
      ('- A missing required pathogen result (Listeria, Salmonella) is a GAP, not a pass ' || char(8212) || ' return null; do not infer absence.' || char(10)) ||
      ('- Capture yeast/mold and sensory (flavor / color / odor) exactly as printed ' || char(8212) || ' never auto-combine, split, or collapse them.' || char(10)) ||
      ('- Normalize dates to YYYY-MM-DD; when numeric order is genuinely ambiguous (e.g. 03/04/26 could be Mar or Apr), keep as-is rather than guess.' || char(10)) ||
      ('' || char(10)) ||
      ('EXAMPLE ' || char(8212) || ' Dairy COA extraction:' || char(10)) ||
      ('Input: "Northfield Inc. COA for Grade AA Butter 68#, Lot L26-0842, PO PO-44821, Packed 03/15/26, Best By 09/15/26, Plant 42-1234. Tests: Fat >80% result 81.2% Pass, Moisture <16% result 15.4% Pass, Coliform <10 CFU/g result <1 Pass, SPC <20000 CFU/g result 4500 Pass"' || char(10)) ||
      ('' || char(10))
    )
    ||
    (
      ('Output:' || char(10)) ||
      ('{' || char(10)) ||
      ('  "fields": {' || char(10)) ||
      ('    "supplier_name": "Northfield Inc.",' || char(10)) ||
      ('    "product_name": "Grade AA Butter 68#",' || char(10)) ||
      ('    "lot_number": "L26-0842",' || char(10)) ||
      ('    "po_number": "PO-44821",' || char(10)) ||
      ('    "code_date": "2026-03-15",' || char(10))
    )
    ||
    (
      ('    "expiration_date": "2026-09-15",' || char(10)) ||
      ('    "grade": "Grade AA",' || char(10)) ||
      ('    "plant_number": "42-1234",' || char(10)) ||
      ('    "net_weight": "68 lbs"' || char(10)) ||
      ('  },' || char(10)) ||
      ('  "tables": [{' || char(10)) ||
      ('    "name": "test_results",' || char(10)) ||
      ('    "headers": ["test", "test_method", "specification", "result", "units", "pass_fail"],' || char(10))
    )
    ||
    (
      ('    "rows": [' || char(10)) ||
      ('      ["Fat Content", "SMEDP 15.122", ">80%", "81.2", "%", "Pass"],' || char(10)) ||
      ('      ["Moisture", "SMEDP 15.122", "<16%", "15.4", "%", "Pass"],' || char(10)) ||
      ('      ["Coliform", "AOAC 989.10", "<10", "<1", "CFU/g", "Pass"],' || char(10)) ||
      ('      ["Standard Plate Count", "AOAC 989.10", "<20,000", "4,500", "CFU/g", "Pass"]' || char(10)) ||
      ('    ]' || char(10)) ||
      ('  }],' || char(10)) ||
      ('  "products": ["Grade AA Butter 68#"],' || char(10))
    )
    ||
    (
      ('  "summary": "COA for Northfield Grade AA Butter lot L26-0842, all tests pass.",' || char(10)) ||
      ('  "_confidence": 0.95,' || char(10)) ||
      ('  "document_type": "Certificate of Analysis"' || char(10)) ||
      ('}')
    )
WHERE extraction_context IS NULL OR extraction_context = '';
