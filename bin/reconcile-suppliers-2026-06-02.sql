-- One-off supplier de-duplication reconcile (2026-06-02).
-- Mirrors functions/lib/suppliers.ts#mergeSuppliers: reassign every supplier_id
-- FK from loser -> winner, fold loser names into winner aliases, delete losers.
-- Unique-constrained tables use UPDATE OR IGNORE then DELETE leftovers.
-- Tenant: Country Morning Farms (1f03c3e73add44bfafb33bb16508b78b)
--
-- Winners / losers:
--   Medosweet Farms  2dea49b0320749bebbe795d4e08685bb
--     <- Medosweet   bf4d76879baa438eb6e231cd2f351653
--     <- C2# (junk)  88c842018007427fac7d9c350373bc10   (docs reassigned, name NOT aliased)
--   National Food NW Egg Products Division 23aa62c0ec044a498cbb2961e5a9e646
--     <- National Food NW          1fb3ba8427af41d9a4aef508b0e2ba6e
--     <- National Food NW Eqg ...  c7ed04e5e62e43aa86ce58320e7cd777
--   Andersen Dairy Inc. 5b1b9455070243d5b568c12c1c984f7d
--     <- Anderson Dairy be850040c47e47bea63fdf0b850cf306
--   Savencia Fromage & Dairy 3191e20226ee44a7a3f3b2731054b54d
--     <- SAVENCIA     1f3a69ba027b43a090de50ff26e4f496

-- ============ Cluster 1: Medosweet ============
-- losers -> Medosweet Farms (2dea...)
-- plain FK tables
UPDATE documents       SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE products        SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE lots            SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE processing_queue SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE connectors      SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
-- unique-constrained FK tables
UPDATE OR IGNORE product_suppliers               SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM product_suppliers                    WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE OR IGNORE extraction_templates            SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM extraction_templates                 WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE OR IGNORE supplier_extraction_instructions SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM supplier_extraction_instructions     WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE OR IGNORE reviewer_field_picks            SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM reviewer_field_picks                 WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE OR IGNORE reviewer_field_dismissals       SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM reviewer_field_dismissals            WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
UPDATE OR IGNORE reviewer_table_edits            SET supplier_id='2dea49b0320749bebbe795d4e08685bb' WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
DELETE FROM reviewer_table_edits                 WHERE supplier_id IN ('bf4d76879baa438eb6e231cd2f351653','88c842018007427fac7d9c350373bc10');
-- aliases (fold Medosweet + its existing alias; C2# deliberately NOT aliased)
UPDATE suppliers SET aliases='["Medosweet","Medosweet Farms, Inc."]', updated_at=datetime('now') WHERE id='2dea49b0320749bebbe795d4e08685bb';

-- ============ Cluster 2: National Food NW ============
UPDATE documents       SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE products        SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE lots            SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE processing_queue SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE connectors      SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE product_suppliers               SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM product_suppliers                    WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE extraction_templates            SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM extraction_templates                 WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE supplier_extraction_instructions SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM supplier_extraction_instructions     WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE reviewer_field_picks            SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM reviewer_field_picks                 WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE reviewer_field_dismissals       SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM reviewer_field_dismissals            WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE OR IGNORE reviewer_table_edits            SET supplier_id='23aa62c0ec044a498cbb2961e5a9e646' WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
DELETE FROM reviewer_table_edits                 WHERE supplier_id IN ('1fb3ba8427af41d9a4aef508b0e2ba6e','c7ed04e5e62e43aa86ce58320e7cd777');
UPDATE suppliers SET aliases='["National Food NW","National Food NW Eqg Products Division"]', updated_at=datetime('now') WHERE id='23aa62c0ec044a498cbb2961e5a9e646';

-- ============ Cluster 3: Anderson/Andersen ============
UPDATE documents       SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE products        SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE lots            SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE processing_queue SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE connectors      SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE product_suppliers               SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM product_suppliers                    WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE extraction_templates            SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM extraction_templates                 WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE supplier_extraction_instructions SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM supplier_extraction_instructions     WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE reviewer_field_picks            SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM reviewer_field_picks                 WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE reviewer_field_dismissals       SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM reviewer_field_dismissals            WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE OR IGNORE reviewer_table_edits            SET supplier_id='5b1b9455070243d5b568c12c1c984f7d' WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
DELETE FROM reviewer_table_edits                 WHERE supplier_id='be850040c47e47bea63fdf0b850cf306';
UPDATE suppliers SET aliases='["Anderson Dairy"]', updated_at=datetime('now') WHERE id='5b1b9455070243d5b568c12c1c984f7d';

-- ============ Cluster 4: Savencia ============
UPDATE documents       SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE products        SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE lots            SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE processing_queue SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE connectors      SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE product_suppliers               SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM product_suppliers                    WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE extraction_templates            SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM extraction_templates                 WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE supplier_extraction_instructions SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM supplier_extraction_instructions     WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE reviewer_field_picks            SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM reviewer_field_picks                 WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE reviewer_field_dismissals       SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM reviewer_field_dismissals            WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
UPDATE OR IGNORE reviewer_table_edits            SET supplier_id='3191e20226ee44a7a3f3b2731054b54d' WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
DELETE FROM reviewer_table_edits                 WHERE supplier_id='1f3a69ba027b43a090de50ff26e4f496';
-- trim survivor trailing space + alias SAVENCIA
UPDATE suppliers SET name='Savencia Fromage & Dairy', slug='savencia-fromage-dairy', aliases='["SAVENCIA"]', updated_at=datetime('now') WHERE id='3191e20226ee44a7a3f3b2731054b54d';

-- ============ Name trim (no merge): West Point ============
UPDATE suppliers SET name='West Point', slug='west-point', updated_at=datetime('now') WHERE id='a54961049eaa481c85aae66091625656';

-- ============ Delete losers ============
DELETE FROM suppliers WHERE id IN (
  'bf4d76879baa438eb6e231cd2f351653',  -- Medosweet
  '88c842018007427fac7d9c350373bc10',  -- C2#
  '1fb3ba8427af41d9a4aef508b0e2ba6e',  -- National Food NW
  'c7ed04e5e62e43aa86ce58320e7cd777',  -- National Food NW Eqg ...
  'be850040c47e47bea63fdf0b850cf306',  -- Anderson Dairy
  '1f3a69ba027b43a090de50ff26e4f496'   -- SAVENCIA
);
