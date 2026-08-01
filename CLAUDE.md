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
- **Expiration Dashboard**: Dashboard showing documents approaching expiration with summary cards, configurable look-ahead, and email alerts to org_admins.
- **Document Bundles**: Named compliance packages grouping documents with version pinning. Download as ZIP. Draft/finalized workflow.

## Migrations (0001-0079)

**Current schema state: `SCHEMA.md`** (generated — regenerate with `./bin/schema-doc`
after every migration). This table is migration *history*; SCHEMA.md is what the
database looks like *now*. Prefer SCHEMA.md when you need current columns.

⚠️ **Two migrations share the number 0023** (`0023_multi_product_fields.sql` and
`0023_processing_status.sql`). Ordering is deterministic by filename (multi_product
before processing_status), but never assume one file per number when scripting.

⚠️ The chain is **not re-runnable from scratch**, and prod's `_migrations` tracking
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

## Environment Variables (.dev.vars)

```
JWT_SECRET=your-secret-here
RESEND_API_KEY=re_xxxx  # Optional, enables email notifications
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
