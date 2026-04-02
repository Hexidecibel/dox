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

## Migrations (0001-0022)

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
| `FEATURES.md` | Completed features — living changelog of what's been shipped. |
| `backlog.md` | Deferred ideas, long-term research, and items not in the daily workflow. |
| `next-time.md` | User's notes/thoughts for the next session. Read on startup, address first. |

**Flow:** `todo.md` (idea) -> `plan.md` (planned -> in-progress -> done) -> `FEATURES.md` (shipped)
**Deferred:** Items moved from `todo.md` to `backlog.md` when not prioritized.

When committing (`/commit`), update tracking files:
1. Remove completed items from `todo.md`
2. Set status to `done` in `plan.md`
3. Add/update entries in `FEATURES.md`

## Task Management

Use `TaskCreate` for concrete work items to track progress:
- Create tasks with clear, actionable subjects
- Set tasks to `in_progress` when starting, `completed` when done
- Use task dependencies (`blocks`/`blockedBy`) for ordering

## Interaction

When you need user input, prefer `AskUserQuestion` with clear options over open-ended questions. This renders a native chooser in the companion app rather than a wall of text.
