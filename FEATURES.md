# Features

This file is an index of release notes. See [`releases/`](releases/) for
per-version detail. New entries are added by `bin/release` — do not
hand-edit historical entries.

## Releases

- [v2.6.0](releases/v2.6.0.md) — 2026-04-28 — Records module — collaborative trackers, forms, update requests, and workflows
- [v2.5.0](releases/v2.5.0.md) — 2026-04-28 — Release versioning system
- [v2.4.3](releases/v2.4.3.md) — 2026-04-27 — Phase 3a — pre-fill, uncertainty, dashboard
- [v2.4.2](releases/v2.4.2.md) — 2026-04-27 — Phase 2 — capture reviewer decisions
- [v2.4.1](releases/v2.4.1.md) — 2026-04-27 — Phase 1 — foundation fixes

---

# Pre-versioning history

The entries below pre-date the `bin/release` workflow and are kept for
context. Going forward, ship notes live under `releases/v*.md`.

## 2026-04-17: Prod Deploy — Session Promotion to supdox.com

Promoted 17 commits (`9d09b0e..a91e11f`) from master to production in a
single gated deploy.

### Migrations applied to prod D1
- `0034_vlm_extraction_fields` — `vlm_*` columns on `processing_queue`
- `0035_supplier_extraction_instructions` — new table with UNIQUE on
  `(supplier_id, document_type_id)`
- `0036_extraction_evaluations` — new table with UNIQUE on
  `(queue_item_id, evaluator_user_id)`
- `0037_connector_soft_delete` — `connectors.deleted_at` column +
  `idx_connectors_deleted_at`

All four are additive (ALTER TABLE ADD COLUMN / CREATE TABLE IF NOT
EXISTS). Prod data integrity preserved: documents=113, processing_queue=183
both unchanged across the deploy.

### Code shipped to supdox.com
- VLM dual-extraction wiring (controlled by `QWEN_VLM_MODE`, still `off`
  in prod until manually flipped on the GPU host)
- Per-supplier extraction instructions (reviewer textarea + worker
  prompt injection)
- Tinder-style A/B eval (`/eval` + `/eval/report`)
- Connector stabilization pass (webhook column fix, draft-vs-deleted
  list disambiguation, wizard rehydrate fix, file_watch manual upload
  runner, per-type live test probes)
- Playwright e2e gate baked into `bin/deploy`
- +18 new vitest API regression tests

### Deploy gate
- Pre-flight: `bin/e2e` ran 707 vitest + 10 playwright tests in ~1m20s
  against staging — all green
- Staging promotion: `045b76b8.doc-upload-site-staging.pages.dev`
- Prod deployment: `51e5ad80.doc-upload-site.pages.dev`
  (https://supdox.com)
- Prod process-worker (PID 3319237) intentionally **not restarted** —
  the new instruction-injection and VLM code paths only activate after a
  worker restart, which the user will trigger when ready

### Operational note
`bin/migrate` is not idempotent against an already-migrated prod DB.
The four new migrations were applied directly via `wrangler d1 execute`
because `npm run migrate:remote` errored on already-applied 0006
(`duplicate column name: force_password_change`). Future cleanup:
mirror `bin/migrate-staging`'s `(tolerated: ...)` re-run logic into
`bin/migrate`.

## 2026-04-17: End-to-End Test Gate

### `bin/e2e` — one command, no more manual clicking
- `bin/e2e` runs the full pre-deploy suite: vitest (707 API + unit tests)
  then Playwright (10 tests driving live staging). Total ~1m20s on a
  clean run.
- `bin/deploy` now calls `bin/e2e` first and bails if anything fails.
  Emergency bypass: `SKIP_E2E=1 ./bin/deploy`.
- `npm run e2e` alias wraps the script.

### Playwright coverage
- `tests/e2e/auth.spec.ts` — login happy path, bad-password rejection,
  logout redirect
- `tests/e2e/smart-upload.spec.ts` — drop a PDF on /import, verify it
  reaches the processing queue, clean up
- `tests/e2e/review-approve.spec.ts` — approve a pending queue item,
  verify a document shows up via /api/documents with the edited metadata
- `tests/e2e/connector-wizard.spec.ts` — file_watch full loop: discover
  schema, preview extraction, save, run, live probe, delete
- `tests/e2e/ab-eval.spec.ts` — partner login, pick a winner, verify
  report count ticked up
- `tests/e2e/admin-smoke.spec.ts` — create + delete supplier, document
  type, and user through the admin APIs (UI renders verified along the way)
- Login once per run via `global-setup.ts`; session reused by all specs.
  Separate `unauth` and `partner` projects for the flows that need
  different auth state.

### API regression coverage (vitest, +18 tests)
- `tests/api/documents-ingest.test.ts` — upsert by external_ref, version
  bumps, source_metadata persistence, product_ids linking, missing-field
  400s
- `tests/api/webhooks-email-ingest.test.ts` — Mailgun + SendGrid payload
  shapes, unknown-sender graceful handling, multi-attachment splitting
- `tests/api/documents-search.test.ts` — LIKE across title / file_name /
  primary_metadata plus supplier_id narrowing
- `tests/api/documents-versions.test.ts` — v1+v2 via ingest, versions list
  ordering, per-version download bytes

### GitHub Actions
- `.github/workflows/test.yml` now has a second `e2e` job that runs
  Playwright against staging on push to master + manual dispatch. Traces
  uploaded on failure.

## 2026-04-17: Connector System End-to-End

### Stabilization pass
- Webhook endpoint column bug fixed (`connector_type`, not `type`) — public
  webhook deliveries now reach the auth + routing path correctly
- Draft connectors (saved with `active=0`) now appear in the main
  Connectors list with a filled "Draft" chip; deletion uses a dedicated
  `deleted_at` column (migration 0037) so tombstoned rows stay hidden
  without colliding with draft state
- Wizard edit mode always rehydrates the stored sample on load regardless
  of the target step, and seeds the auto-apply guard so Back -> Next
  round-trips no longer stomp saved mappings

### file_watch manual runs
- `POST /api/connectors/:id/run` accepts multipart CSV / TSV / XLSX / PDF
  uploads (5MB text, 10MB binary), parses through the connector's saved
  field_mappings, and persists orders + customers + a `connector_runs`
  row via the shared orchestrator
- Per-row parser errors are recorded as `records_errored` and the run
  finishes with status `partial` — bad rows never abort the batch
- New `fileWatch.ts` executor registered in the connector registry;
  XLSX / PDF paths delegate to the email connector's attachment parsers
  so field-mapping behavior stays identical across connector types
- Explicit 501 for api_poll / webhook (manual run not implemented yet)

### Live Test probes
- `POST /api/connectors/:id/test` now runs a per-type live probe:
  * file_watch — verifies R2 sample reachability + returns file metadata
    (filename, size, source_type, row count for text)
  * email — verifies `email_domain_mappings` rows exist for the tenant
    and returns inbound `{slug}@supdox.com` + sender-domain list
  * webhook — returns public webhook URL + sample curl, flags missing
    auth config
  * api_poll — clean "not implemented" (HTTP 200, probe.ok=false)
- UI: ConnectorDetail surfaces the probe payload as an Alert with a
  key/value detail grid on Test click
- Legacy `success` field preserved (still means "config shape valid")

### Coverage
- 689 tests passing (up from 656)
- New suites: connector-run-file-watch (11), connector-test-live-probe
  (8), connector-webhook-column-fix (4), connector-list-drafts (4),
  unit/fileWatch (6)

## 2026-04-17: Tinder-Style A/B Evaluation (Text vs VLM)

### Blind-compare review flow (staging only)
- `/eval` full-screen page: doc preview on the left, two blind-labeled
  extraction cards ("Method A" / "Method B") on the right
- Three-button pick (A wins / B wins / Tie or both wrong), optional comment,
  auto-advance to the next unevaluated doc
- Server randomizes which real method is shown as Method A per request and
  the client echoes that back on POST so the aggregate report can unblind
  without leaking labels into the UI
- `/eval/report` dashboard: headline text vs VLM win counts, per-supplier
  and per-doctype breakdowns, list of all reviewer comments, CSV export
- Upsert on submit — reviewers can re-evaluate an item to correct mistakes
- Migration 0036 adds `extraction_evaluations` with a
  UNIQUE(queue_item_id, evaluator_user_id) constraint
- Staging-only; prod remains untouched until the eval feedback is collected

## 2026-04-17: Per-Supplier Extraction Instructions

### Reviewer-authored natural-language guidance (staging only)
- Per (supplier, document_type) textarea in the Review Queue
- Autosaves on blur (500ms debounce) to `/api/extraction-instructions`
- Worker prepends guidance to both the text and VLM Qwen prompts on every
  future extraction for that pair
- Complements the silent few-shot correction loop with an explicit
  "teach the model" surface reviewers can see and edit
- Migration 0035 adds `supplier_extraction_instructions` table with a
  UNIQUE(supplier_id, document_type_id) constraint
- Staging-only deploy; prod remains pristine until validated

## 2026-03-26: Regulatory Document Management Expansion

### Products (Global Catalog)
- Global product catalog shared across tenants (super_admin manages)
- Tenant-product associations (which suppliers provide which products)
- Full CRUD API + admin UI

### Document Types (Per-Tenant)
- Per-tenant document type definitions (COA, Spec Sheet, SDS, etc.)
- Replaces freeform category with structured classification
- Full CRUD API + admin UI

### Structured Document Metadata
- First-class fields on documents: lot_number, po_number, code_date, expiration_date, document_type_id
- Accepted by ingest, create, update endpoints
- Searchable via document search and list filters

### Document-Product Linking with Expiration
- Many-to-many link between documents and products
- Per-link expiration date and notes
- ProductLinker UI component on document detail page
- Color-coded expiration badges
- MindStudio can send product links via ingest API (product_ids field)

### Smart File Naming Templates
- Per-tenant naming templates with placeholders ({lot_number}, {product}, {doc_type}, etc.)
- Applied automatically during document ingest
- Admin UI with live preview and clickable placeholder chips

### Email Ingest Webhook
- POST /api/webhooks/email-ingest for Mailgun/SendGrid inbound parse
- Maps sender domain to tenant via email_domain_mappings
- Extracts attachments and creates documents automatically
- Admin UI for managing domain mappings

### Expiration Dashboard & Alerts
- Dashboard page showing documents approaching expiration
- Summary cards (expired, critical, warning, ok)
- Configurable look-ahead period (7-365 days)
- Status filters and tenant scoping
- Email notifications to org_admins via Resend

### Document Bundles (Compliance Packages)
- Create named bundles, optionally linked to a product
- Add/remove documents with version pinning
- Download bundle as ZIP
- Draft/finalized workflow
- Reusable DocumentPicker component

## 2026-04-09: Phase 2 — Connector System, Orders & Customers

### Connector Framework
- Universal data connector system supporting email parse, API poll, webhook, and file watch types
- Credential encryption for secure storage of API keys and passwords
- Field mappings to transform external data into internal schemas
- Connector runs tracking with status, logs, and error reporting

### Customer Registry
- Customer management with COA delivery preferences (email, portal, both)
- Lookup by customer number for fast matching
- Per-tenant customer records with contact details

### Order Pipeline
- Orders with line items, full status workflow (pending → enriched → matched → fulfilled → delivered)
- Item-level COA matching tracks which documents satisfy each line item
- Order search and status filtering

### Order Intake via Email
- ERP email parsing (text/CSV/AI) creates orders and customers automatically
- Connector-driven intake pipeline from email to structured order data

### Order Search
- Enhanced text search across all order fields (order number, PO, customer name/number, product names, lot numbers)
- Natural language AI search via Qwen — understands queries like "Kraft orders from last week", "unfulfilled orders with vanilla", "orders with lot L2026-0412"
- POST /api/orders/search/natural endpoint for AI-powered order queries

### Unified Search Page
- Documents/Orders tabs on the Search page
- Both tabs support regular and AI search modes
- Consistent search experience across all data types

### Admin UI
- Connectors: list, detail view, creation wizard with step-by-step configuration
- Customers: list with search, detail view with order history
- Orders page with status filtering, search, and item progress tracking

## 2026-04-16: VLM Extraction & Unified Activity Feed

### VLM Dual-Run Extraction (Qwen2.5-VL-7B)
- New vision-language model extraction path runs alongside the existing text/OCR pipeline
- `QWEN_VLM_MODE` env on process worker: `off` (default), `dual` (run both, store both), `vlm` (VLM only)
- Renders PDF pages to PNG at scale 2.0, capped at 5 pages per doc for VRAM safety on the Qwen GPU host
- Safety guard rejects sub-100-byte PNGs to avoid the llama.cpp CLIP encoder GGML_ASSERT 2x2-pixel crash
- New `vlm_*` columns on `processing_queue` (migration 0034) hold the VLM result independently of the primary extraction
- Side-by-side compare UI in Review Queue when both extractions exist: per-field source picker (text vs vlm), match/differ/text-only/vlm-only summary badge
- Reviewer's `selected_source` choice is recorded in the audit log for future preference analysis
- Pure, unit-tested helpers (`reviewVlmDiff.ts`, `reviewTableActions.ts`) keep the diff and table-edit logic out of the React component

### Unified Activity Feed
- New Activity page merges every ingest event in the system into one timeline: connector runs, document ingests, orders created, and audit log entries
- `GET /api/activity` and `GET /api/activity/event` endpoints with date-range, event-type, connector, source, and status filters
- Expandable rows show the full details JSON; cross-navigation links jump to the relevant connector/order/document/user
- Load-more pagination, backend-enforced max 200 per page
- Pure `activityMerge.ts` module with full unit coverage handles sort + pagination

### Connector System Refinements
- Connector CRUD, test-connection, and creation wizard tightened
- Schema-discovery wizard, field-mapping v2, and preview-extraction pipeline (from previous commit) wired into the admin UI
- Additional API + unit tests covering connector CRUD and wizard field mappings

## 2026-04-17: Cloudflare Staging Environment

- New Pages project `doc-upload-site-staging` at `https://doc-upload-site-staging.pages.dev`, fully isolated from prod
- Separate D1 (`doc-upload-db-staging`) and R2 (`doc-upload-files-staging`) so staging traffic never touches the prod DB/bucket
- Fresh `JWT_SECRET`, fresh seeded `super_admin`; `RESEND_API_KEY` / `QWEN_URL` / `QWEN_SECRET` reuse the same shared infrastructure
- Reusable scripts: `bin/deploy-staging`, `bin/migrate-staging`, `bin/seed-staging`, `bin/reset-staging-db`
- `wrangler.staging.toml` holds the staging bindings; `bin/deploy-staging` temporarily swaps it into `wrangler.toml` for the upload, then restores the prod config on exit
- `migrate-staging` recreates `email_domain_mappings` before 0020 (migration 0017 drops it — prod has the same historical quirk)
- Package scripts: `npm run migrate:staging`, `npm run seed:staging`, `npm run deploy:staging`
