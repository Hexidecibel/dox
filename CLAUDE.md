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
migrations/             # D1 SQL migration files (0001-0016)
bin/                    # Operational scripts (deploy, migrate, seed)
```

## API Documentation

- **`openapi.yaml`** — Complete OpenAPI 3.1 spec for all REST endpoints
- **`API.md`** — Human-readable implementation guide with examples

## Key Features

- **API Keys**: Programmatic access via `X-API-Key` header (`dox_sk_` prefix). Created/revoked by admins. Keys auth as the creating user.
- **Document Ingestion**: `POST /api/documents/ingest` — upsert by `external_ref` + `tenant_id`. Creates new doc or adds version. Designed for agentic/email pipelines. Supports `source_metadata` (JSON).
- **Document Lookup**: `GET /api/documents/lookup?external_ref=X&tenant_id=Y` — find document by external reference.
- **Password Management**: Forgot password (self-service email flow), admin reset (generates temp password, sets `force_password_change`), force change on next login.
- **Document Preview**: Inline preview for PDF (iframe), images (img tag), text/CSV (rendered inline). Office docs show download card.
- **File Name Search**: `GET /api/documents/search` now also matches against `file_name` in document_versions (joined).
- **Products**: Global product catalog shared across tenants. Tenant-product associations track which suppliers provide which products.
- **Document Types**: Per-tenant document type definitions (COA, Spec Sheet, SDS, etc.) replacing freeform categories.
- **Document-Type Classification (its own pass, before extraction)**: `classifyDocumentType` in `functions/lib/llm.ts` (mirrored in `bin/process-worker`) reads the first 3000 characters against the tenant's **own** `document_types` catalog and picks one name **verbatim**, or answers `none`. It runs BEFORE extraction, on the `fast` chain, so the 0098 document-type instruction layer — which is keyed on the type — applies to the first and only full extraction instead of needing a re-extract. The answer is validated by EXACT (normalized) name/slug match only: a near miss is left unresolved and recorded in `processing_queue.document_type_guess` for a human, never fuzzed onto the nearest type, because a confident wrong type silently selects the wrong instruction block forever. A type an intake door already declared is trusted and never re-classified. Measured on `tests/fixtures/doctype-corpus`: 19/40 → 38/40, ~2.6 s per document.
- **Structured Metadata**: Flexible JSON metadata on documents via `primary_metadata` and `extended_metadata` columns. Old hardcoded fields (lot_number, po_number, code_date, expiration_date) remain in DB but are unused.
- **Suppliers**: First-class supplier entity per tenant. Documents link to suppliers via `supplier_id`. Lookup-or-create endpoint for fuzzy matching.
- **Document-Product Linking**: Many-to-many links between documents and products with per-link expiration dates and notes. Ingest API accepts `product_ids`.
- **Naming Templates**: Per-tenant file naming templates with generic placeholders (any metadata key like `{lot_number}`, `{supplier}`, `{doc_type}`, etc.) applied during ingest.
- **Email Ingest**: `POST /api/webhooks/email-ingest` for Mailgun/SendGrid inbound parse. Maps sender domain to tenant, extracts attachments.
- **Expiration Dashboard**: Dashboard showing documents approaching expiration with summary cards, configurable look-ahead, and email alerts.
- **Scheduled Renewal Alerts (per-owner)**: Renewal is the frequent use case, so it does not wait for a human to press a button. The `dox-renewal-alerts` companion Worker (`workers/renewal-alerts/`, deploy with `bin/deploy-renewal-alerts`) fires `POST /api/expirations/run-scheduled` daily at 13:00 UTC — Pages cannot host a cron, same reason `dox-connector-poller` exists. Alerts are **grouped by the record's owner**: `documents.owner` resolves through `owner_routes` (migration 0091, managed via `/api/owner-routes`) and each owner gets a digest of only their records, with a token-gated `/alert/<token>` link that needs no login. The routing ladder is `functions/lib/alert-routing.ts` and is shared with the spec path. **The two paths differ by one deliberate flag**: spec alerts pass `adminFallback: true` (a one-shot food-safety event should reach someone), renewals pass `false` (a recurring job that falls back to the admin pool trains everyone to ignore it). **A record with no resolvable owner is never silently re-broadcast** — it produces a routing-gap notice, an `expirations.routing_gap` audit row, and an `unrouted` block in the API response. Re-alert suppression (`renewal_alert_state`): first sight, escalation, or a 7-day cooldown. Engine: `functions/lib/renewal-alerts.ts`, shared verbatim with the manual `POST /api/expirations/notify` button.
- **Renewal Periods + the Approval-Time Decision**: WHEN a document is next due, resolved in exactly one place — `resolveRenewalExpiry` in `shared/renewalPeriod.ts`. The SME's rules (AJ Conner, 2026-09-02) are regulatory definitions, not preferences: annual by default (~90% of a supplier file), three years for a specification sheet (both major food-safety schemes define a current spec sheet that way), and everything else one year *or whatever the document itself states*. **`document_expires_on` is that last clause, and it is NOT `expiration_date`** — the latter is the PRODUCT's shelf life (139 of 200 prod documents carry one and all 139 are COAs, so reading it as a renewal date would have mailed every COA owner about a certificate that does not renew). Extraction asks for `document_expires_on` only on types where a document genuinely expires — insurance, certifications, audit certificates — and the prompt (three mirrored copies: `functions/lib/llm.ts` BASE_PROMPT plus the text and VLM prompts in `bin/process-worker`) forbids copying a COA's shelf life into it. **A COA resolves to `no_renewal_period` as a property of its TYPE**, not a string match at read time: `document_types.renewal_policy` (migration 0097). **Approval is where it is settled** — `resolveRenewalExpiry` is a PROPOSAL shown pre-filled and editable in the Review Queue with its `rule` in plain words, and what the reviewer confirms is written to the document with a frozen `renewal_snapshot` (`functions/lib/renewal-proposal.ts`), the same discipline as `limit_snapshot`. A cleared field means "does not renew" and is distinguishable from nobody having looked; every decision writes a `document.renewal_decided` audit row.
- **Document Bundles**: Named compliance packages grouping documents with version pinning. Download as ZIP. Draft/finalized workflow.
- **Extraction Prompt Stack (three layers)**: `tenant extraction_context` (0072) -> **document-type instructions (0098)** -> `(supplier, document_type)` instructions (0035/0068), resolved most-specific-wins by `functions/lib/extractionInstructionStack.ts`. The middle layer is what makes a mixed corpus tractable: "how to read a Certificate of Insurance" is written ONCE and applies to every supplier, including one nobody has configured, instead of once per (supplier, type) pair. **The two authored layers COMPOSE — a supplier instruction refines the type instruction, it does not replace it** (only the tenant layer is a whole-block replacement, because that layer is a template). The composed text ships as `effective_instructions`; `instructions` stays the supplier row alone so the reviewer's autosaving editor cannot write shared text into one supplier. The worker resolves BOTH keys late — the document type is promoted only after extraction, so the type layer is usually picked up in the two-pass re-extract, on an EXACT doctype match only. Guidance never outranks the extraction rules and never licenses an invented unit (rule 14); that guard is in the block header on both prompt surfaces and is pinned by a mirror test. Edited on Document Types (type layer) and Supplier › Extraction Instructions / the Review Queue box (supplier layer), each showing the other.
- **Lot-Row Retrieval (Any-Field COA Retrieval, Phase 2)**: coverage search (`shared/searchCoverage.ts`, retrieval `functions/lib/search-coverage.ts`) judges a document ONE LOT ROW AT A TIME and returns `matched_lot` ("Lot 10426203 · sublot 03 · produced Jul 22, 2026"), so one row's lot never pairs with another row's date. Production-date and lot constraints also seek `lots` by index (migration 0106), not only the capped document scan. A lot matches as `1042620303`, `10426203-03`, `10426203 03`, or two inputs (`/api/search?lot=&sublot=`, the Search page's Lot / sublot button) — two inputs match part against part (R2). A production date read from an older extraction's code date is `likely_covering` / coverage `likely` ("confirm"), never covering. Split certificates are searched on `document_versions.search_text` (other rows blanked). Review-time validator: `sublot_production_date_conflict` + row production date after the header's expiry (`shared/extractionInvariants.ts`). No lot-code (Julian) decoding — that is Phase 4's declared per-supplier scheme.
- **Products by Any Name + Orders (Any-Field COA Retrieval, Phase 3)**: the product identifier graph (`product_identifiers`, migration 0107) says what each of OUR products goes by — our SKU, the supplier's item number(s) (a former one flagged `superseded`), supplier product names, aliases, GTIN, pack — each row with `source`, `confirmed` and its evidence in `note`. Managed on Admin › Products › product page (`/api/products/:id/identifiers`, `/api/product-identifiers/:id`, every add/confirm/remove audited); seeded from evidence by `bin/seed-product-identifiers` (dry run default; 310348 only with `--include-pending`, unconfirmed; 08012 = 0801 is never asserted). Pack/attribute vocabulary is code-owned in `shared/productVocabulary.ts` (U/S = NS = unsalted; 5 GL BAG = 5 gallon bag; 300GL = 300 gal tote; HG = half gallon; 55.115 lb = 25 kg only by a conversion that is SAID; a lone `S` is not salted; lower-case `g` is grams). `shared/productIdentity.ts` resolves a phrase (`2235`, `810004`, `300 gal tote`, `bulk unsalted butter`) to candidate products — every word must be accounted for — and judges a document on its own `customer_item_number`, supplier item, or name + pack. **A phrase that fits several products is `coverage: ambiguous`: nothing is picked, and each candidate carries its own `covering_count`.** A code or pack is a constraint on its own; words alone apply only next to another constraint ("butter" stays a browse). Anything reached through an unconfirmed identifier is `likely` ("confirm"). NL: the parser returns `product_text` verbatim, and the question's own words are tried when it does not resolve (`applyNaturalProductAndOrder`). **A7**: a WMS order number becomes an `order` constraint (`shared/orderCoverage.ts`) that follows order_items -> lots -> documents; covering only via a person-accepted `lot_match_suggestions` row or an exact lot row; pending suggestions and pre-suggest-only auto-links are `likely`. Extraction: `customer_item_number` (CMF "CUSTOMER ITEM #", previously filed as order_number) in all three prompt copies, pinned by `tests/unit/customerItemNumberField.test.ts`.
- **Spec Limits + Out-of-Parameter Warnings**: Acceptance limits on COA test results (`spec_tests` + `spec_limits`, migration 0084). Two sources judge every result — the COA's own printed spec/pass-fail (no configuration, works on every supplier) and OUR configured limit, which is often tighter than what the supplier certifies against. **Three-state by design**: `in_spec` / `out_of_spec` / `not_checked`, where `not_checked` means we held a limit and could not honestly apply it (a censored `<50` against a ≤10 limit, a CFU/mL result against a CFU/g limit) and is never a silent pass. Engine is `shared/specCheck.ts` (pure); review-queue surfacing via `functions/lib/spec-warnings.ts`; register + alerts via `functions/lib/spec-register.ts` (one email per document; routing now delegates to the shared ladder in `functions/lib/alert-routing.ts` — owner route, then `assignments`, then org_admins, with the admin fallback passed in explicitly as `adminFallback: true` because a one-shot safety event reaching nobody is worse than a redundant email). Warns, never blocks. Preview what a limit would catch with `bin/recheck-spec-limits --tenant <id>`. **Criticality (migration 0095)** ranks each limit — `high`/`medium`/`low`, default `medium`, vocabulary owned solely by `shared/specCriticality.ts` and still provisional. It orders and colours the admin list, the review-queue banner/chip/row markers and the alert email, and is frozen into the snapshot; it changes no verdict and hides no result. **Unit equivalence (migration 0093)** is the one per-tenant setting that changes a verdict: off by default, it lets CFU/mL be judged against a CFU/g limit for fluid tenants, names itself in every reason it produces, and is set on Settings › Spec Limits.
- **Request Composer**: Compose a document request against one supplier, issue it, and amend it without destroying what was originally sent (migration 0090). A line SHOULD resolve to a `requirement_id` so the arriving document is a registry object the gap engine can count; free text is supported as an escape hatch but must be declared (`line_kind: "free_text"`) and is counted separately on every response. Per-line status is the client's five: `not_started | received | under_review | accepted | needs_attention`, with no transition graph imposed. Amendments after issue create a NEW version (`root_request_id` + `version`, previous row stamped `superseded_at` and otherwise frozen); re-issue starts a new root for renewals and new items under an approved vendor. One issue path (`issueRequest` in `functions/lib/document-requests.ts`) writes one internal `request_routing` row and one audit row regardless of what filled the draft — a future generator drafts, a human issues. The external projection is an allow-list (`buildSupplierRequestView`), same discipline as `buildAlertLandingView`. `closure` stays read-only: a typed line surfaces the confirmed `document_requirements` links from that supplier and does not move `status`. **Arrivals (migration 0104)**: what a supplier sends through their link is reviewed at `/requests/arrivals` (and "What came back" on each request) via `/api/request-uploads`. A person decides per claim (`request_upload_lines`): **accept requires the file to be approved in the Review Queue first** (409 otherwise). Queue approval judges the extraction, accept judges "satisfies what we asked", and the two stay separate judgements. **They can be ONE action**: for a `request_link` item the Review Queue card offers the claims pre-ticked plus an explicit accept / send back / decide later choice (Approve waits for it), sent as `arrival_decision` on PUT /api/queue/:id (reject + send back too). Doc-independent checks run before the approval; if the decide half still fails afterwards the response is 200 with `arrival_decision.applied: false`, the approval stands and the arrival stays pending. Audit rows carry `via: 'review_queue_combined'`. Accept names the document on `request_lines.accepted_document_id` and confirms the registry link (`source='request_accept'`), and it never overrides a human `rejected` link. Needs-attention works at any stage, and the supplier reads `attention_reason`, never `status_note`. Claims map onto the current version by line identity. Logic: `functions/lib/request-arrivals.ts`.

## Migrations (0001-0107)

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
| 0023 | processing_status | processing_status on processing_queue (async AI state, separate from review status) — **NOTE: duplicate 0023 number, see warning above** |
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
| 0046 | connector_processed_keys | Dedup table for the scheduled R2-prefix poller (file_watch Phase 2). Tracks (connector_id, r2_key) pairs already dispatched. |
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
| 0066 | order_item_lot_linking | order_items.lot_id + coa_match_status/coa_matched_at + lot_match_suggestions. **Since 14 Sep 2026 every lot match is a suggestion** (`functions/lib/entities/matching.ts`): the engine never writes `coa_document_id`/`matched`, however strong the basis; only accepting a suggestion (POST /api/lot-matches/:id, one click on OrderDetail / lot panel / shipment tile) links. Pre-change auto-links are left as history; `bin/audit-asserted-lot-matches` reports them (opt-in `--apply` re-offers them) |
| 0067 | queue_source_routing | Unified intake routing: output_kind, source_id, intake_mode (additive) |
| 0068 | extraction_profiles_and_internal_suppliers | Unify extraction profiles into supplier_extraction_instructions (+ field_mappings) |
| 0069 | document_types_supplier_scope | Reparent document types under suppliers (hybrid: NULL supplier_id = global) |
| 0070 | teach_sessions | Conversational "teach the model" sessions + messages |
| 0071 | assignments | Ownership of a (supplier, document_type) review queue |
| 0072 | tenant_extraction_context | Per-tenant editable extraction-prompt layer |
| 0073 | lots_sublot | COA sublot split (Option B): sub_lot_code on lots, composite identity |
| 0074 | documents_fts_lot | Lot search in documents_fts (lot_text column + triggers) |
| 0075 | supplier_lot_scheme_and_product_map | Per-supplier lot_scheme + supplier_product_map bridge |
| 0076 | document_categories | Multi-category junction (document → document_types, is_primary flag). **RETIRED by 0080** — superseded by `document_requirements`; physical DROP deferred to the P3 FTS rebuild because 0079's `documents_fts_source` view reads it |
| 0077 | registry_fields | Registry fields on documents: aliases, criteria, applies_to, owner, renewal_* |
| 0078 | product_attribution | brand_owner, producer, plant_code on products |
| 0079 | fts_registry | Registry fields in documents_fts (category/aliases/criteria/applies_to) |
| 0080 | registry_facets | Registry taxonomy P1: `requirements` + `document_requirements` (layer 2, what a doc SATISFIES), `claim_types` + `document_claims` (layer 3, what a doc TRIGGERS), `claim_type_requirements` (claim → what proves it). All per-tenant rows |
| 0081 | documents_classification_status | `documents.classification_status` (unclassified / needs_review / classified / unclassifiable) + reviewed_at/by |
| 0082 | processing_queue_text_model | Which text model produced an extraction |
| 0083 | queue_rejection_reason | Reviewer rejection reason + note on processing_queue |
| 0084 | spec_limits | `spec_tests` (analyte + the aliases suppliers print) and `spec_limits` (our acceptance thresholds). Scope columns are all nullable; most specific wins, all-NULL is a tenant-wide default |
| 0085 | document_spec_checks | The out-of-spec register. One row per judged result with a FROZEN `limit_snapshot`, so moving a threshold cannot rewrite history. Stores `not_checked` too — a register of passes and failures only would imply everything absent from it was fine |
| 0086 | spec_limits_unique_scope | Unique index on (tenant, analyte, scope) for `spec_limits`. **Expression index** — the three scope columns are COALESCEd to `''` in the key because SQLite treats NULLs as distinct, which would exempt every all-NULL tenant-wide row. Stored values stay NULL; `resolveSpecLimits` and the LEFT JOINs depend on that |
| 0087 | supplier_requirements | Applicability: WHICH requirements apply to WHICH supplier, with a `tier` of `required` / `recommended` (gap reports default to `required`). The LEFT side of gap detection — `document_requirements` says what a supplier's docs CLOSE, this says what they were supposed to close. Plain `UNIQUE(tenant_id, supplier_id, requirement_id)`, no expression index needed: all three key columns are NOT NULL, so 0086's NULL-distinctness trap cannot bite. Do NOT make `supplier_id` nullable to express a tenant-wide default — that reintroduces it |
| 0088 | entity_notes | Generic in-system notes: `entity_notes` (tenant_id, entity_type, entity_id, body, author_id, created_at) — one facility for every record type, not a notes column per table. **APPEND-ONLY: there is no UPDATE path for `body` and no PUT endpoint.** A note that can be silently rewritten is worth less than no note on a compliance record; a correction is a new note. DELETE is a soft RETRACTION (`deleted_at`/`deleted_by`), hidden from the default read and still visible to admins via `include_deleted=1`. `entity_type` is CHECK-constrained ('supplier','document','requirement','supplier_requirement'); the narrower, precise gate is `functions/lib/notes.ts`, which requires a tenant-scoped existence resolver per type — `entity_id` is polymorphic and cannot be a foreign key, so that check IS the tenant isolation. Distinct from `documents.description` (one overwritable field, left alone) and from `records_comments` (0040, stays scoped to records rows) |
| 0089 | alert_links | Token-gated landing pages for the **alerted owner** — a recipient who is NOT a portal user, gets an email, and must act. 32-byte base64url token (same entropy as `/a/` and `/u/`), `expires_at` NOT NULL (30d default), `revoked_at` kill switch. **Not single-use, deliberately**: the recipient opens it on a phone, again at a desk, and forwards it to whoever does the work; duration is handled by expiry, abuse by rate limiting + an `alert_link.view` audit row. Scoped to one alert EVENT (`document_id` for spec alerts, `subject_ids` JSON for renewal digests) so a forwarded link can never widen to cover documents that were not in the email it came from. Response is an explicit allow-list in `functions/lib/alert-links.ts` — our configured spec limits never appear, only the certificate's own printed limit
| 0090 | document_requests | **The request composer** — the primitive the client says every checklist source feeds into. Five tables: `document_requests` (one VERSION of one ask to one supplier), `request_lines`, `request_routing` (the internal issue record), `request_templates` + `request_template_lines`. **A line SHOULD resolve to a `requirement_id`**: `line_kind` defaults to `'requirement'` and a paired CHECK makes free text a deliberate declaration, never an inferred one — an untyped ask produces a document the registry cannot reason about. **Amendment after issue is a NEW VERSION, never an overwrite**: same `root_request_id`, `version + 1`, `supersedes_id` back-pointer, and `superseded_at` stamped on the old row, which is otherwise never touched (its `status` stays `issued`, because it was). Distinct from RE-ISSUE (a renewal / a new item under an approved vendor), which starts a NEW root at version 1 with `reissue_of_request_id` as provenance. **One issue path** — `issueRequest()` in `functions/lib/document-requests.ts` — one routing row (UNIQUE on `request_id`), one audit row, a human actor required (`request_routing.issued_by` NOT NULL), whatever `origin` filled the draft. Routing is its own table so the external projection (`buildSupplierRequestView`, an allow-list in the `buildAlertLandingView` mould) cannot reach it even by accident. Templates are their own table pair, NOT an `is_template` flag — a flag would force `supplier_id` nullable and put `AND is_template = 0` in every query forever. Uniqueness uses PARTIAL indexes (a third answer after 0086's COALESCE and 0087's plain UNIQUE): `(request_id, requirement_id) WHERE requirement_id IS NOT NULL` and `(root_request_id) WHERE superseded_at IS NULL` |
| 0091 | renewal_routing_and_alert_state | **Who hears about a renewal, and how often.** Two tables. `owner_routes` maps a tenant's free-text `documents.owner` label ('QA', 'Insurance', 'Accounting', 'Purchasing') to real recipients, matched on a normalized `owner_key` (lower-cased, whitespace-collapsed — normalization lives in `functions/lib/alert-routing.ts`, there is no SQL collation trick). A route points at EITHER a portal user OR a bare email (CHECK enforces exactly one): the owners are ROLES that change hands, and some of them — a broker, a site manager — will never have an account, which is why `owner` was NOT converted into a user FK. Several rows may share one label. Unique index is `(tenant_id, owner_key, COALESCE(user_id, email))` — a fourth answer to the NULL-distinctness trap after 0086/0087/0090. `renewal_alert_state` is the re-alert ledger, one row per document: a daily job that mails the same certificate every morning for sixty days is worse than no job, so a record re-sends only on first sight, on ESCALATION (expiring → overdue/expired, which ignores the cooldown), or after a 7-day cooldown. **Two stamps on purpose**: `last_notified_at` is wall clock (forensics), `last_notified_as_of` is the run's `as_of` date and is what the cooldown measures against — mixing them makes a backdated re-run compute negative elapsed time and go silent forever. **A record with no resolvable owner is NOT re-broadcast to the admin pool**; it produces a separately-worded routing-gap notice plus an `expirations.routing_gap` audit row |
| 0092 | supplier_request_portal | **The supplier's side of the ask.** Three tables: the token-gated door (scoped to a request ROOT, not a version, so an amendment does not kill a link already sent), `request_uploads` (what came through it) and `request_upload_lines` (which lines each arrival was claimed against — many-to-many, one COA can cover two lines). **An arrival is NOT a document**: nothing auto-ingests, a line moves only to `received`, and a supplier can never move the accepted count |
| 0093 | tenant_spec_unit_equivalence | **The one spec setting that changes an answer rather than adding a rule.** `tenants.spec_volume_mass_equivalent` (INTEGER NOT NULL DEFAULT 0) lets a tenant declare that CFU/mL and CFU/g are the same number for its products, so a fluid-dairy COA printing `cfu/mL` is judged against a CFU/g limit instead of coming back `not_checked`. On prod 370 results printed `cfu/mL` against 265 `cfu/g` while every limit was written per gram, so the majority unit matched nothing. **DEFAULT OFF and it must stay that way** — for a powder the two bases are genuinely different quantities. **NARROW BY DESIGN**: only volume-vs-mass WITHIN one enumeration method; percent-vs-CFU and CFU-vs-MPN stay refused (the percent refusal caught a real extraction bug). **NEVER SILENT**: every verdict it makes reachable carries `unit_equivalence_applied` and says "CFU/mL judged as CFU/g, per this tenant's setting" in its reason AND its reviewer message, and `document_spec_checks.limit_snapshot` freezes `unit_equivalence: 'volume_mass'` so a verdict stays re-explainable after someone turns it back off. Engine is `UnitPolicy` / `resolveUnits` in `shared/specCheck.ts`, threaded explicitly (never module state) through `loadSpecConfig`; `spec_unit_policy_updated_at`/`_by` stamp the change, and `/api/spec-unit-policy` (super_admin + org_admin) audit-logs it |
| 0094 | request_upload_queue_link | `request_uploads.queue_id` — the join that lets a supplier-portal arrival be READ on arrival without being DECIDED on arrival. 0092's rule ("an arrival is NOT a document", nothing auto-ingests, a supplier can never move the progress number) had been implemented as "do not even open the file", so the newest and most visible intake door was the one door that skipped extraction, per-supplier extraction instructions and spec checking. The upload route now enqueues through the shared `functions/lib/intake/enqueue.ts` with `source='request_link'`, `supplier_id` from the link and `created_by=NULL`; lines still go to `received` only and `document_id` still stays NULL until a human approves. Nullable FK, ON DELETE SET NULL, partial index on the non-NULL side. A NULL `queue_id` on a post-0094 upload is the exact worklist for a re-enqueue sweep (a failed enqueue never fails the upload; it audits `request_link.enqueue_failed`) |
| 0095 | spec_limit_criticality | `spec_limits.criticality` ('high'/'medium'/'low', NOT NULL DEFAULT 'medium'). **Ranking, never a verdict input** — food companies write specs tighter than they can consistently hit batch to batch to satisfy nutrition-panel claims, so most parameters are TRACKED rather than acted on and a flat screen of them trains the reviewer to ignore all of them. **DEFAULT IS THE MIDDLE TIER on purpose**: defaulting to the top one recreates the flat screen in a new costume, defaulting to the bottom silently demotes limits somebody wrote deliberately. Distinct from `severity`, which routes the notification rather than ranking the finding — and the reason the vocabulary is high/medium/low rather than essential/warn/ignore, since `severity` already stores the literal 'warn' on the same row. **THE WORDS ARE NOT FINAL** (AJ has not chosen); they live in exactly one place, `shared/specCriticality.ts`, so renaming is that file plus a new migration restating the CHECK. Frozen into `document_spec_checks.limit_snapshot` alongside the thresholds: a rank is re-tuned like a threshold, and a register that re-labelled old rows to today's ranking would answer a different question than the one asked
| 0096 | document_type_renewal_period | `document_types.renewal_interval_months` — how long a document of this TYPE is good for. Nullable, where NULL means "the annual default applies": a stored value is there because it DIFFERS from the default, and stamping 12 onto every row would make "annual because nobody said" indistinguishable from "annual because a QA manager decided". Spec sheets backfill to 36 (both major food-safety schemes define a current spec sheet as one revised or reviewed inside three years). Backfill is a NAME MATCH mirrored from `looksLikeSpecSheetType`, run once here and once at type creation, never at read time |
| 0097 | renewal_policy_and_decision | **Does a document renew AT ALL, and what did the human say?** `document_types.renewal_policy` ('inherit' / 'period' / 'none', NOT NULL DEFAULT 'inherit') is the THIRD STATE 0096's nullable months column could not express: a Certificate of Analysis does not renew, being superseded by the next lot's certificate rather than re-collected on a cadence. **One word, not a sentinel** — `renewal_interval_months = 0` is a magic number the resolver already (correctly) rejects as corrupt, and a separate `renews` boolean is two columns that can disagree; the policy is the authority and the months column is read ONLY under 'period', so the pair cannot contradict itself. COA backfill is a name match mirrored from `looksLikeCoaType`, NARROW on purpose (it requires the *analysis* word, so 'Certificate of Insurance' cannot match — a false positive here produces SILENCE, a certificate that lapses and never appears). The other half is on `documents`: `renewal_decision` ('accepted'/'overridden'/'cleared') + `renewal_snapshot` + `renewal_decided_at`/`_by`, written at APPROVAL. **`renewal_snapshot` freezes the proposal exactly as `limit_snapshot` (0085) freezes a threshold** — the proposed date, its rule, and the type configuration in force — so reconfiguring a type later cannot rewrite a decision a human already made. **A non-null decision with a null date means "this does not renew"**, distinct from all-NULL, which means nobody looked; without that distinction the dashboard would fall back to the annual default and overrule the reviewer on the very next read |
| 0098 | document_type_extraction_instructions | **The MIDDLE layer of the extraction prompt stack.** Guidance was two layers — `tenants.extraction_context` (0072, the editable industry brain) and `supplier_extraction_instructions` (0035/0068, one (supplier, document_type) pair). Nothing in between, and `supplier_id` on 0035 is NOT NULL, so "here is how to read a Certificate of Insurance" from ANYBODY was not expressible: 27 types x 21 suppliers is up to 567 rows, and a new vendor's first Kosher Certificate extracted unguided. **NOT a nullable `supplier_id`** — SQLite treats NULLs as distinct in a UNIQUE index, so a wildcard NULL would let unlimited duplicate "any supplier" rows disagree silently (0086 had to fix exactly that with a COALESCE expression index; 0087 wrote the rule down). Both key columns here are NOT NULL, so a plain `UNIQUE(tenant_id, document_type_id)` actually constrains. **The layers COMPOSE, general -> specific** — type block, then supplier block, then BASE_PROMPT — matching how the supplier layer has always composed with the base rules (its own labelled block, never a substitution). Only 0072 replaces anything, because a tenant template is meant to be replaced. Resolution is `functions/lib/extractionInstructionStack.ts`, served on GET /api/extraction-instructions as `effective_instructions` while `instructions` stays the supplier row verbatim (the reviewer's editor PUTs that value back, so folding the broader layer in would copy shared text into one supplier's row). The block header carries a rule-14 guard in both mirrored copies (`functions/lib/llm.ts`, `bin/process-worker`), pinned by tests/unit/extractionGuidanceBlock.test.ts: guidance says where to look, never what the page said. Starter text for ten types via `bin/seed-doctype-extraction-instructions` (never automatic) |
| 0099 | module_visibility | **Which surfaces a tenant has, and which of those a department sees.** Three tables: `tenant_modules` (the tenant GATES a module on or off), `owner_labels` (the department vocabulary, backfilled from existing `owner_routes`), `module_visibility` (a department's constraint). Membership is NOT a new role table — a user holds a function because an `owner_routes` row (0091) points at them, which is the client's own "one concept, two effects": the same definitions drive alert routing AND what a person sees on login. `owner_label` had to be promoted to its own table anyway, because otherwise you cannot configure Sales's visibility until Sales first receives an alert, and Sales owns no renewals. **ABSENCE MEANS UNCONSTRAINED** — the deliberate inverse of `owner_routes`, where absence means "unrouted, and reported". Both point the same way: toward the person seeing more, never silently less. Every key column is NOT NULL inside a composite PRIMARY KEY, so 0086/0087/0091's NULL-distinctness trap cannot apply and no COALESCE index is needed. **No CHECK on `module_key`**: a row for an unknown key cannot produce a surface because surfaces come from `src/lib/surfaces.tsx`, and a CHECK would force a migration every time a module ships. **Inserts ZERO rows** into `tenant_modules`/`module_visibility` — absence resolves to the code default (enabled), so every existing user's visible set is byte-identical the day after; surfaces narrow only when a named admin clicks a toggle. Once a module ships its `defaultEnabled` is FROZEN. Vocabulary + pure resolver: `shared/modules.ts` |
| 0100 | document_type_requirements | **The table that makes the registry produce data instead of only consuming it.** Until this, NOTHING linked a document to a requirement automatically: `functions/lib/kinds/coa.ts` wrote zero `document_requirements` rows and `syncDocumentFacets` was reachable only from `documents/[id].ts` and `ingest.ts`, both of which need the CALLER to supply requirement ids. So an approved COA closed nothing, ever, unless a human ticked boxes by hand — the gap engine (0080/0087) had been running on data nothing produced. This says what a document TYPE normally closes; `functions/lib/requirement-defaults.ts` turns that into `document_requirements` rows at `status='suggested'`, `source='rule'`. **Deliberately NO `tier` and NO `status`**: this is a default, not an assertion — tier lives on `supplier_requirements` (0087, applicability) and status on `document_requirements` (0080, the actual link). Three tables, three questions. **A human's rejection can never be resurrected**, and structurally rather than by a check: the module only ever INSERTs OR IGNORE against `UNIQUE(document_id, requirement_id)` and DELETEs nothing, so there is no path by which a stored rejection stops existing. Gated on rows existing, so a tenant with no mappings behaves byte-identically. Also adds `document_types.default_owner` (which did not exist), copied to `documents.owner` only when NULL |
| 0101 | tenant_setup_runs | Where a tenant got to in the first-run setup wizard. **Stores a POSITION, not a configuration** — the wizard is write-through (every screen writes real config to the real tables via existing endpoints), so abandoning it leaves a partially configured tenant, which is correct. One draft per tenant via a partial unique index `WHERE status = 'draft'`; completed/abandoned runs accumulate as provenance. `status` has a CHECK because it is a closed vocabulary owned by this table |
| 0102 | supplier_requirement_provenance | `supplier_requirements.source` + `packet_slug` — where a checklist row CAME FROM ('packet' / 'human'). **Nullable, no default, on purpose**: the live tenant already holds bulk-written rows, and `DEFAULT 'human'` would assert someone chose each one; NULL = "written before anyone recorded why" and is the audit worklist. No CHECK (producers grow). `packet_slug` is a label, not an FK — packets live in the pack JSON. Discovery only; gap detection is byte-identical |
| 0103 | spec_check_provenance | `document_spec_checks.judgement_origin` ('approval' / 'bulk_recheck') + `bulk_run_at` — WHO judged a result, because `bin/backfill-spec-register` is a second producer and a script's arithmetic must never read as a reviewer's sign-off. **No default** (a forgetful future writer yields NULL, not a false 'approval'); existing rows are stamped 'approval' by an explicit UPDATE, provable from code since `registerSpecChecks` was the only writer. `bulk_run_at` is the pass's timestamp shared by every row it wrote — the run's identity, and deliberately not `created_at`. Partial index on the non-NULL side. Nothing reads either column to decide anything |
| 0104 | request_arrival_decisions | **A person decides what a supplier's file satisfies.** The decision lives on the CLAIM, not the upload, because one file is often claimed against several requirements and a reviewer may accept some and send others back: `request_upload_lines` gains `claimed_by` ('supplier'/'staff', DEFAULT 'supplier' so existing rows stay truthful with no backfill), `added_by`, `decision` ('accepted'/'needs_attention', NULL = the inbox), `decision_document_id`, `decided_at`/`_by`. A reviewer noticing a file covers something the supplier did not tick adds a `staff` claim in the same table, not a second table. `request_lines.accepted_document_id` names the document a line stands accepted on. It is NOT just a join, because the PUT escape hatch and multi-file history both exist. It is NULL whenever the line is not `accepted`, cleared on a newer upload, and carried across amendments. Both FKs are ON DELETE SET NULL. Partial index `(tenant_id, upload_id) WHERE decision IS NULL`. **Accept requires `request_uploads.document_id`** (queue approval first), enforced in `functions/lib/request-arrivals.ts`. `document_requirements.source` has no CHECK (0080), so the new `request_accept` provenance needed no rebuild |
| 0105 | spec_check_result_identity | `document_spec_checks.result_key` + `result_location` — WHICH result a register row is about. The engine's `specResultKey` ("ai_fields::t0r2c9") was computed for every verdict and persisted nowhere, so a multi-lot crosstab's lots that each print "Coliform <10" were indistinguishable rows: 53 "duplicate" groups on prod, every one a distinct result on replay. `result_location` is the same fact in words ("Table 1, row 3 (26141R)"), frozen by `registerIdentity` in `shared/specSnapshot.ts` for both producers. **Partial UNIQUE index** `(document_id, COALESCE(version_number,-1), result_key, source) WHERE result_key IS NOT NULL` makes a true duplicate unwritable; both producers also drop a repeated identity in code first (`uniqueByRegisterIdentity`) — by identity, never by value. No backfill UPDATE: `bin/backfill-spec-register --stamp-identity` recovers identity by replaying the engine, bulk rows only, only where the replay reproduces the document; `--prune-duplicates` deletes only identity-proven surplus |
| 0106 | lot_production_date | **A lot row's production date, with where it came from; and the text a split certificate is SEARCHED on.** `lots.production_date` (ISO or NULL) + `production_date_raw` (verbatim) + `production_date_source` ('extracted' / 'extracted_code_date_legacy' / 'reviewer') + `production_date_status` ('resolved' / 'ambiguous' / 'unparseable' / 'conflict') + `production_date_document_id`, and a PARTIAL index `(tenant_id, production_date)` the coverage search seeks on. **NOT `mfg_date`**: NULL on 100% of prod lots, no provenance, and filled by any caller. **Never a guess**: a value that reads two ways is raw + NULL day; two certificates disagreeing is 'conflict' with both values in raw — nothing picks a winner (`shared/lotProductionDate.ts`; writer rule `productionDateSets` in `functions/lib/entities/lots.ts`). **The approve paths no longer fold `production_date` into `lots.code_date`** — a code date is a code date. Weight/quantity are NOT lot columns (a lot is shared across certificates and orders); the row's split document carries them. `document_versions.search_text`: the certificate text with the OTHER rows' lot numbers and dates blanked (`shared/rowScopedText.ts`), read by `documents_fts_source` via `COALESCE(search_text, extracted_text)`; `extracted_text` stays the file's text. View re-created, and `trg_document_versions_au_fts` re-created to fire on `search_text`; no inline FTS rebuild (no existing row has search_text). History: `bin/backfill-lot-production-dates` (dry run default; legacy code dates only where the page prints the value under a production label and never prints a code-date label). Search reads a legacy-sourced date as **likely — confirm**, never covering |
| 0107 | product_identifiers | **What a product goes by, and who said so.** (Number may need renumbering against the parallel intake-duplicate branch.) One row per identifier of OUR product: `kind` ('our_sku' / 'supplier_item' / 'supplier_name' / 'alias' / 'gtin' / 'pack'), `value` + `value_norm` (computed in `functions/lib/product-identifiers.ts`, never SQL; codes keep leading zeros), `supplier_id`, `superseded` (a former number), `confirmed`, `source` ('seed' / 'reviewer' / 'extracted' / 'import', CHECKed), `note` (the evidence), created/confirmed by+at. **Not `supplier_product_map`** (0075): its UNIQUE on the supplier product NAME cannot hold CMF's one name on two items (30904 tote = our 10286, 50903 bag = our 0801), and the matching engine reads it. **Not `product_suppliers.supplier_sku`**: one SKU per product per supplier, no provenance. A CHECK pairs kind with supplier_id both ways (supplier kinds NOT NULL, the rest NULL); the NULL-distinctness trap is answered with TWO PARTIAL unique indexes (with / without a supplier), each over NOT NULL keys. Uniqueness is per product, not tenant: two products claiming one SKU is ambiguity search must SHOW. Removal is a DELETE with the whole row in the `product_identifier.removed` audit row. No order index: `orders` already has UNIQUE(tenant_id, order_number) for the A7 seek |


## Role Model (4 roles)

| Role | Scope | Key Permissions |
|------|-------|----------------|
| super_admin | All tenants | Full access, manage tenants and all users |
| org_admin | Own tenant | Manage users (user/reader), documents, view audit |
| user | Own tenant | Create/upload/update/delete documents |
| reader | Own tenant | Read-only, download files |

## Commands

- Install: `npm install`
- Build: `npm run build` (TypeScript + Vite)
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

## Task Management

Use `TaskCreate` for concrete work items to track progress:
- Create tasks with clear, actionable subjects
- Set tasks to `in_progress` when starting, `completed` when done
- Use task dependencies (`blocks`/`blockedBy`) for ordering

## Interaction

When you need user input, prefer `AskUserQuestion` with clear options over open-ended questions. This renders a native chooser in the companion app rather than a wall of text.
