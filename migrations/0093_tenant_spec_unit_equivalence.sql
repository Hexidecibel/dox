-- Per-tenant unit equivalence for spec checking: judge CFU/mL against a CFU/g
-- limit (and MPN/mL against MPN/g) as the same number.
--
-- WHY. The spec engine refuses to compare a result in CFU/mL against a limit in
-- CFU/g — different bases, `not_checked`, never a silent pass. That refusal is
-- correct in general: for a powder, per-gram and per-millilitre are genuinely
-- different quantities. It is wrong for a FLUID DAIRY tenant, where on
-- production 370 results print `cfu/mL` against 265 printing `cfu/g` while
-- every configured limit is in CFU/g — so the majority unit matched nothing,
-- and `could not be judged` went from 159 to 461 once missing analyte spellings
-- were added. The QA lead states his own limits as "≤ 10 CFU/g (CFU/mL for
-- fluid)": for milk and cream the density difference is about 3%, immaterial
-- against a 20,000 CFU ceiling.
--
-- DEFAULT 0 — OFF, and that is load-bearing. A new tenant, or one handling
-- powders, keeps today's behaviour. Turning it on is a QA decision a person
-- makes on the Spec Limits screen, and every verdict it makes reachable names
-- it in the reason text (see shared/specCheck.ts, UnitPolicy).
--
-- SCOPE IS DELIBERATELY NARROW. This is not "ignore units": percent against
-- CFU/g stays not_checked (it has already caught a real extraction bug), and
-- CFU against MPN stays refused. Only volume-vs-mass within one enumeration
-- method is affected.
--
-- Written / read via /api/spec-unit-policy (super_admin + org_admin), which
-- also stamps who changed it and when — a setting that changes verdicts should
-- be answerable later.

ALTER TABLE tenants ADD COLUMN spec_volume_mass_equivalent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN spec_unit_policy_updated_at TEXT;
ALTER TABLE tenants ADD COLUMN spec_unit_policy_updated_by TEXT;
