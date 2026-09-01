-- Andersen Dairy Inc. — COA extraction instructions
-- =================================================
-- REVIEW ONLY. NOT APPLIED. Run this by hand against prod after review, or
-- paste the text into the Sources UI for the (Andersen Dairy Inc., Certificate
-- of Analysis) combo.
--
-- Tenant   1f03c3e73add44bfafb33bb16508b78b  (Cush Co)
-- Supplier 5b1b9455070243d5b568c12c1c984f7d  (Andersen Dairy Inc.)
-- Doctype  96472de9ddab4f88bba0b8196b9fd057  (Certificate of Analysis)
-- Row      675cbf4f2c87198a89aff0e2f282c0dc  (supplier_extraction_instructions)
--
-- WHY THIS CHANGES
-- The existing row already says "read the PRODUCT row, never the Buffer row",
-- and the model still flattened the Sample x Analyte matrix into single merged
-- labels ("COLIFORM 1:1 AEROBIC", "COLIFORM AEROBIC", "COLIFORM 1-10 FRIDAY").
-- Prose about which row to read was not enough: the model was never told what
-- the OUTPUT should look like. This version shows both printed layouts and the
-- exact rows to emit for each, which is the thing it can copy.
--
-- The micro section is rewritten and three sections are added (TEST CONDITIONS,
-- INCUBATION, CERTIFICATION). A leading FIELD MAP was added after measurement:
-- the first draft tripled the length of the micro guidance and expiration_date
-- fill fell from 13/16 to 6/16 documents (stable across two runs, against a
-- 6.2% run-to-run noise floor) because the DATES rule got buried. Stating the
-- required fields before the long table section, and again as a closing
-- check, restores it. Do not shorten the FIELD MAP without re-measuring.
--
-- ROLLBACK — the current text, should you need to put it back:
--   see git history of this file, or take a copy before running:
--   SELECT instructions FROM supplier_extraction_instructions
--    WHERE id = '675cbf4f2c87198a89aff0e2f282c0dc';

UPDATE supplier_extraction_instructions
SET instructions = 'FIELD MAP — fill EVERY one of these on EVERY Andersen COA. None is optional.
  production_date  = the "Production Date" / "PROD DATE:" value.
  code_date        = the "Code Date (Expiration)" / "CODE DATE:" value.
  expiration_date  = THE SAME VALUE AS code_date. Andersen prints one date that is both. Never leave expiration_date null when code_date has a value.
  lot_number       = THE SAME VALUE AS code_date (there is no lot label on this COA).
  product_code     = the "Item #" value (e.g. 105A, 304M) on the new layout; the SIZE value (e.g. HG, 5G) on the old layout.
  product_name     = the PRODUCT value (CREAM, HOMO, WHIP) WITHOUT the size suffix.

FORMAT: Andersen changed COA layout in 2026. BOTH layouts still appear in the backlog — these rules cover each.

DATES — the most common error on the new layout. "Production Date" and "Code Date (Expiration)" are SEPARATE labelled fields with DIFFERENT values.
- production_date = the value labelled "Production Date" (e.g. 7-31-26).
- code_date AND expiration_date = the value labelled "Code Date (Expiration)" (e.g. 8-22-26).
NEVER copy the code date into production_date; they are weeks apart. NEVER take any date from the filename, even though the filename normally begins with the code date.

LOT: there is no lot label on either layout. The CODE DATE is the lot identity (flag lot_from_date_code). Do not synthesise a lot from anything else — not the Julian date, not a plate lot, not a colony count.

REAGENT / PLATE LOTS ARE NOT PRODUCT DATA. New layout: a "REAGENT / PLATE LOTS (3M PETRIFILM)" section listing Coliform Count Plate (CC), Aerobic Count Plate (AC) and Buffer, each with its own Lot # and Expiration. Old layout: the same values as CC LOT#/CC EXP, AC LOT#/AC EXP, BUFFER LOT#/BUFFER EXP. On EITHER layout these belong to the testing lab''s supplies. Never emit them as lot_number, product_code, plant_number, expiration_date or sub_lot_code. If they are captured at all, put them in a table named reagent_lots.

MICROBIOLOGICAL RESULTS — THIS COA HAS EXACTLY TWO MICRO ANALYTES, EVER: Coliform and Aerobic.
The micro block is a SAMPLE x ANALYTE matrix: samples run DOWN the side, the two analytes run ACROSS the top. Emit it as TWO rows of a table named "test_results", one per analyte, taking the PRODUCT sample''s value:

  test_results  headers ["test", "result", "unit", "specification", "pass_fail"]
    ["Coliform", "<1", "", "", ""]
    ["Aerobic",  "20", "", "", ""]

NEW LAYOUT prints:
    MICROBIOLOGICAL RESULTS
     Sample      Coliform   Aerobic
     Buffer         <1        <1
     Product        <1        20
  -> Coliform = <1, Aerobic = 20. The Buffer row is the negative control: SKIP IT.

OLD LAYOUT prints the same matrix without the word "Sample", naming the product row after the product and repeating the two analyte headings a second time for the dilutions:
    BACTERIA RESULTS | DILUTION
    PRODUCT | SIZE | COLIFORM | AEROBIC | COLIFORM | AEROBIC
    BUFFER  | N/A  |    0     |    0    |   1:1    |  1-10
    CREAM   | HG   |    0     |   <10
  -> Coliform = 0, Aerobic = <10, both read from the CREAM row (the product), NOT the BUFFER row.
  -> The SECOND "COLIFORM | AEROBIC" pair sits under DILUTION. Those are dilution ratios, not results. See TEST CONDITIONS.

NEVER produce a merged analyte label. Each of these has been emitted by a past run and every one is WRONG:
  "COLIFORM AEROBIC", "COLIFORM 1:1 AEROBIC", "COLIFORM 1-10 FRIDAY",
  "AEROBIC DILUTION COLIFORM 1:1 AEROBIC 1-10", "COLIFORM 0", "COLIFORM/AEROBIC COUNT".
The analyte name is "Coliform" or "Aerobic" and nothing else — never both, never with a dilution ratio, a weekday, a sample name or a count welded on.

TEST CONDITIONS ARE NOT RESULTS. "Dilution – Coliform 1-1", "Dilution – Aerobic 1-10" (new layout) and the second COLIFORM/AEROBIC column pair under DILUTION (old layout) are how the plate was prepared. So is "Incubator Temp. 35C". A value like "1:1", "1-1" or "1-10" is NEVER a result and NEVER part of an analyte name. Put them, if anywhere, in a table named test_conditions.

INCUBATION IS NOT RESULTS. The Date In / Time In / Date Out / Time Out block (new layout: a section called INCUBATION; old layout: DATE IN / TIME IN / DATE OUT / TIME OUT scattered beside the plate block) records when plates went in and came out. A clock time such as "3:16 PM" is never a test result and "TIME IN" is never an analyte. Put them, if anywhere, in a table named incubation.

CERTIFICATION IS NOT RESULTS. The closing paragraph reads: "produced from raw milk meeting the somatic cell (400,000 per ml.) and bacteria standard plate count (100,000 per ml.) requirements of regulation (EC) No. 853/2004". 400,000 and 100,000 are the REGULATION''S limits, quoted identically on every Andersen COA. They are not this lot''s measurements. Never emit "Somatic Cell Count = 400,000 per ml." or "Bacteria Standard Plate Count = 100,000 per ml." as a result row — this COA does not report a somatic cell count at all.

PRODUCT QUALITY is a separate table from the micro results: Fat (%), Flavor, Odor, read from the single product row. Sensory is Flavor + Odor only. There is no Color field on this COA.

BEFORE YOU RETURN: re-read the FIELD MAP at the top. If expiration_date, lot_number or product_code is null while the COA printed a code date, you have missed a required field — go back and fill it.

The phone number 360-687-7171 in the letterhead is never a product_code and never a test result.',
    updated_at = datetime('now')
WHERE id = '675cbf4f2c87198a89aff0e2f282c0dc'
  AND tenant_id = '1f03c3e73add44bfafb33bb16508b78b';

-- Verify (expect 1 row, and the text starting at "FIELD MAP — fill EVERY"):
-- SELECT length(instructions), substr(instructions, 1, 60)
--   FROM supplier_extraction_instructions
--  WHERE id = '675cbf4f2c87198a89aff0e2f282c0dc';
