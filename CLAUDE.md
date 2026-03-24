# doc-upload-site

Multi-tenant document upload/download portal with version tracking, role-based access control, audit logging, and report generation. Built for regulatory document management where manufacturers and vendors independently manage their documents.

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
migrations/             # D1 SQL migration files (0001-0008)
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

## Migrations (0001-0008)

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
