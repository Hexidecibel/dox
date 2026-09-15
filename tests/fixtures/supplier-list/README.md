# Verified supplier list fixtures

Inputs for `POST /api/supplier-list/import` (migration 0111, rules in
`shared/requirementDerivation.ts`, columns in `shared/supplierListTemplate.ts`).

- `verified-supplier-list-template.csv` — the template the Supplier Requirements
  page downloads (header plus two example rows). Pinned against
  `supplierListTemplateCsv()` by `tests/unit/supplierListTemplate.test.ts`.
- `medosweet-verified-suppliers.csv` — a Medosweet-like list: Darigold butter
  (two SKUs, rBST-free), Country Morning cream, Andersen fluid dairy (kosher,
  halal), a sanitation chemical supplier, a packaging supplier, and one supplier
  marked not approved. Names are illustrative; SKUs follow the prod catalog's
  shape but nothing here is prod data.
