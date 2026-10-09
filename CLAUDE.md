# dox

Multi-tenant document upload/download portal with version tracking, role-based access control, audit logging, and report generation. Built for regulatory document management where manufacturers and vendors independently manage their documents.

## Startup
- Read `next-time.md` at the start of every conversation. Address any notes/thoughts before doing anything else.

## Architecture

- **Runtime**: Cloudflare Pages Functions (Workers)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **File Storage**: Cloudflare R2 (object store)
- **Frontend**: React 18 + MUI 6 + React Router + Vite
- **Auth**: Custom JWT (HMAC-SHA256, PBKDF2 passwords, 24h token expiry) + API keys (`X-API-Key` header, `dox_sk_` prefix)
- **Email**: Resend API (invitation, password reset notifications)
- **GraphQL**: graphql-yoga (parallel API surface to REST)
- **Types**: `shared/types.ts` is the single source of truth for all API shapes (used by both backend and frontend)

## Key Directories

```
functions/api/          # REST API endpoints (Cloudflare Pages Functions)
  auth/                 # login, register, password, logout, forgot/reset-password
  documents/            # CRUD, upload, download, versions, search, ingest, lookup
  api-keys/             # API key management (create, list, revoke)
  tenants/              # CRUD
  users/                # CRUD, me, admin password reset
  reports/              # CSV/JSON report generation
  audit/                # Audit log queries
  products/             # Global product catalog CRUD, tenant-product associations
  suppliers/            # Supplier CRUD, lookup-or-create
  document-types/       # Per-tenant document type CRUD
  document-products/    # Document-product linking with expiration
  bundles/              # Document bundles (compliance packages), download as ZIP
  expirations/          # Expiration dashboard queries, email notifications
  webhooks/             # Email ingest webhook (Mailgun/SendGrid)
  naming-templates/     # Per-tenant file naming templates
  email-domain-mappings/ # Email domain to tenant mapping CRUD
  graphql.ts            # GraphQL endpoint (yoga)
  _middleware.ts        # CORS, security headers, JWT + API key auth
functions/lib/          # Shared utilities
  auth.ts               # JWT + password hashing (PBKDF2) + API key generation
  db.ts                 # Audit logging, ID generation
  email.ts              # Resend email templates
  permissions.ts        # Role checks, tenant access, error classes
  r2.ts                 # R2 file operations, checksum
  ratelimit.ts          # D1-based rate limiting
  validation.ts         # Password/email validation, input sanitization
  graphql/              # GraphQL schema, resolvers, context
shared/
  types.ts              # Single source of truth for all API types (backend + frontend)
src/                    # React frontend
  components/           # Reusable UI components
  contexts/             # React contexts (auth, etc.)
  pages/                # Route pages
migrations/             # D1 SQL migration files (table below; rationale in docs/migration-history.md)
bin/                    # Operational scripts (deploy, migrate, seed)
```

## API Documentation

- **`openapi.yaml`** — Complete OpenAPI 3.1 spec for all REST endpoints
- **`API.md`** — Human-readable implementation guide with examples

## Key Features

**These are summaries. The full design notes for every feature below are in `docs/feature-notes.md`, under a
heading with the same bold name -- READ THAT ENTRY BEFORE CHANGING THE FEATURE** (the rules there are
mostly "never do X" decisions from the SME, with the measurements behind them). When a feature
changes, update its entry there and keep the line here to 1-2 sentences.

- **API Keys**: Programmatic access via `X-API-Key` header (`dox_sk_` prefix). Created/revoked by admins. Keys auth as the creating user.
- **Document Ingestion**: `POST /api/documents/ingest` — upsert by `external_ref` + `tenant_id`. Creates new doc or adds version. Designed for agentic/email pipelines. Supports `source_metadata` (JSON).
- **Document Lookup**: `GET /api/documents/lookup?external_ref=X&tenant_id=Y` — find document by external reference.
- **Password Management**: Forgot password (self-service email flow), admin reset (generates temp password, sets `force_password_change`), force change on next login.
- **Document Preview**: Inline preview for PDF (iframe), images (img tag), text/CSV (rendered inline). Office docs show download card.
- **File Name Search**: `GET /api/documents/search` now also matches against `file_name` in document_versions (joined).
- **Products**: Global product catalog shared across tenants. Tenant-product associations track which suppliers provide which products.
- **Document Types**: Per-tenant document type definitions (COA, Spec Sheet, SDS, etc.) replacing freeform categories.
- **Document-Type Classification (its own pass, before extraction)**: `classifyDocumentType` (`functions/lib/llm.ts`, mirrored in `bin/process-worker`) picks a type from the tenant's own catalog BEFORE extraction, on the `fast` chain. EXACT name/slug match only: a near miss is parked in `processing_queue.document_type_guess`, never fuzzed onto the nearest type.
- **Real-document regression corpus**: `tests/fixtures/real-corpus` + `bin/eval-aj-docs` (`--verify` needs no model). The real PDFs are tracked in git (nothing to rebuild them from). `--verify` is the no-model regression test for per-page OCR routing.
- **Shelf life and document number (the two fields the corpus proved had no slot)**: canonical in all THREE mirrored prompt copies (`functions/lib/llm.ts` BASE_PROMPT + the text and VLM prompts in `bin/process-worker`), pinned byte-identical by tests. `shelf_life` is one verbatim string and is NEVER an input to `shared/renewalPeriod.ts`; `document_number` is never set on a certificate.
- **The model chain going empty**: `bin/check-model-chain` exits non-zero naming the missing models; a degraded chain or unreachable router passes. `bin/eval-aj-docs` runs it first (exit 3); `bin/process-worker` preflights `fast` and warns without aborting.
- **Per-Page OCR Routing (the page that is a picture with a caption on it)**: `shared/pdfPageOcr.ts` (pure) + `bin/lib/pdfPageOcr.js`, migration 0117. A page goes to OCR only on the PAIR: one image >=25% of the page AND a text layer under 300 chars. OCR NEVER OVERWRITES a text layer; only qualifying pages are rasterised (25-page budget).
- **One File Is Not One Document (packet detection, migrations 0118/0119)**: `shared/packetDetect.ts` proposes, `PacketSplitCard.tsx` asks, `functions/lib/packet-split.ts` splits on confirm. NOTHING AUTO-SPLITS. Child parts do NOT inherit the type; the parent is a container the approve path refuses. Measure with `bin/packet-detect`.
- **Expired on Arrival (rules table G4, migration 0121)**: `shared/expiredOnArrival.ts` + `functions/lib/expired-on-arrival.ts`. A certificate whose `document_expires_on` precedes `documents.arrived_at` is flagged, does not close its requirement (`expired_on_arrival`), and notifies the QA route with `adminFallback: false`. Nothing is held.
- **Fixed-Window Renewal (rules table G3, migration 0125)**: `document_types.renewal_window` JSON REFINES the `period` policy (never a fourth policy word); `resolveRenewalExpiry` tier 3b `document_type_window`. FDA default via `defaultRenewalSettingForTypeName`.
- **Packet Provenance (rules table H1, migration 0126)**: `functions/lib/packet-provenance.ts` freezes a `PacketCitation` on `document_versions.source_packet` after any approve path, never rewritten; a part's `arrived_at` is the packet's. `GET /api/documents/:id/download?source=packet`.
- **Sales Sheet Check (rules table F6)**: `shared/salesSheetCheck.ts` flags a spec-sheet queue item carrying no controlled-document mark (`sales_sheet_warning`, reject preset `sales_sheet`). Warn, never block.
- **Requirement Scope (migration 0123)**: `requirements.scope` supplier / product / lot (`shared/requirementScope.ts`, `shared/requirementGap.ts`, loader `functions/lib/requirement-gaps.ts`). A per-product pair closes ONLY through a confirmed document linked to that product; an unattributed document closes nothing. Supplier-scope-only tenants stay byte-identical (golden-pinned). `bin/propose-requirement-scopes`.
- **Structured Metadata**: Flexible JSON metadata on documents via `primary_metadata` and `extended_metadata` columns. Old hardcoded fields (lot_number, po_number, code_date, expiration_date) remain in DB but are unused.
- **Suppliers**: First-class supplier entity per tenant. Documents link to suppliers via `supplier_id`. Lookup-or-create endpoint for fuzzy matching. A merge (`mergeSuppliers`) must move every table with a CASCADE `supplier_id`; spec limits and required analytes move, and a collision keeps the winner's row and records the loser's whole row in the `supplier.merged` audit.
- **Supplier Contacts (migration 0133)**: `supplier_contacts` + `/api/suppliers/:id/contacts` (`functions/lib/supplier-contacts.ts`); at most ONE active document contact per supplier, the address renewal requests go to. Anything new with a `supplier_id` ON DELETE CASCADE must be added to `mergeSuppliers` (a merge used to delete the loser's requests).
- **Document-Product Linking**: Many-to-many links between documents and products with per-link expiration dates and notes. Ingest API accepts `product_ids`.
- **Naming Templates — NOT IMPLEMENTED**: `naming_templates` (0014) was dropped by 0018 and `document_types.naming_format` has zero readers: no file is renamed at ingest. Same status as `document_types.auto_ingest` -- nothing in dox auto-ingests, deliberately. The three dead auto-approve / auto-ingest switches are off the screens (`tests/unit/deadSwitchesOffScreens.test.ts`); columns and API fields stay.
- **Email Ingest**: `POST /api/webhooks/email-ingest` for Mailgun/SendGrid inbound parse. Maps sender domain to tenant, extracts attachments. The summary and "Review Needed" mails reach the sender ONLY when the sender is an active user of that tenant; otherwise the org_admins get an internal notice (`functions/lib/intake/sender-notice.ts`, audited `intake.sender_notice`).
- **Exact-Duplicate Intake + "You Already Have This" (migrations 0108, 0132)**: detection in `functions/lib/intake/duplicates.ts` (inside `enqueueDocument`); proposal computed at READ, never stored (`functions/lib/intake/already-have.ts`, `shared/duplicateProposal.ts`); card `DuplicateDecisionCard.tsx`. A PERSON decides: `PUT /api/queue/:id` refuses approval without `duplicate_decision` (replace / keep_both / discard). Exact identity keys only, never a title. `POST /api/documents/ingest` is deliberately NOT checked.
- **Expiration Dashboard**: Dashboard showing documents approaching expiration with summary cards, configurable look-ahead, and email alerts.
- **Scheduled Renewal Alerts (per-owner)**: `workers/renewal-alerts/` cron -> `POST /api/expirations/run-scheduled`; engine `functions/lib/renewal-alerts.ts`, routing `functions/lib/alert-routing.ts`, lead time `shared/renewalLeadTime.ts` (0091, 0111). Renewals pass `adminFallback: false`: an unrouted record is a routing gap, never re-broadcast to admins. No run-wide `window_days`. The same run DRAFTS supplier requests (below) as its own pass.
- **Supplier Renewal Send (migration 0133)**: `functions/lib/renewal-requests.ts` + `shared/renewalRequestTemplate.ts`. THE PORTAL NEVER EMAILS A SUPPLIER ON ITS OWN: the run only drafts (window open, day of, +7, +14, then stop and escalate at 21 days); `POST /api/renewal-requests/:id/sends/:sendId/approve` by the assigned approver or an admin is the only path that mails a supplier. Fixed allow-list template, system-appended link block, exact text sent is stored and audited.
- **Renewal Periods + the Approval-Time Decision**: resolved in ONE place, `resolveRenewalExpiry` (`shared/renewalPeriod.ts`); the proposal is confirmed at approval with a frozen `renewal_snapshot` (`functions/lib/renewal-proposal.ts`; 0096, 0097). `document_expires_on` is NOT `expiration_date` (the product's shelf life). An `unresolvable` proposal is not an answer. Type defaults come from `defaultRenewalSettingForTypeName`. A date changed later on the document page is recorded as a decision too (`post_approval_edits`, `document.renewal_decided` via `document_edit`); emptying it means "does not renew".
- **Documents out of Search (migration 0115)**: `functions/lib/document-export.ts`; `POST /api/document-exports/zip` and `/send` (a token link, never attachments), recipient page `/export/:token`, Sent documents + revoke (0116). Caps are stated, never truncated; the token is never returned; reader may ZIP, not send; there is no Extend.
- **Sharing Rule (migration 0137)**: every document is `free` / `qa` / `locked` (`shared/sharingRule.ts`, loader `functions/lib/sharing-rule.ts`): type rule with a per-document override, NO TYPE = locked, unrecognised name = qa. Held on EVERY exit (ZIP, emailed link, public link read, bundle ZIP, order send / resend, any API-key file read); a logged-in person opening one file is not leaving; an API key reads `free` only and never loosens a rule; a refusal is always stated, never a silent drop. ANY write to a document's type or override goes through `planDocumentRuleChange` (loosening: admin off `locked`, QA releaser `qa` -> `free`). A file that touches the bucket is pinned in `tests/unit/exitRegister.allow.ts`.
- **Manual COA Fulfillment: an order a person builds and sends (migration 0134)**: `functions/lib/order-items.ts` (a pick = the accept columns + an `accepted` `manual_pick` suggestion row), `functions/lib/order-send.ts` + `shared/orderSend.ts` (attachments under generated names, 15 MB parts "1 of N", a non-expiring link for one oversize file, `partial` sends that resend), `functions/lib/coa-original.ts` (a multi-lot certificate goes WHOLE; never guesses the original). One order record for both tiers; approved documents only; no type check (sales documents come later).
- **Approved Items, Facilities, Customer Contacts and COA Requirements (migration 0135)**: `functions/lib/item-approval.ts` (`decideItemApproval`, `listApprovedItems`), `functions/lib/customer-coa.ts`, `shared/itemApproval.ts`; `GET /api/approved-items`, `/api/suppliers/:id/facilities`, `/api/customers/:id/contacts` + `/item-requirements`. Approval is on the item-and-supplier pair and is NOT "currently supplied"; existing pairs are `approved` / `initial` (never `person`), new ones `pending`; an import never overrides a person; a facility is added by a person, never inferred; `private_label` is a display flag. NONE of it changes a gap, renewal, search answer or what an order may send -- the order review only gains pre-filled COA contacts and a warning.
- **Document Orders (migration 0138)**: document LINES (`order_documents`: one per order, item, supplier, type) on the same order record, built by any login from the approved item list and resolved by `shared/currentDocument.ts` + `functions/lib/current-document.ts` (the item's own document before the supplier's, newest; an expired newest is `expired`, never swapped for an older one). Each leaves by its LIVE sharing rule (`rule_at_resolve` decides nothing): free on one 30-day link, `qa` held (`pending_qa`) until a QA releaser releases it in their own name (`functions/lib/order-document-release.ts`, never an API key; pinned to the document, version and asking send QA saw; `releasing` until the mail is recorded), locked / missing / expired never; QA is told once per line per cause and NOTHING is drafted or sent to a supplier.
- **Holds (migration 0139)**: `document_holds` (append-only) holds ONE LOT ROW or a whole certificate (`shared/holds.ts`, `functions/lib/hold-state.ts`, `functions/lib/holds.ts`). A LOT hold covers every certificate of the same SUPPLIER + `lot_key` + sublot, whatever product a row resolved to (`lotHoldCovers`, never one `lots` row), and every file that prints it (`loadEffectiveHolds`); a file is its CURRENT VERSION's queue item (`document_versions.source_queue_id`, never `origin_queue_id`). `loadSharingRules` carries holds and the strictest rule of what the file prints; `judgeExit` answers `held` FIRST; only `POST /api/holds/:id/release` ends one (QA releaser or admin, reason required). Automatic at APPROVAL only (Critical out of spec; zero-tolerance sample-size mismatch), once per judged result; a hold that could not be placed is recorded, mailed and retried (`document_hold_failures`), never quiet. `delivered` means every line TRAVELLED (one function, `everyOrderLineTravelled`). B3 supplier-probation holds NOT built; nothing reaches a WMS.
- **One Search Query + Executor (search redesign Phase 1, migration 0122)**: `shared/searchQuery.ts` + `shared/searchFields.ts`, executor `POST /api/search/query` (`functions/lib/search/execute.ts`), keys in `document_search_keys`. Scope fields are SQL filters; identifying fields are judged by the UNCHANGED `evaluateSubject` -- never nearest-as-answer. "lot 104" is a lot prefix, never free text.
- **Search Advanced mode and every field (search Phase 3, migrations 0130/0131)**: Easy and Advanced edit the ONE `Clause[]` (`src/components/search/`, `compileScope.ts`). Each new scope field is one SQL expression with a JS mirror; `keys_only` identifying fields; result modes return `groups`; shared saved views are org_admin only.
- **Search regression testing (golden corpus + eval harness + tenant examples)**: `tests/api/search-golden.test.ts` (+ `tests/fixtures/search-golden/`), `shared/searchProbes.ts`, `bin/eval-search`, `GET /api/search/eval-sample`, `GET /api/search/examples`. Legacy / lot-decoded dates must land LIKELY, never covering.
- **Document Bundles**: Named compliance packages grouping documents with version pinning. Download as ZIP. Draft/finalized workflow.
- **Extraction Prompt Stack (three layers)**: tenant `extraction_context` (0072) -> document-type instructions (0098) -> (supplier, type) instructions (0035/0068), resolved by `functions/lib/extractionInstructionStack.ts`. The authored layers COMPOSE; `instructions` stays the supplier row alone (`effective_instructions` is the composed text). Guidance never outranks rule 14. The fallback industry layer is GENERIC (`GENERIC_INDUSTRY_CONTEXT`); the dairy text is a named template, and migration 0136 pinned it into every tenant that relied on the old fallback (worker flavour stored; `industryLayerForThisSurface` reads it back on the Pages surface). BASE_PROMPT rule 5 names the organisation by passing `tenants.name` in (`ownOrganisationRule`; degrades to the general Ship To sentence with no name), mirrored in the worker's text prompt.
- **No first-tenant values in what ships (the guard)**: `tests/unit/noFirstTenantValues.test.ts` scans shipped code and starter packs for the first tenant's names and real identifiers OUTSIDE comments; allow-list with reasons in `noFirstTenantValues.allow.ts`. Examples are invented values of the same shape.
- **Lot-Row Retrieval (Any-Field COA Retrieval, Phase 2)**: `shared/searchCoverage.ts` + `functions/lib/search-coverage.ts` judge ONE LOT ROW at a time (`matched_lot`; migration 0106). A production date read from a legacy code date is `likely`, never covering.
- **Products by Any Name + Orders (Any-Field COA Retrieval, Phase 3)**: `product_identifiers` (0107), `shared/productIdentity.ts`, `shared/productVocabulary.ts`, `shared/orderCoverage.ts`. A phrase fitting several products is `ambiguous` -- nothing is picked; an unconfirmed identifier is `likely`. `customer_item_number` is in all three prompt copies.
- **One Store for Product Identity (migration 0113)**: `product_identifiers` is the ONLY store (`supplier_product_map` dropped by 0124). Lot matching resolves through `resolveSupplierProduct` (`shared/supplierProductBridge.ts`) and NEVER picks between candidates; review-time teach is `teachSupplierProduct` (`functions/lib/product-identifiers.ts`). `/api/product-map` is removed.
- **Declared Lot Formats (Any-Field COA Retrieval, Phase 4, migration 0110)**: `supplier_lot_schemes` (append-only versions) + `shared/lotScheme.ts` (`validateLotSchemeSpec`, `decodeLot`). A decode is a validator and a labelled fallback (`lot_decode`, search `likely`), never an authority: a stated date is never overwritten and the model never decodes lot codes. `bin/seed-supplier-lot-schemes`, `bin/report-lot-key-scheme`.
- **Spec Limits + Out-of-Parameter Warnings**: `spec_tests` + `spec_limits` (0084, 0085, 0093, 0095, 0105, 0109, 0114, 0120). Engine `shared/specCheck.ts` (pure), bands `shared/specBand.ts`, `functions/lib/spec-warnings.ts`, `functions/lib/spec-register.ts`, `GET /api/spec-unmatched`. Three-state: `not_checked` is never a silent pass. Warns, never blocks; criticality and bands never change a verdict; `version` bumps only when the threshold moves; `limit_snapshot` is frozen; unit equivalence is default OFF.
- **Supplier Requirements from Real Data (migration 0112)**: `deriveSupplierRequirements` (`shared/requirementDerivation.ts`) through ONE door, `POST /api/supplier-list/import` (`dry_run` default true). A human or packet row is never touched by an import; a derived row no longer implied is flagged, never deleted; a slug the tenant lacks is reported, never invented.
- **Request Composer**: `functions/lib/document-requests.ts` (`issueRequest`, the one issue path) + arrivals in `functions/lib/request-arrivals.ts` (0090, 0092, 0094, 0104, 0119). Amending after issue is a NEW version, never an overwrite; an arrival is not a document; accept requires Review Queue approval first.

## Migrations (0001-0139; 0127-0129 unused)

**Current schema state: `SCHEMA.md`** (generated — regenerate with `./bin/schema-doc`
after every migration). This table is migration *history*; SCHEMA.md is what the
database looks like *now*. Prefer SCHEMA.md when you need current columns.

⚠️ **Two migrations share the number 0023** (`0023_multi_product_fields.sql` and
`0023_processing_status.sql`). Ordering is deterministic by filename (multi_product
before processing_status), but never assume one file per number when scripting.

⚠️ The chain is **not re-runnable from scratch**. Prod tracks in **`d1_migrations`** (NOT `_migrations` — that table does not exist on prod; `bin/migrate` would create a competing one). Prod tracking
is drifted (0059-0067 applied-but-unstamped). Apply new migrations to prod
surgically and stamp them — never bulk `migrate:remote`. New migrations must also
be added to `tests/helpers/db.ts`.

⚠️ **A table rebuild (`PRAGMA defer_foreign_keys` + DROP/CREATE) must be applied with `bin/migrate-prod-one`,
never a raw `wrangler d1 execute --file`.** D1's import API lost the deferral when 0110's comment header held
non-ASCII characters (staging failed twice with "FOREIGN KEY constraint failed" and rolled back); the script
uploads a copy with full-line comments stripped. Rehearse a rebuild on a populated database first
(`tests/api/migration-0110-lots-rebuild.test.ts` uses the empty `MIGRATION_DB` binding), and check that every
foreign key pointing at the rebuilt table has no ON DELETE action — deferral does not stop CASCADE/SET NULL.
Roll back with `bin/restore` (Time Travel bookmark from `bin/backup`).

**Per-migration rationale** (why each table is shaped the way it is, what must never be changed,
how each was applied) is in **`docs/migration-history.md`** -- read the row there before altering a table it
describes. Add the full rationale for a new migration there and a one-line row here.

| # | File | Purpose |
|---|------|---------|
| 0001 | initial_schema | Core tables: users, tenants, documents, document_versions, audit_log, sessions |
| 0002 | seed_admin | Seed super_admin user |
| 0003 | indexes | Performance indexes |
| 0004 | rate_limits | Rate limiting table |
| 0005 | password_resets | Password reset tokens table |
| 0006 | force_password_change | Add force_password_change column to users |
| 0007 | external_ref | Add external_ref + source_metadata to documents, with unique index |
| 0008 | api_keys | API keys table |
| 0009 | document_content | Document content extraction/indexing support |
| 0010 | products | Global products table, tenant_products association |
| 0011 | document_types | Per-tenant document_types table |
| 0012 | structured_metadata | Add lot_number, po_number, code_date, expiration_date, document_type_id to documents |
| 0013 | document_products | Many-to-many document_products with expiration_date and notes |
| 0014 | naming_templates | Per-tenant naming_templates table |
| 0015 | email_domain_mappings | Email domain to tenant mapping for inbound email ingest |
| 0016 | document_bundles | Bundles, bundle_documents tables for compliance packages |
| 0017 | tenant_specific_products | Make products tenant-specific |
| 0018 | document_type_naming_and_extraction | Naming format and extraction fields on document_types |
| 0019 | smart_upload_and_queue | Processing queue, extraction examples for AI pipeline |
| 0020 | email_domain_default_doctype | default_document_type_id on email_domain_mappings |
| 0021 | extraction_example_supplier | Add supplier column to extraction_examples |
| 0022 | suppliers_and_dynamic_metadata | Suppliers table, supplier_id + primary_metadata + extended_metadata on documents |
| 0023 | multi_product_fields | Per-product field sets from AI extraction (multi-product COAs) |
| 0023 | processing_status | processing_status on processing_queue (async AI state). Duplicate 0023 number, see warning above |
| 0024 | queue_doctype_guess | AI doc-type guess column; document_type_id becomes nullable |
| 0025 | doctype_feature_toggles | Feature toggle columns on document_types |
| 0026 | extraction_templates | Per-(supplier, doc-type) field mapping configurations |
| 0027 | email_ingest_log | Inbound email tracking log |
| 0028 | product_supplier | supplier_id on products |
| 0029 | queue_source | source + source_detail on processing_queue |
| 0030 | connectors_and_orders | Connectors, connector_runs, customers, orders, order_items |
| 0031 | customer_contacts | customer_contacts join table |
| 0032 | order_metadata_and_field_mappings | primary/extended_metadata on orders (mirrors documents) |
| 0033 | connector_sample_ref | R2 key of the wizard-uploaded sample file |
| 0034 | vlm_extraction_fields | VLM dual-run extraction results alongside the text path |
| 0035 | supplier_extraction_instructions | Per-(supplier, document_type) natural-language extraction instructions |
| 0036 | extraction_evaluations | A/B evaluation of text vs VLM extraction (dropped again in 0058) |
| 0037 | connector_soft_delete | Separate "inactive draft" from "deleted" on connectors |
| 0038 | reviewer_decisions | Persist every reviewer decision (field picks, dismissals, table edits) |
| 0039 | learned_field_hints | Learned-hint sidecar columns on processing_queue (JSON) |
| 0040 | records_core | Records module core: sheets, typed columns, rows, refs, attachments, comments, activity, views |
| 0041 | records_forms | Public-link intake forms for Records |
| 0042 | records_customer_ref | customer_ref column type + index |
| 0043 | records_form_attachments | Public form attachments |
| 0044 | records_update_requests | Records update requests |
| 0045 | records_workflows | Records workflows + step approvals |
| 0046 | connector_processed_keys | Dedup table for the scheduled R2-prefix poller: (connector_id, r2_key) already dispatched |
| 0047 | connector_intake_credentials | Per-connector intake credentials |
| 0048 | drop_connector_type | Drop connectors.connector_type |
| 0049 | connector_runs_source | connector_runs.source |
| 0050 | connector_slug | Connector slugs (public drop paths) |
| 0051 | connector_r2_cf_token_id | Cloudflare token id for per-connector R2 buckets |
| 0052 | connector_run_retry_link | connector_runs.retry_of_run_id |
| 0053 | drop_connector_system_type | Drop connectors.system_type |
| 0054 | fts_search | Search v2 — FTS5 backbone (documents_fts + map + triggers) |
| 0055 | search_reindex_queue | Search v2 — async reindex queue |
| 0056 | fix_fts_view_nulls | Fix NULL-propagation hazards in documents_fts_source |
| 0057 | saved_searches | Search v2 — saved searches |
| 0058 | drop_extraction_evaluations | Drop the 0036 evaluations table |
| 0059 | staged_extraction_routing | Stage low-confidence connector extractions |
| 0060 | connector_extraction_corrections | Capture extraction corrections for learning |
| 0061 | connector_extraction_instructions | Per-connector natural-language extraction instructions |
| 0062 | processing_queue_confidence | Per-item LLM self-rated confidence + per-tenant auto_approve_threshold |
| 0063 | processing_queue_attempts | Track resets from `processing` back to queued |
| 0064 | product_suppliers | product_suppliers M2M provenance + backfill |
| 0065 | lots | `lots` table (tenant/supplier/product, lot_number, lot_key, dates) |
| 0066 | order_item_lot_linking | order_items.lot_id, coa_match_status, lot_match_suggestions. Every lot match is a suggestion |
| 0067 | queue_source_routing | Unified intake routing: output_kind, source_id, intake_mode (additive) |
| 0068 | extraction_profiles_and_internal_suppliers | Unify extraction profiles into supplier_extraction_instructions (+ field_mappings) |
| 0069 | document_types_supplier_scope | Reparent document types under suppliers (hybrid: NULL supplier_id = global) |
| 0070 | teach_sessions | Conversational "teach the model" sessions + messages |
| 0071 | assignments | Ownership of a (supplier, document_type) review queue |
| 0072 | tenant_extraction_context | Per-tenant editable extraction-prompt layer |
| 0073 | lots_sublot | COA sublot split (Option B): sub_lot_code on lots, composite identity |
| 0074 | documents_fts_lot | Lot search in documents_fts (lot_text column + triggers) |
| 0075 | supplier_lot_scheme_and_product_map | suppliers.lot_scheme enum + supplier_product_map (map RETIRED by 0113, DROPPED by 0124) |
| 0076 | document_categories | document_categories junction. RETIRED by 0080, but NOT dropped: still read/written (see 0131) |
| 0077 | registry_fields | Registry fields on documents: aliases, criteria, applies_to, owner, renewal_* |
| 0078 | product_attribution | brand_owner, producer, plant_code on products |
| 0079 | fts_registry | Registry fields in documents_fts (category/aliases/criteria/applies_to) |
| 0080 | registry_facets | requirements + document_requirements, claim_types + document_claims, claim_type_requirements |
| 0081 | documents_classification_status | documents.classification_status (+ reviewed_at/by) |
| 0082 | processing_queue_text_model | Which text model produced an extraction |
| 0083 | queue_rejection_reason | Reviewer rejection reason + note on processing_queue |
| 0084 | spec_limits | spec_tests (analyte + aliases) + spec_limits (thresholds; nullable scope, most specific wins) |
| 0085 | document_spec_checks | Out-of-spec register with a FROZEN limit_snapshot per judged result; stores not_checked too |
| 0086 | spec_limits_unique_scope | Unique (tenant, analyte, scope) on spec_limits via COALESCE expression index; values stay NULL |
| 0087 | supplier_requirements | Which requirements apply to which supplier, tier required/recommended. Keep supplier_id NOT NULL |
| 0088 | entity_notes | Generic notes on any record. APPEND-ONLY (no UPDATE path); delete is a soft retraction |
| 0089 | alert_links | Token-gated no-login landing pages for alerted owners; expiring, deliberately not single-use |
| 0090 | document_requests | Request composer: document_requests, request_lines, request_routing, templates. Amend = new version |
| 0091 | renewal_routing_and_alert_state | owner_routes (owner label -> recipients) + renewal_alert_state (the re-alert ledger) |
| 0092 | supplier_request_portal | Supplier portal: token door, request_uploads, request_upload_lines. An arrival is NOT a document |
| 0093 | tenant_spec_unit_equivalence | tenants.spec_volume_mass_equivalent (CFU/mL judged as CFU/g). DEFAULT OFF, never silent |
| 0094 | request_upload_queue_link | request_uploads.queue_id: portal arrivals are enqueued and read, still decided by a human |
| 0095 | spec_limit_criticality | spec_limits.criticality high/medium/low (default medium). Ranking only, never a verdict input |
| 0096 | document_type_renewal_period | document_types.renewal_interval_months (NULL = annual default; spec sheets backfilled to 36) |
| 0097 | renewal_policy_and_decision | document_types.renewal_policy inherit/period/none + documents.renewal_decision / _snapshot |
| 0098 | document_type_extraction_instructions | Per-document-type extraction instructions: the middle prompt layer; layers compose |
| 0099 | module_visibility | tenant_modules, owner_labels, module_visibility. Absence = unconstrained; inserts zero rows |
| 0100 | document_type_requirements | What a document TYPE normally closes (suggested links) + document_types.default_owner |
| 0101 | tenant_setup_runs | Setup wizard position per tenant (a position, not a configuration); one draft per tenant |
| 0102 | supplier_requirement_provenance | supplier_requirements.source + packet_slug. Nullable, no default: NULL is the audit worklist |
| 0103 | spec_check_provenance | document_spec_checks.judgement_origin (approval / bulk_recheck) + bulk_run_at; no default |
| 0104 | request_arrival_decisions | Per-claim decisions on request_upload_lines + request_lines.accepted_document_id |
| 0105 | spec_check_result_identity | document_spec_checks.result_key + result_location; partial UNIQUE blocks true duplicates |
| 0106 | lot_production_date | lots.production_date + raw/source/status provenance; document_versions.search_text; FTS view |
| 0107 | product_identifiers | product_identifiers: what our product goes by (SKU, supplier item/name, alias, GTIN, pack) |
| 0108 | intake_duplicates | intake_duplicates ledger for byte-identical arrivals + checksum indexes (extended by 0132) |
| 0109 | supplier_spec_watch | supplier_required_analytes, spec_limits.review_by, document_spec_gaps (missing / unjudged) |
| 0110 | supplier_lot_schemes | supplier_lot_schemes (append-only declared formats); lots REBUILT to add 'lot_decode' source |
| 0111 | renewal_alert_lead_time | renewal_alert_lead_days on tenants + document_types (NULL = inherit, 7-365, code default 60) |
| 0112 | supplier_list_derivation | supplier_list_imports + derivation columns / review_flag on supplier_requirements ('derived') |
| 0113 | product_identity_one_store | Copy supplier_product_map into product_identifiers (REBUILT); lot_match_suggestions.match_note |
| 0114 | spec_unmatched_ignores | Printed test names a tenant dismissed as not tests. Worklist only: the engine never reads it |
| 0115 | document_export_links | document_export_links: one token-gated send of search results (a link, never attachments) |
| 0116 | document_export_link_revocation | document_export_links.revoked_by: who pulled a sent link back (nullable, no backfill) |
| 0117 | queue_text_page_sources | processing_queue.text_page_sources: per-page text-layer / OCR provenance (NULL = nothing unusual) |
| 0118 | packet_split | Packet proposal, split/dismiss decision and child-part columns on processing_queue |
| 0119 | request_one_document_per_file | one_document_per_file flag on request_lines + request_template_lines (DEFAULT 0, per line) |
| 0120 | spec_test_category | spec_tests.category + regulatory ceiling config. Read only by specBand, after judging |
| 0121 | document_arrived_at | documents.arrived_at (queue item created_at, stamped at approval); nullable, no backfill |
| 0122 | document_search_keys | document_search_keys (seekable identifiers / dates), reindex triggers, document scope indexes |
| 0123 | requirement_scope | requirements.scope (no CHECK), product_requirements, product_suppliers source/discontinued columns |
| 0124 | drop_supplier_product_map | DROP supplier_product_map. Destructive: bin/migrate-prod-one --allow-destructive after bin/backup |
| 0125 | document_type_renewal_window | document_types.renewal_window JSON: fixed calendar window, refines the 'period' policy |
| 0126 | document_version_packet_source | document_versions.source_packet_queue_id + frozen source_packet citation |
| 0130 | document_provenance | documents.approved_at / intake_source / origin_queue_id; backfilled only where provable |
| 0131 | fts_registry_rebuild | documents_fts_source rebuilt on requirements + product identifiers. Use bin/migrate-prod-one |
| 0132 | duplicate_decisions | intake_duplicates gains match_basis / disposition / decision columns: a person decides |
| 0133 | supplier_renewal_send | supplier_contacts, tenants.default_owner_user_id (master user), renewal_requests (cycle) + renewal_request_sends (stage): drafted, sent only on one approval |
| 0134 | order_fulfillment_sends | orders.ship_date / created_by, order_items.picked_by / picked_at, order_sends + order_send_files, document_export_links.never_expires |
| 0135 | item_approval_facilities_customers | supplier_facilities, product_suppliers.approval_* + facility_id (existing pairs backfilled approved / initial; legacy-only links materialised), customer_contacts.coa_recipient, customer_item_requirements |
| 0136 | pin_default_extraction_context | Data only: writes the former built-in dairy extraction context into tenants.extraction_context where NULL or ''. Apply BEFORE the code deploys |
| 0137 | sharing_rule | document_types.sharing_rule (free / qa / locked, NULL = read from the name) + documents.sharing_rule_override / _by / _at / _reason. Additive, nullable, no backfill |
| 0138 | order_documents | order_documents (document lines of an order: item, supplier, type, resolved document, release state), order_sends.kind, order_send_files.order_document_ids / link_days / not_sent_reason. Additive. `supplier_id` has no ON DELETE action: `mergeSuppliers` moves the lines |
| 0139 | document_holds | document_holds (append-only; lot row or whole certificate; person / spec_critical / zero_tolerance), document_hold_failures (a hold that should have been placed and was not), document_versions.source_queue_id (the queue item that wrote each version; backfilled where provable). Holds nothing by itself. Apply BEFORE the code deploys |

## Role Model (4 roles)

| Role | Scope | Key Permissions |
|------|-------|----------------|
| super_admin | All tenants | Full access, manage tenants and all users |
| org_admin | Own tenant | Manage users (user/reader), documents, view audit |
| user | Own tenant | Create/upload/update/delete documents |
| reader | Own tenant | Read-only, download files |

## Commands

- Install: `npm install`
- Build: `npm run build` (TypeScript + Vite) — builds `tsconfig.app.json` ONLY
- Typecheck the Functions project: `npm run typecheck:functions` (ratchet, see below)
  - ⚠️ `npx tsc --noEmit` at the root is a **no-op** (`files: []` + project references).
    `npm run build` never typechecks `functions/`. `bin/typecheck-ratchet` runs
    `tsc -p tsconfig.functions.json --noEmit` and compares against
    `tests/typecheck-baseline.json` (**27** pre-existing errors): it fails when the
    count rises or a previously clean file gains one, never on the backlog. Bank a
    fix with `bin/typecheck-ratchet --update`. Wired into `.github/workflows/test.yml`
    and `bin/e2e` (so `bin/deploy` gates on it).
- Dev server: `npm run dev` (wrangler pages dev on port 8788 with local D1 + R2)
- Frontend dev: `npm run dev:frontend` (Vite HMR only)
- Migrations: `npm run migrate` or `./bin/migrate`
- Remote migrations: `npm run migrate:remote`
- Seed admin: `./bin/seed`
- Deploy: `./bin/deploy`
- Deploy the renewal cron Worker: `./bin/deploy-renewal-alerts` (`--staging`, `--dry-run`) — separate artifact, needs `RENEWAL_ALERT_TOKEN` on BOTH the Worker and the Pages project

## Environment Variables (.dev.vars)

```
JWT_SECRET=your-secret-here
RESEND_API_KEY=re_xxxx  # Optional, enables email notifications
CONNECTOR_POLL_TOKEN=...  # Bearer for /api/sources/poll (dox-connector-poller Worker)
RENEWAL_ALERT_TOKEN=...   # Bearer for /api/expirations/run-scheduled (dox-renewal-alerts Worker).
                          # Must MATCH the Worker's secret and DIFFER from CONNECTOR_POLL_TOKEN —
                          # one dispatches ingest runs, the other sends mail to customers' customers.
```

## Wrangler Bindings (wrangler.toml)

- `DB` — D1 database binding (`doc-upload-db`)
- `FILES` — R2 bucket binding (`doc-upload-files`)

## Code Style

- Language: TypeScript
- Use functional patterns where possible
- Keep functions small and focused
- Prefer explicit types over `any`

## Workflow

Use the slash commands for common tasks:
- `/up` — Start dev server
- `/down` — Stop services
- `/test` — Run test suite
- `/todo` — Capture a task
- `/plan` — Plan implementation from todo
- `/work` — Implement planned items

## Tracking Files

| File | Purpose |
|------|---------|
| `todo.md` | Quick capture for ideas and tasks. Items are raw, unplanned. |
| `plan.md` | Detailed implementation plans with status, design, file lists, and steps. |
| `FEATURES.md` | Index of release notes — see `releases/v*.md` for per-version detail. |
| `releases/` | Per-version release notes (markdown + YAML frontmatter). Mirrored to `public/releases/` so they're served as static assets and rendered in the in-app release notes modal. |
| `backlog.md` | Deferred ideas, long-term research, and items not in the daily workflow. |
| `next-time.md` | User's notes/thoughts for the next session. Read on startup, address first. |
| `docs/decision-log.md` | Decisions Chris has made that the build follows (`C-0xx` rows), with status and where each lands. Check it before asking the client a question; add a row, never rewrite one. |

**Flow:** `todo.md` (idea) -> `plan.md` (planned -> in-progress -> done) -> `releases/vX.Y.Z.md` (shipped, via `bin/release`)
**Deferred:** Items moved from `todo.md` to `backlog.md` when not prioritized.

When committing (`/commit`), update tracking files:
1. Remove completed items from `todo.md`
2. Set status to `done` in `plan.md`

When cutting a release, use `bin/release` (NOT a hand-edited
`FEATURES.md` entry):
- `bin/release` (default `--patch`, also `--minor` / `--major` /
  `--dry-run`) drafts notes from `git log $LAST_TAG..HEAD`, opens them
  in `$EDITOR` for polish, bumps `package.json`, commits, tags
  `vX.Y.Z`, and prompts to deploy.
- The script auto-updates `releases/vX.Y.Z.md`,
  `public/releases/vX.Y.Z.md`, `public/releases/index.json`, and the
  `FEATURES.md` index. The footer chip + What's-new toast pick up the
  new version on next page load.

### Every bullet says WHO IT REACHES (mandatory)

AJ Conner, reviewing v2.7.0-v2.20.0: *"Mark in each release which changes reach
existing tenants and which only land on new ones. The GFSI change is right ...
but it applies to newly set-up orgs only, so our config keeps the old rule.
That is the first product default to drift from our tenant and it will not be
the last."* Three kinds of change ship under one heading and read identically —
and a reader who cannot tell them apart either waits for something that never
arrives or believes their configuration matches a default it has quietly
diverged from. So each bullet opens with one token:

| token | means |
|---|---|
| `[existing]` | **Reaches every organisation now.** Live on deploy; nobody does anything. |
| `[new-orgs]` | **New organisations only.** A changed default applied at setup; existing configuration is NOT rewritten and will no longer match. |
| `[config]` | **Needs configuration.** Shipped but inert until an admin sets it up. |

    - [existing] **Every result now shows one of five states:** ...
    - [config]   **A supplier can be put on watch.** ...
    - [new-orgs] **The GFSI claim now requires the audit certificate** ...

A token on a paragraph of its own claims the whole section under it.
Vocabulary + matcher: **`shared/releaseReach.ts`**, one place — the in-app
renderer (`src/components/ReleaseNotesModal.tsx`) imports the source and turns
each token into a chip with a tooltip; `bin/release` reads the esbuild mirror
(`bin/lib/shared/releaseReach.js`, so re-run `npm run build:worker-shared`
after editing it) and **refuses to cut a release whose notes carry no marker** —
prompting [e]dit / [c]ontinue / [a]bort interactively, failing with the
explanation when stdin is not a tty. The bar is one marker anywhere, on
purpose: a script arguing with prose a human is still writing gets a skip flag
added to it. An unmarked bullet still renders exactly as before, which is what
made it safe to adopt on notes written earlier. v2.8.0-v2.20.0 were classified
retroactively by `bin/lib/backfill-release-reach.js` (idempotent, `--check`);
`tests/unit/releaseReach.test.ts` pins that every release from v2.8.0 answers
the question in BOTH the authored file and the public mirror the app fetches.

## Task Management

Use `TaskCreate` for concrete work items to track progress:
- Create tasks with clear, actionable subjects
- Set tasks to `in_progress` when starting, `completed` when done
- Use task dependencies (`blocks`/`blockedBy`) for ordering

## Interaction

When you need user input, prefer `AskUserQuestion` with clear options over open-ended questions. This renders a native chooser in the companion app rather than a wall of text.
