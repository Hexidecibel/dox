# Self-doc audit — 2026-04-30

Pre-Phase D inventory of self-documentation across every major page in
the dox app. Drives D1–D5 implementation slicing.

## Method

For each page, sampled the file header (~30–80 lines) and grep'd for
`Tooltip`, `Alert severity`, `Empty`, and "No X found" patterns. Looked
for four self-doc layers:

1. **Header info well** — does the top of the page explain what the page
   is for and the typical flow?
2. **Field tooltips** — are non-obvious form fields / column headers
   explained in-context?
3. **Empty states** — does an empty list say what the user should *do*,
   or just `No X found`?
4. **Error clarity** — are error messages actionable?

Maturity tiers: **good** = 3+ layers present; **partial** = 1–2 layers;
**none** = none of the four.

## Summary

**18 modules audited. Maturity: 0 good / 4 partial / 14 none.**

Almost the entire app is at the "none" tier. The list pages are
near-identical templated screens (`<Typography variant="h4">` header
with no description, then a search box, then a table with `No X
found`). The intake-doors section of `ConnectorDetail.tsx` is the only
spot in the app with intentional info wells + tooltips, and it
materialized during Phase A/B of the connector button-up — it's both
the model for what good looks like and a sign of how far behind the
rest is.

`records/*` (Sheets, FormBuilder, etc.) have inline `EmptyState`
helpers but each is a one-off — no shared component.

## Per-module

### Connectors (list) — `src/pages/admin/Connectors.tsx`

- Header: `<Typography variant="h4">Connectors</Typography>` + Add
  button. **No info well, no description.**
- Tooltips: none on the table columns; `system_type` column shows a
  raw `erp` / `wms` / `other` chip with no explanation.
- Empty state: bare `<Typography>No connectors found</Typography>` in
  both desktop and mobile branches. No "create your first" CTA in the
  empty card.
- Errors: generic `Alert severity="error"` from API.
- Maturity: **none**. Priority: HIGH.

### Connectors (detail) — `src/pages/admin/ConnectorDetail.tsx`

- Header: connector name + chips, no flow explainer. The intake-doors
  cards (HTTP POST, S3, Public Link, Email) each have inline `Alert
  severity="info"` describing what the door does — those landed in
  Phase A/B and **are the model for what every page should look
  like**.
- Tooltips: rich on the door cards (Copy, Rotate, Show/Hide secret),
  but **none on the runs table columns** — `Status`, `Path`,
  `Records`, `Rows OK / Errors`, etc. are unexplained.
- Empty state: runs table just empties out; no "no runs yet, drop a
  file to see one" framing.
- Errors: failed run rows do show `error_message` in a tooltip — good.
- Maturity: **partial** (door cards good, runs table + page header
  blank). Priority: HIGH (already mid-flight from connector button-up).

### Connectors wizard — `src/pages/admin/ConnectorWizard.tsx` + `src/components/connectors/Step*.tsx`

- Header: a `<Stepper>` and step titles, but no top-level "what is this
  wizard for / what will I get at the end?" framing. The header
  doc-comment in the file is excellent and could seed the info well.
- Tooltips: zero `<Tooltip>` calls across all four step components.
  Field-mapping (`StepSchemaReview`) shows raw column→dox-field
  dropdowns with no help text on any individual dox field (lot_number,
  customer_number, etc.).
- Empty / error states: `Alert` based, fine on errors, weak on
  empty/initial states (e.g. "drop a file" text exists but isn't
  explanatory).
- Maturity: **partial**. Priority: HIGH — first-time-user surface.

### Documents — `src/pages/Documents.tsx`

- Header: `Documents` h4, no info well, no AI-search affordance
  explanation despite the AI search dropdown being non-obvious.
- Tooltips: none on filter chips, none on the AI-search affordance.
- Empty state: `<Typography>No documents found</Typography>`.
- Errors: standard.
- Maturity: **none**. Priority: HIGH (high-traffic page).

### Import (smart-upload) — `src/pages/Import.tsx`

- Header: `Import` h4. The page does in-line tutorial-ish copy
  ("Leave empty to let AI detect the document type automatically.")
  but no top-level flow explainer.
- Tooltips: minimal. Field-edit chips and severity warnings all rely
  on inline copy.
- Errors: rich, multi-severity Alerts per item — best of any page.
- Maturity: **partial** (good error UX, no header / tooltips).
  Priority: HIGH.

### ReviewQueue — `src/pages/ReviewQueue.tsx`

- Header: `Review Queue` h4. No info well. The page is enormous and
  many of its decisions (vlm-diff, capture builder, field ordering)
  are non-obvious.
- Tooltips: minimal — most controls are bare buttons.
- Empty state: `<Typography>All items have been reviewed.</Typography>`
  for one branch, `No {status} items found.` for others. **Best empty
  state in the app**, but only barely.
- Errors: inline-row Alerts, good.
- Maturity: **partial**. Priority: HIGH.

### IngestHistory — `src/pages/IngestHistory.tsx`

- Header: `Ingest History` h4. No explanation of what's logged here vs.
  the Activity page.
- Tooltips: tooltip wrapper imported but no field-level help.
- Empty state: `No queue items found`.
- Maturity: **none**. Priority: MEDIUM.

### Orders — `src/pages/Orders.tsx`

- Header: `Orders` h4, no info well. **Where do orders come from?
  Connectors? Manual?** — page doesn't say.
- Tooltips: none.
- Empty state: `No orders found`.
- Maturity: **none**. Priority: HIGH.

### Order detail — `src/pages/OrderDetail.tsx`

- Header: order number + chips, no flow context. Status transitions
  unexplained.
- Tooltips: none.
- Maturity: **none**. Priority: MEDIUM.

### Customers — `src/pages/admin/Customers.tsx`

- Header: `Customers` h4. `coa_delivery_method` (`email | portal |
  none`) chip shows in the table with no explanation.
- Tooltips: none.
- Empty state: `No customers found`.
- Maturity: **none**. Priority: HIGH.

### Customer detail — `src/pages/admin/CustomerDetail.tsx`

- Header: customer name + chips. No flow context (linked orders?
  delivery rules? requirements field?).
- Tooltips: none.
- Maturity: **none**. Priority: MEDIUM.

### Suppliers — `src/pages/admin/Suppliers.tsx` / SupplierDetail

- Header: `Suppliers` h4. No info well. Block-vs-active toggle
  unexplained.
- Tooltips: none.
- Empty state: `No suppliers found`.
- Maturity: **none**. Priority: MEDIUM.

### Products — `src/pages/admin/Products.tsx` / ProductDetail

- Header: `Products` h4. **Tenant-scoped vs. global model not
  explained anywhere.**
- Tooltips: none.
- Empty state: `No products found`.
- Maturity: **none**. Priority: MEDIUM.

### Document Types — `src/pages/admin/DocumentTypes.tsx`

- Header: `Document Types` h4. `naming format`, `extraction fields`
  columns are fully opaque to a new admin.
- Tooltips: none.
- Empty state: `No document types found`.
- Maturity: **none**. Priority: HIGH (config gateway for many things).

### Bundles — `src/pages/Bundles.tsx` / BundleDetail

- Header: `Bundles` h4. Draft → finalized workflow not explained.
- Tooltips: none.
- Empty state: `No bundles found`.
- Maturity: **none**. Priority: MEDIUM.

### Activity — `src/pages/Activity.tsx`

- Header: `Activity` h4. No info well. **Audit-vs-Activity-vs-IngestHistory
  distinction unclear** (three logs in the app, none cross-link).
- Tooltips: none.
- Maturity: **none**. Priority: MEDIUM.

### Audit Log — `src/pages/admin/AuditLog.tsx`

- Header: `Audit Log` h4. Action / resource columns are raw enum
  values.
- Tooltips: none.
- Empty state: `No audit entries found`.
- Maturity: **none**. Priority: LOW (admin-only).

### Search — `src/pages/Search.tsx`

- Header: `Search` h4. No info well. AI-search vs keyword toggle
  unexplained.
- Tooltips: none.
- Maturity: **none**. Priority: MEDIUM.

### Tenants (super_admin) — `src/pages/admin/Tenants.tsx`

- Header: `Tenants` h4. No info well.
- Tooltips: none.
- Empty state: `No tenants found`.
- Maturity: **none**. Priority: LOW (super-admin, low traffic).

### Users — `src/pages/admin/Users.tsx`

- Header: `Users` h4. Role chips (`super_admin | org_admin | user |
  reader`) shown without explanation. The temp-password reset Alert
  *does* have an info severity well — single bright spot.
- Tooltips: none on the role column.
- Empty state: `No users found`.
- Maturity: **partial**. Priority: MEDIUM.

### API Keys — `src/pages/admin/ApiKeys.tsx`

- Header: `API Keys` h4. Reveal-once warning is a good `severity=
  "warning"` Alert post-create, but no header info well explaining
  what API keys are or where to use them.
- Tooltips: none on the table.
- Empty state: `No API keys found`.
- Maturity: **partial**. Priority: MEDIUM.

### Login / Register / Forgot / Reset — `src/pages/Login.tsx` etc.

- These pages don't really need info wells (everyone knows what login
  is). Errors are clear. Reset / forgot flows could benefit from a
  one-line explainer.
- Maturity: **partial**. Priority: LOW.

### Profile — `src/pages/Profile.tsx`

- Header: `Profile` h4. The `force_password_change` warning Alert is
  good. No header info well.
- Maturity: **partial**. Priority: LOW.

### Public Drop — `src/pages/PublicDrop.tsx`

- Already has explanatory copy as part of its purpose. Inline upload
  page for vendors.
- Maturity: **good** (small surface, purpose-built copy).
  Priority: LOW (already self-explanatory).

## Top 3 priority modules

These drive the biggest user wins and should ship in D1/D2:

1. **Connectors (detail + wizard)** — first-time vendor/admin
   experience. Wizard has zero tooltips. Already mid-flight from the
   connector button-up; D1 finishes the job.
2. **Documents / Import / ReviewQueue** — daily-driver pages for the
   COA pipeline. Largest surface area in the app. Import already has
   good error UX so the marginal cost of adding an info well is small.
3. **Document Types + Naming Templates** — config gateways. Misconfigure
   here and downstream ingest breaks silently. Highest "explain or pay
   later" ratio of any admin module.

## Reusable assets already in the codebase

- `<Tooltip>` from MUI — used widely on icon buttons, never on field
  labels. The `<InfoTooltip>` wrapper just needs a thin shim.
- `<CopyId>` (`src/components/CopyId.tsx`) — same Tooltip+IconButton
  shape we'll want for `<InfoTooltip>`. Worth mirroring its UX.
- `EmptyState` is repeated as a local helper in:
  - `src/components/records/CalendarView.tsx`
  - `src/components/records/TimelineView.tsx`
  - `src/components/records/KanbanView.tsx`
  - `src/components/records/GalleryView.tsx`
  - `src/components/records/WorkflowsTab.tsx`
  - `src/components/records/FormsTab.tsx`
  - `src/pages/records/Sheets.tsx`
  Hoist these to a single shared `<EmptyState>` and migrate as part of
  D0 — six fewer copies long-term.
- `<Alert severity="info">` blocks already exist on
  `ConnectorDetail.tsx` (intake-door cards) — the model for the
  `<HelpWell>` shape. Migration is cosmetic: wrap in a dismissible
  Collapse keyed by localStorage.

## What surprised me

- **Records module is ahead of the rest.** Each view (Calendar /
  Timeline / Kanban / Gallery) ships its own `EmptyState` with title +
  body. The pattern is in the codebase — it just hasn't been
  generalized.
- **ConnectorDetail.tsx intake-doors section is already at "good"
  tier.** Recent Phase A/B work surfaced inline `<Alert
  severity="info">` blocks per door, plus rich tooltips on
  copy/rotate/show buttons. That UX is the template; D1 generalizes
  it.
- **ApiKeys.tsx and Profile.tsx have one-off info Alerts already.**
  Suggests prior authors had the instinct, just no shared primitive.
  D0 turns intuition into infrastructure.
- **No existing `<InfoTooltip>` or `<HelpWell>` partial.** A clean
  greenfield for D0 — no compatibility shims, no migration debt.

## Implications for slicing

- D0 is genuinely 0.5 day — four small components plus a typed
  content module.
- D1 (Connectors) is partly done already; the wizard and runs table
  are the gaps.
- D2 modules are nearly identical templated list pages — once D0 lands
  the per-page work is mechanical (header + 2–3 tooltips + empty state
  swap). Estimating 1.5 days holds.
- D6 coverage check is real work, not pro-forma — 18 modules to
  re-walk.
