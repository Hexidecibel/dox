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
- **Structured Metadata**: Flexible JSON metadata on documents via `primary_metadata` and `extended_metadata` columns. Old hardcoded fields (lot_number, po_number, code_date, expiration_date) remain in DB but are unused.
- **Suppliers**: First-class supplier entity per tenant. Documents link to suppliers via `supplier_id`. Lookup-or-create endpoint for fuzzy matching.
- **Document-Product Linking**: Many-to-many links between documents and products with per-link expiration dates and notes. Ingest API accepts `product_ids`.
- **Naming Templates**: Per-tenant file naming templates with generic placeholders (any metadata key like `{lot_number}`, `{supplier}`, `{doc_type}`, etc.) applied during ingest.
- **Email Ingest**: `POST /api/webhooks/email-ingest` for Mailgun/SendGrid inbound parse. Maps sender domain to tenant, extracts attachments.
- **Expiration Dashboard**: Dashboard showing documents approaching expiration with summary cards, configurable look-ahead, and email alerts.
- **Scheduled Renewal Alerts (per-owner)**: Renewal is the frequent use case, so it does not wait for a human to press a button. The `dox-renewal-alerts` companion Worker (`workers/renewal-alerts/`, deploy with `bin/deploy-renewal-alerts`) fires `POST /api/expirations/run-scheduled` daily at 13:00 UTC — Pages cannot host a cron, same reason `dox-connector-poller` exists. Alerts are **grouped by the record's owner**: `documents.owner` resolves through `owner_routes` (migration 0091, managed via `/api/owner-routes`) and each owner gets a digest of only their records, with a token-gated `/alert/<token>` link that needs no login. The routing ladder is `functions/lib/alert-routing.ts` and is shared with the spec path. **The two paths differ by one deliberate flag**: spec alerts pass `adminFallback: true` (a one-shot food-safety event should reach someone), renewals pass `false` (a recurring job that falls back to the admin pool trains everyone to ignore it). **A record with no resolvable owner is never silently re-broadcast** — it produces a routing-gap notice, an `expirations.routing_gap` audit row, and an `unrouted` block in the API response. Re-alert suppression (`renewal_alert_state`): first sight, escalation, or a 7-day cooldown. Engine: `functions/lib/renewal-alerts.ts`, shared verbatim with the manual `POST /api/expirations/notify` button.
- **Document Bundles**: Named compliance packages grouping documents with version pinning. Download as ZIP. Draft/finalized workflow.
- **Spec Limits + Out-of-Parameter Warnings**: Acceptance limits on COA test results (`spec_tests` + `spec_limits`, migration 0084). Two sources judge every result — the COA's own printed spec/pass-fail (no configuration, works on every supplier) and OUR configured limit, which is often tighter than what the supplier certifies against. **Three-state by design**: `in_spec` / `out_of_spec` / `not_checked`, where `not_checked` means we held a limit and could not honestly apply it (a censored `<50` against a ≤10 limit, a CFU/mL result against a CFU/g limit) and is never a silent pass. Engine is `shared/specCheck.ts` (pure); review-queue surfacing via `functions/lib/spec-warnings.ts`; register + alerts via `functions/lib/spec-register.ts` (one email per document; routing now delegates to the shared ladder in `functions/lib/alert-routing.ts` — owner route, then `assignments`, then org_admins, with the admin fallback passed in explicitly as `adminFallback: true` because a one-shot safety event reaching nobody is worse than a redundant email). Warns, never blocks. Preview what a limit would catch with `bin/recheck-spec-limits --tenant <id>`.
- **Request Composer**: Compose a document request against one supplier, issue it, and amend it without destroying what was originally sent (migration 0090). A line SHOULD resolve to a `requirement_id` so the arriving document is a registry object the gap engine can count; free text is supported as an escape hatch but must be declared (`line_kind: "free_text"`) and is counted separately on every response. Per-line status is the client's five: `not_started | received | under_review | accepted | needs_attention`, with no transition graph imposed. Amendments after issue create a NEW version (`root_request_id` + `version`, previous row stamped `superseded_at` and otherwise frozen); re-issue starts a new root for renewals and new items under an approved vendor. One issue path (`issueRequest` in `functions/lib/document-requests.ts`) writes one internal `request_routing` row and one audit row regardless of what filled the draft — a future generator drafts, a human issues. The external projection is an allow-list (`buildSupplierRequestView`), same discipline as `buildAlertLandingView`. Satisfaction is READ-ONLY today: a typed line surfaces the confirmed `document_requirements` links from that supplier as `closure`, and deliberately does not move `status` — arrival attribution is the follow-up.

## Migrations (0001-0091)

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
| 0066 | order_item_lot_linking | order_items.lot_id + coa_match_status/coa_matched_at + lot_match_suggestions |
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
