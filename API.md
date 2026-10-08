# Dox — API Reference

## System Overview

Dox is a multi-tenant document management system for regulatory documents. It provides:

- **Document management** with version tracking, file upload/download, categorization, and search
- **Multi-tenant isolation** where each organization (tenant) has its own documents and users
- **Role-based access control** with four permission levels
- **Audit trail** logging every significant action
- **Report generation** in CSV and JSON formats
- **Dual API surface**: REST + GraphQL

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Pages Functions (Workers) |
| Database | Cloudflare D1 (SQLite at the edge) |
| File Storage | Cloudflare R2 (S3-compatible object store) |
| Frontend | React + MUI + Vite |
| Auth | Custom JWT (HMAC-SHA256, 24h expiry) |
| Password Hashing | PBKDF2 (100k iterations, SHA-256) |
| Email | Resend API |
| GraphQL | graphql-yoga |

### Architecture

```
Browser --> Cloudflare Pages
              |
              +--> Static assets (dist/)
              |
              +--> Pages Functions (functions/api/)
                     |
                     +--> D1 database (users, documents, tenants, audit_log, ...)
                     +--> R2 bucket (file storage)
                     +--> Resend API (email notifications)
```

All API routes live under `/api/`. The middleware at `functions/api/_middleware.ts` handles CORS, security headers, and JWT authentication for every request.

---

## Authentication

### Authentication Methods

The API supports two authentication methods:

1. **JWT Bearer Token** — for interactive sessions (browser, short-lived)
2. **API Key** — for programmatic/automated access (long-lived, headless)

Both methods are checked by the middleware. API keys use the `X-API-Key` header; JWTs use `Authorization: Bearer <token>`.

### Method 1: JWT Bearer Token

1. Client sends `POST /api/auth/login` with email and password.
2. Server verifies credentials (PBKDF2), creates a session record in D1, and returns a JWT.
3. Client includes the JWT in all subsequent requests via the `Authorization` header.
4. Middleware extracts the token, verifies the signature and expiry, checks that the session is not revoked, and loads the full user record.

The JWT is HMAC-SHA256 signed with the `JWT_SECRET` environment variable. Payload:

```json
{
  "sub": "user-id-hex",
  "email": "user@example.com",
  "role": "user",
  "tenantId": "tenant-id-hex-or-null",
  "iat": 1711234567890,
  "exp": 1711320967890
}
```

Tokens expire after **24 hours**. Sessions are tracked server-side via a SHA-256 hash of the token, enabling server-side revocation (logout).

```bash
# Get a token
TOKEN=$(curl -s -X POST http://localhost:8788/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"AdminPass1"}' | jq -r '.token')

# Use the token
curl http://localhost:8788/api/users/me \
  -H "Authorization: Bearer $TOKEN"
```

### Method 2: API Key

API keys provide long-lived programmatic access without JWT token management. They are ideal for CI pipelines, agentic workflows, and automated integrations.

Keys use the prefix `dox_sk_` and authenticate as the user who created them (inheriting that user's role and tenant scope).

**One thing a key does NOT inherit: taking files out.** A key reads a document's file only when that document's [sharing rule](#the-sharing-rule-migration-0137) is "send freely", on every route that hands over a file, whoever the key belongs to. A key made by an administrator is refused a locked document exactly as a key made by anybody else is.

```bash
# Use an API key
curl http://localhost:8788/api/documents \
  -H "X-API-Key: dox_sk_abc123def456..."
```

See the [API Keys](#api-keys) section below for how to create, list, and revoke keys.

### Public Routes (No Auth Required)

- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/graphql` (individual resolvers enforce auth)
- `GET /api/graphql` (GraphiQL IDE)

---

## Authorization

### Four-Role Model

| Role | Scope | Capabilities |
|------|-------|-------------|
| **super_admin** | All tenants | Full access. Create/manage tenants, create any user, view all documents, audit logs across tenants. |
| **org_admin** | Own tenant | Manage users (user/reader only) in their tenant, manage documents, view audit logs for their tenant, update own tenant name/description. |
| **user** | Own tenant | Create, upload, update, and delete documents. Change own password. View own profile. |
| **reader** | Own tenant | Read-only access to documents. Download files. Change own password. View own profile. |

### Permission Matrix

| Action | super_admin | org_admin | user | reader |
|--------|:-----------:|:---------:|:----:|:------:|
| Create tenant | Y | - | - | - |
| Update any tenant | Y | - | - | - |
| Update own tenant (name/desc) | Y | Y | - | - |
| Delete (deactivate) tenant | Y | - | - | - |
| Create user (any role) | Y | - | - | - |
| Create user (user/reader) | Y | Y | - | - |
| List users | Y | Y (own tenant) | - | - |
| Update user | Y (any) | Y (own tenant, user/reader) | name only (self) | name only (self) |
| Deactivate user | Y | Y (user/reader, own tenant) | - | - |
| Admin password reset | Y | Y (user/reader, own tenant) | - | - |
| List documents | Y (all) | Y (own tenant) | Y (own tenant) | Y (own tenant) |
| Create document | Y | Y | Y | - |
| Upload file | Y | Y | Y | - |
| Update document | Y | Y | Y | - |
| Delete document | Y | Y | Y | - |
| Download file | Y | Y | Y | Y |
| Search documents | Y | Y | Y | Y |
| View audit log | Y (all) | Y (own tenant) | - | - |
| Generate report | Y (all) | Y (own tenant) | Y (own tenant) | Y (own tenant) |

---

## Multi-Tenancy

Every user (except potentially super_admin) belongs to a tenant (`tenant_id`). All data queries enforce tenant isolation:

- Non-super_admin users have their `tenant_id` automatically injected into queries, overriding any client-supplied value.
- Documents, audit entries, and user lists are filtered by tenant.
- The `requireTenantAccess()` helper verifies that a user has access to a given tenant, throwing a 403 if not.

Tenants have:
- `id` — hex UUID
- `name` — display name
- `slug` — URL-safe identifier used in R2 storage paths
- `active` — soft-delete flag (0 = deactivated)

---

## Data Models

### users

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Hex UUID |
| email | TEXT UNIQUE | Login email (lowercased) |
| name | TEXT | Display name |
| role | TEXT | super_admin, org_admin, user, reader |
| tenant_id | TEXT NULL | FK to tenants.id |
| password_hash | TEXT | PBKDF2 hash in "salt:hash" hex format |
| active | INTEGER | 1=active, 0=deactivated |
| force_password_change | INTEGER | 1=must change password on next login |
| last_login_at | DATETIME | Last successful login |
| created_at | DATETIME | Auto-set |
| updated_at | DATETIME | Auto-set |

### tenants

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Hex UUID |
| name | TEXT | Organization name |
| slug | TEXT UNIQUE | URL-safe identifier, used in R2 paths |
| description | TEXT NULL | Optional description |
| active | INTEGER | 1=active, 0=deactivated |
| created_at | DATETIME | Auto-set |
| updated_at | DATETIME | Auto-set |

### documents

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Hex UUID |
| tenant_id | TEXT | FK to tenants.id |
| title | TEXT | Document title |
| description | TEXT NULL | Optional description |
| category | TEXT NULL | Free-form category string |
| tags | TEXT | JSON array of tag strings |
| current_version | INTEGER | Latest version number (0 = no file uploaded) |
| status | TEXT | active, archived, deleted |
| created_by | TEXT | FK to users.id |
| created_at | DATETIME | Auto-set |
| updated_at | DATETIME | Auto-set |

### document_versions

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Hex UUID |
| document_id | TEXT | FK to documents.id |
| version_number | INTEGER | Sequential version number (1, 2, 3, ...) |
| file_name | TEXT | Original file name |
| file_size | INTEGER | Size in bytes |
| mime_type | TEXT | MIME type of the file |
| r2_key | TEXT | R2 storage key: `{tenantSlug}/{docId}/{version}/{fileName}` |
| checksum | TEXT NULL | SHA-256 hex digest |
| change_notes | TEXT NULL | User-provided notes for this version |
| uploaded_by | TEXT | FK to users.id |
| created_at | DATETIME | Auto-set |

### audit_log

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| user_id | TEXT NULL | Who performed the action |
| tenant_id | TEXT NULL | Which tenant was affected |
| action | TEXT | Action identifier (see list below) |
| resource_type | TEXT NULL | user, document, document_version, tenant, report |
| resource_id | TEXT NULL | ID of the affected resource |
| details | TEXT NULL | JSON string with change details or context |
| ip_address | TEXT NULL | Client IP (from CF-Connecting-IP header) |
| created_at | DATETIME | Auto-set |

### sessions

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Hex UUID |
| user_id | TEXT | FK to users.id |
| token_hash | TEXT | SHA-256 hash of the JWT |
| revoked | INTEGER | 0=active, 1=revoked |
| expires_at | DATETIME | Token expiration |

### password_resets

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| user_id | TEXT | FK to users.id |
| token_hash | TEXT | SHA-256 hash of the reset token |
| expires_at | DATETIME | 1 hour from creation |

### rate_limits

| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Rate limit key (e.g., "login:ip:email") |
| attempts | INTEGER | Number of attempts in window |
| window_start | DATETIME | Start of the current window |

---

## REST API Reference

### Auth

#### POST /api/auth/login

Log in and obtain a JWT token.

```bash
curl -X POST http://localhost:8788/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"AdminPass1"}'
```

Response (200):
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "abc123...",
    "email": "admin@example.com",
    "name": "Admin User",
    "role": "super_admin",
    "tenant_id": null,
    "force_password_change": 0
  }
}
```

Rate limited: 5 attempts per 15 minutes per IP+email combination.

#### POST /api/auth/register

Create a new user (requires super_admin or org_admin).

```bash
curl -X POST http://localhost:8788/api/auth/register \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "email": "jane@example.com",
    "name": "Jane Doe",
    "role": "user",
    "password": "Welcome123",
    "tenantId": "tenant-id-here"
  }'
```

Response (201):
```json
{
  "user": {
    "id": "new-user-id",
    "email": "jane@example.com",
    "name": "Jane Doe",
    "role": "user",
    "tenant_id": "tenant-id-here"
  },
  "emailSent": true
}
```

Password requirements: 8-128 characters, must contain uppercase, lowercase, and a number.

#### PUT /api/auth/password

Change own password.

```bash
curl -X PUT http://localhost:8788/api/auth/password \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"currentPassword":"OldPass1","newPassword":"NewPass1"}'
```

#### POST /api/auth/logout

Revoke the current session.

```bash
curl -X POST http://localhost:8788/api/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

#### POST /api/auth/forgot-password

Request a password reset email (public, rate limited to 3/15min per IP).

```bash
curl -X POST http://localhost:8788/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com"}'
```

Always returns `{"message": "If an account exists with that email, a reset link has been sent"}` regardless of whether the email exists.

#### POST /api/auth/reset-password

Complete a password reset using the emailed token (public).

```bash
curl -X POST http://localhost:8788/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"hex-token-from-email","newPassword":"NewSecure1"}'
```

Revokes all existing sessions for the user.

---

### Documents

#### GET /api/documents

List documents with pagination and filters.

```bash
# List active documents (user's tenant auto-applied)
curl http://localhost:8788/api/documents \
  -H "Authorization: Bearer $TOKEN"

# With filters
curl "http://localhost:8788/api/documents?category=regulatory&status=active&limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# super_admin: filter by tenant
curl "http://localhost:8788/api/documents?tenantId=abc123" \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "documents": [
    {
      "id": "doc-id",
      "tenant_id": "tenant-id",
      "title": "Safety Data Sheet",
      "description": "...",
      "category": "regulatory",
      "tags": "[\"safety\",\"osha\"]",
      "current_version": 2,
      "status": "active",
      "created_by": "user-id",
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-03-01T14:30:00Z",
      "creator_name": "John Doe",
      "creator_email": "john@example.com",
      "tenant_name": "Acme Corp"
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

#### POST /api/documents

Create a new document (metadata only).

```bash
curl -X POST http://localhost:8788/api/documents \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Safety Data Sheet - Widget A",
    "description": "SDS per OSHA 2024 requirements",
    "category": "regulatory",
    "tags": ["safety", "osha"],
    "tenantId": "tenant-id"
  }'
```

#### GET /api/documents/:id

Get a single document with current version info.

```bash
curl http://localhost:8788/api/documents/DOC_ID \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "document": { "...document fields..." },
  "currentVersion": {
    "id": "version-id",
    "version_number": 2,
    "file_name": "sds-v2.pdf",
    "file_size": 524288,
    "mime_type": "application/pdf",
    "checksum": "a1b2c3...",
    "change_notes": "Updated section 4",
    "uploader_name": "John Doe"
  }
}
```

#### PUT /api/documents/:id

Update document metadata.

```bash
curl -X PUT http://localhost:8788/api/documents/DOC_ID \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Updated Title","status":"archived"}'
```

`sharing_rule_override` (`"free"` / `"qa"` / `"locked"`, or `null` to follow the document type again) with `sharing_rule_reason` gives one document its own [sharing rule](#the-sharing-rule-migration-0137). See that section for who may send it.

#### DELETE /api/documents/:id

Soft-delete a document (sets status to "deleted").

```bash
curl -X DELETE http://localhost:8788/api/documents/DOC_ID \
  -H "Authorization: Bearer $TOKEN"
```

#### POST /api/documents/:id/upload

Upload a new file version (multipart form data).

```bash
curl -X POST http://localhost:8788/api/documents/DOC_ID/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/document.pdf" \
  -F "changeNotes=Updated section 4.2 with new regulations"
```

Allowed types: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPG. Max size: 100 MB.

Response (201):
```json
{
  "version": {
    "id": "version-id",
    "document_id": "DOC_ID",
    "version_number": 3,
    "file_name": "document.pdf",
    "file_size": 1048576,
    "mime_type": "application/pdf",
    "r2_key": "acme-corp/DOC_ID/3/document.pdf",
    "checksum": "sha256hex...",
    "change_notes": "Updated section 4.2 with new regulations",
    "uploaded_by": "user-id"
  }
}
```

#### GET /api/documents/:id/download

Download a document file.

```bash
# Download current version
curl -OJ http://localhost:8788/api/documents/DOC_ID/download \
  -H "Authorization: Bearer $TOKEN"

# Download specific version
curl -OJ "http://localhost:8788/api/documents/DOC_ID/download?version=1" \
  -H "Authorization: Bearer $TOKEN"
```

Returns the raw file with `Content-Disposition: attachment` and appropriate `Content-Type`.

A logged-in person may download any document they can see, whatever its [sharing rule](#the-sharing-rule-migration-0137): opening one file inside the portal is not "leaving". An **API key** gets the file only when the rule is "send freely"; otherwise `403` with `code: "sharing_rule_refused"` and the `reason` (`locked` or `needs_qa`). `?source=packet` returns the original packet a version was split from; a key reads that only when every document split from the packet is "send freely".

#### GET /api/documents/:id/versions

List all versions of a document.

```bash
curl http://localhost:8788/api/documents/DOC_ID/versions \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "versions": [
    {
      "id": "v3-id",
      "version_number": 3,
      "file_name": "doc-v3.pdf",
      "file_size": 2097152,
      "mime_type": "application/pdf",
      "checksum": "...",
      "change_notes": "Major revision",
      "uploaded_by": "user-id",
      "uploader_name": "John Doe",
      "uploader_email": "john@example.com",
      "created_at": "2024-03-01T14:30:00Z"
    }
  ],
  "document_id": "DOC_ID",
  "current_version": 3
}
```

#### GET /api/documents/search

Search documents by title, description, and tags.

```bash
curl "http://localhost:8788/api/documents/search?q=safety&category=regulatory&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

Uses SQL LIKE (`%query%`) matching against title, description, and tags fields.

---

### Tenants

#### GET /api/tenants

List tenants (super_admin sees all, others see own tenant only).

```bash
curl http://localhost:8788/api/tenants \
  -H "Authorization: Bearer $TOKEN"

# Filter by active status
curl "http://localhost:8788/api/tenants?active=1" \
  -H "Authorization: Bearer $TOKEN"
```

#### POST /api/tenants

Create a tenant (super_admin only).

```bash
curl -X POST http://localhost:8788/api/tenants \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Acme Corp","description":"Manufacturing division"}'
```

Slug is auto-generated from name (e.g., "Acme Corp" becomes "acme-corp").

#### GET /api/tenants/:id

Get a single tenant.

```bash
curl http://localhost:8788/api/tenants/TENANT_ID \
  -H "Authorization: Bearer $TOKEN"
```

#### PUT /api/tenants/:id

Update a tenant.

```bash
# super_admin: all fields
curl -X PUT http://localhost:8788/api/tenants/TENANT_ID \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"New Name","active":0}'

# org_admin: name and description only
curl -X PUT http://localhost:8788/api/tenants/TENANT_ID \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Updated Name","description":"New desc"}'
```

#### DELETE /api/tenants/:id

Deactivate a tenant (super_admin only). Sets `active = 0`.

```bash
curl -X DELETE http://localhost:8788/api/tenants/TENANT_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

### Users

#### GET /api/users

List users (super_admin or org_admin only).

```bash
# All users (super_admin)
curl http://localhost:8788/api/users \
  -H "Authorization: Bearer $TOKEN"

# Filter by tenant
curl "http://localhost:8788/api/users?tenantId=TENANT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

#### GET /api/users/me

Get the current authenticated user's profile.

```bash
curl http://localhost:8788/api/users/me \
  -H "Authorization: Bearer $TOKEN"
```

Returns user fields plus `tenant_name`.

#### GET /api/users/:id

Get a user by ID (access depends on role).

```bash
curl http://localhost:8788/api/users/USER_ID \
  -H "Authorization: Bearer $TOKEN"
```

#### PUT /api/users/:id

Update a user (fields allowed depend on caller's role).

```bash
curl -X PUT http://localhost:8788/api/users/USER_ID \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"New Name","role":"reader","active":1}'
```

#### DELETE /api/users/:id

Deactivate a user (sets `active = 0`).

```bash
curl -X DELETE http://localhost:8788/api/users/USER_ID \
  -H "Authorization: Bearer $TOKEN"
```

#### POST /api/users/:id/reset-password

Admin-initiated password reset (super_admin or org_admin).

```bash
curl -X POST http://localhost:8788/api/users/USER_ID/reset-password \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "temporaryPassword": "Ab3$xyzRandomPw",
  "emailSent": true
}
```

Sets `force_password_change = 1` and revokes all sessions.

---

### Reports

#### POST /api/reports/generate

Generate a document report in CSV or JSON format.

```bash
# JSON report
curl -X POST http://localhost:8788/api/reports/generate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"category":"regulatory","dateFrom":"2024-01-01","dateTo":"2024-12-31","format":"json"}'

# CSV report (download)
curl -X POST http://localhost:8788/api/reports/generate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"format":"csv"}' \
  -o report.csv
```

CSV columns: Title, Category, Tags, Status, Current Version, File Name, File Size (KB), Uploaded By, Created Date, Last Updated.

The filters are exactly the four in the body — `tenantId`, `category` (the legacy
category field), `dateFrom` and `dateTo` (against `created_at`). There is no
supplier, document-type, product or status filter, and no supplier or products
column. Every call writes a `report.generate` audit row with the format, the
category filter and the row count.

#### GET /api/reports/coa-fulfillment

One row per shipped order line — customer ▸ order ▸ lot ▸ COA — each classified
`ok` / `missing_lot` / `missing_coa` / `expired` against `as_of`. Any
authenticated user; `tenant_id` is super_admin only.

```bash
# The screen's JSON feed
curl "http://localhost:8788/api/reports/coa-fulfillment?from=2026-01-01" \
  -H "Authorization: Bearer $TOKEN"

# The same rows as a CSV worklist, limited to the lines still needing a COA
curl "http://localhost:8788/api/reports/coa-fulfillment?format=csv&gaps_only=1" \
  -H "Authorization: Bearer $TOKEN" -o coa-worklist.csv
```

CSV columns: Customer, Order, PO, Product, Code, Lot, Status, Action.

`format=csv` writes a `report.generate` audit row (`report_kind:
"coa_fulfillment"`) with the filters and the row count, so an export of
fulfillment data is provable the same way a document report is. The JSON form
writes nothing — it is a screen read, not an export. CSV defaults to `limit=5000`
(max 5000) rather than the JSON default of 200, so the file is not silently the
first page.

---

### Audit

#### GET /api/audit

Query audit log entries (super_admin or org_admin only).

```bash
# Recent entries
curl "http://localhost:8788/api/audit?limit=20" \
  -H "Authorization: Bearer $TOKEN"

# Filter by action and date range
curl "http://localhost:8788/api/audit?action=document_created&dateFrom=2024-01-01&dateTo=2024-03-31" \
  -H "Authorization: Bearer $TOKEN"

# Filter by user
curl "http://localhost:8788/api/audit?userId=USER_ID" \
  -H "Authorization: Bearer $TOKEN"

# super_admin narrowing to one tenant — the parameter is snake case
curl "http://localhost:8788/api/audit?tenant_id=TENANT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

Filters: `tenant_id` (super_admin only; an org_admin is pinned to their own
tenant and a `tenant_id` from them is ignored), `action` (comma-separated for
several), `userId`, `resourceType`, `dateFrom`, `dateTo` (inclusive, through end
of day), `limit` (max 200), `offset`. The tenant parameter is `tenant_id`, not
`tenantId`; the screen and the CSV export share one `buildAuditFilters` helper so
they cannot drift.

#### GET /api/audit/export

CSV export of the audit log (super_admin or org_admin only). Accepts the same
filters as `GET /api/audit` and enforces the same permissions — an `org_admin`
is pinned to their own tenant and a `tenant_id` parameter from them is ignored,
never honoured.

```bash
# Everything the caller is allowed to see
curl "http://localhost:8788/api/audit/export" \
  -H "Authorization: Bearer $TOKEN" -o audit.csv

# Same filters as the screen: an action list plus a date range
curl "http://localhost:8788/api/audit/export?action=document_deleted,user_deactivated&dateFrom=2024-01-01&dateTo=2024-03-31" \
  -H "Authorization: Bearer $TOKEN" -o audit.csv
```

CSV columns: `id, timestamp, user_id, user_name, user_email, tenant_id, action,
resource_type, resource_id, ip_address, details`.

Notes:
- **Not page-capped.** `GET /api/audit` maxes out at 200 rows per page; the
  export streams the whole filtered set in batches, so nothing unbounded is
  held in Worker memory.
- **Snapshot.** The row set is pinned before the request writes its own
  `audit.export` entry, so the CSV never contains its own record and its row
  count always equals `X-Audit-Export-Matched`.
- **Escaping.** Every field is quoted with embedded quotes doubled (RFC 4180),
  so the commas, quotes and newlines inside the JSON `details` column survive.
- **Limit.** Exports stop at 100,000 rows; `X-Audit-Export-Truncated: true`
  says so. Narrow the date range for the rest.
- **Self-auditing.** The export writes an `audit.export` row with the user, IP,
  filters applied and matched row count.

Audit actions logged by the system:
- `login`, `logout`, `password_changed`
- `user_created`, `user_updated`, `user_deactivated`, `user.password_reset`
- `tenant_created`, `tenant_updated`, `tenant_deactivated`
- `document_created`, `document_updated`, `document_deleted`
- `document_version_uploaded`, `document_downloaded`
- `report.generate`, `audit.export`

---

## API Keys

API keys provide programmatic access for automated systems, CI pipelines, and agentic workflows. Keys authenticate as the user who created them, inheriting that user's role and tenant access.

### GET /api/api-keys

List all API keys (super_admin sees all; org_admin sees own tenant only).

```bash
curl http://localhost:8788/api/api-keys \
  -H "Authorization: Bearer $TOKEN"
```

Response (200):
```json
[
  {
    "id": "key-id",
    "name": "CI Pipeline Key",
    "key_prefix": "dox_sk_abc12",
    "user_id": "user-id",
    "tenant_id": "tenant-id",
    "permissions": "[\"*\"]",
    "last_used_at": "2026-03-24T10:00:00Z",
    "expires_at": null,
    "revoked": 0,
    "created_at": "2026-03-20T08:00:00Z",
    "user_name": "Admin User",
    "user_email": "admin@example.com"
  }
]
```

### POST /api/api-keys

Create a new API key. The full key is returned **only once** in the response and cannot be retrieved later.

```bash
curl -X POST http://localhost:8788/api/api-keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"CI Pipeline Key","tenantId":"tenant-id"}'
```

Response (201):
```json
{
  "apiKey": {
    "id": "key-id",
    "name": "CI Pipeline Key",
    "key_prefix": "dox_sk_abc12",
    "user_id": "user-id",
    "tenant_id": "tenant-id",
    "permissions": "[\"*\"]",
    "revoked": 0,
    "created_at": "2026-03-24T10:00:00Z"
  },
  "key": "dox_sk_abc123def456..."
}
```

Optional fields: `permissions` (array of strings, default `["*"]`), `expiresAt`, `tenantId` (super_admin only; org_admin auto-scoped).

`expiresAt` is the last moment the key works:

- `"2026-12-31"` (a date) — the key works **through the end of that day, UTC** (until `2026-12-31T23:59:59.999Z`). A key given today's date works until midnight UTC tonight.
- `"2026-12-31T23:59:59-08:00"` (a timestamp) — must carry a time zone (`Z` or an offset); a zone-less timestamp is rejected.
- A value already in the past is rejected with `400` rather than creating a key that is expired on arrival. Omit the field for a key that never expires.

The stored `expires_at` is normalised to a UTC timestamp. Settings › API Keys sends the end of the picked day in the admin's own time zone. Keys created before this rule may still hold a bare date; those are read the same way (through the end of that day, UTC).

### DELETE /api/api-keys/:id

Revoke an API key (cannot be undone).

```bash
curl -X DELETE http://localhost:8788/api/api-keys/KEY_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

## Document Ingestion

The ingestion endpoint (`POST /api/documents/ingest`) provides upsert-by-reference semantics for automated document pipelines. It is designed for agentic AI and email processing workflows.

### How It Works

- Every ingested document carries an `external_ref` — a stable, caller-defined identifier (e.g., `"REF-2024-001"`, an email message ID, a ticket number).
- If a document with the given `external_ref` already exists in the tenant, a **new version** is added.
- If no document exists, a **new document** is created with version 1.
- This is a multipart form upload (same file type and size restrictions as regular uploads).

### POST /api/documents/ingest

```bash
# First ingest — creates a new document
curl -X POST http://localhost:8788/api/documents/ingest \
  -H "X-API-Key: dox_sk_abc123def456..." \
  -F "file=@report.pdf" \
  -F "external_ref=REF-2024-001" \
  -F "tenant_id=TENANT_ID" \
  -F "title=Safety Report Q1 2024" \
  -F "category=regulatory" \
  -F 'tags=["safety","quarterly"]' \
  -F "changeNotes=Initial submission from vendor" \
  -F 'source_metadata={"source":"email","from":"vendor@acme.com","subject":"Q1 Safety Report"}'
```

Response (201 on creation, 200 on version add):
```json
{
  "action": "created",
  "document": {
    "id": "doc-id",
    "tenant_id": "tenant-id",
    "title": "Safety Report Q1 2024",
    "external_ref": "REF-2024-001",
    "source_metadata": "{\"source\":\"email\",\"from\":\"vendor@acme.com\"}",
    "current_version": 1,
    "status": "active"
  },
  "version": {
    "id": "version-id",
    "version_number": 1,
    "file_name": "report.pdf",
    "file_size": 524288,
    "mime_type": "application/pdf",
    "checksum": "sha256hex..."
  }
}
```

Required form fields: `file`, `external_ref`, `tenant_id`. Optional: `title` (defaults to filename without extension), `description`, `category`, `tags` (JSON array string), `changeNotes`, `source_metadata` (JSON string).

---

## Document Lookup

### GET /api/documents/lookup

Look up a document by its `external_ref` within a tenant. Returns the document with current version info, or 404 if not found.

```bash
curl "http://localhost:8788/api/documents/lookup?external_ref=REF-2024-001&tenant_id=TENANT_ID" \
  -H "X-API-Key: dox_sk_abc123def456..."
```

Response (200):
```json
{
  "document": {
    "id": "doc-id",
    "title": "Safety Report Q1 2024",
    "external_ref": "REF-2024-001",
    "current_version": 2
  },
  "currentVersion": {
    "id": "version-id",
    "version_number": 2,
    "file_name": "report-v2.pdf"
  }
}
```

---

## Password Management

### Forgot Password (Self-Service)

`POST /api/auth/forgot-password` sends a password reset email with a one-time token (1 hour expiry). Always returns the same success message regardless of whether the email exists (prevents enumeration). Rate limited to 3 attempts per 15 minutes per IP.

```bash
curl -X POST http://localhost:8788/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com"}'
```

### Reset Password (with Token)

`POST /api/auth/reset-password` completes a password reset using the emailed token. Validates password complexity, updates the password, and revokes all existing sessions.

```bash
curl -X POST http://localhost:8788/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"hex-token-from-email","newPassword":"NewSecure1"}'
```

### Admin Password Reset

`POST /api/users/:id/reset-password` allows admins to reset a user's password. Generates a temporary password, sets `force_password_change = 1`, revokes all sessions, and sends an email notification.

```bash
curl -X POST http://localhost:8788/api/users/USER_ID/reset-password \
  -H "Authorization: Bearer $TOKEN"
```

Response: `{"temporaryPassword":"Ab3$xyzRandomPw","emailSent":true}`

The user must change their password on next login.

### Force Password Change

When `force_password_change = 1` is set on a user (after admin reset or initial invitation), the frontend prompts them to change their password before accessing the app. Use `PUT /api/auth/password` to change it (clears the flag).

---

## Document Preview

The frontend supports inline preview for several file types:

| File Type | Preview Behavior |
|-----------|-----------------|
| PDF (.pdf) | Embedded PDF viewer (iframe) |
| Images (.png, .jpg, .jpeg) | Rendered inline as `<img>` |
| Text (.txt, .log, .md) | Displayed as plain text in a code block |
| CSV (.csv) | Displayed as a formatted table |
| Office (.doc, .docx, .xls, .xlsx) | Download card (no inline preview) |

Preview is accessed via the document detail page. The download endpoint (`GET /api/documents/:id/download`) streams the file with appropriate `Content-Type` and `Content-Disposition` headers. For inline preview, the frontend requests the file with `?token=JWT` as a query parameter (since iframe/img tags cannot set Authorization headers).

---

## Supplier Request Arrivals

A supplier answers a document request through a no-login link (`/r/:token`). Each file they send is an **arrival**: it is stored, put on the extraction queue, and claimed against one or more requirements on the request. A claim moves the requirement to `received`, never to `accepted`. These endpoints are the staff side: see what arrived, and decide what it satisfies (migration 0104).

Two separate judgements, on two screens:

1. **Review Queue approval** — "is the extraction faithful to this file?" Approving fills `request_uploads.document_id`.
2. **Deciding the arrival** — "does this document satisfy what we asked this supplier for?" Only this moves a requirement to `accepted`, and it **requires step 1 first** (409 otherwise). Sending an item back (`needs_attention`) is allowed at any stage.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/request-uploads?pending=1` | any tenant user | The inbox, oldest first. Also `request_id` (any version), `supplier_id`, `queue_id` (the arrival a Review Queue item came from), `limit`, `offset`; `tenant_id` for super_admin. Response includes `pending_total`. |
| `GET /api/request-uploads/:id` | any tenant user | One arrival. Another tenant's id is 404. |
| `GET /api/request-uploads/:id/file` | any tenant user | The bytes. Falls back to the linked document's current version once approval has moved the upload object (`X-File-Source: upload \| document`); 410 if neither exists. |
| `POST /api/request-uploads/:id/decide` | super_admin, org_admin, user | Accept or send back requirements. |
| `POST /api/request-uploads/:id/enqueue` | super_admin, org_admin | Put an unread file (`queue_id` NULL) on the extraction queue. 409 if already queued. |

Arrivals never include the uploader's IP or the storage key.

`pipeline_state` is computed: `not_read` → `extracting` → `extraction_error` → `awaiting_approval` → `rejected_in_queue` → `document_linked`. Each claim is mapped onto the **current** version of the request (amendments re-mint line ids), so `claims[].line_id` is the id to decide with.

### POST /api/request-uploads/:id/decide

```json
{
  "decisions": [
    { "line_id": "<current line id>", "decision": "accepted", "status_note": "Signature checked" },
    { "line_id": "<current line id>", "decision": "needs_attention",
      "attention_reason": "This is the 2023 statement; we need one signed this year." }
  ]
}
```

- `document_id` (accept only) defaults to the arrival's document; it may name any active document of the same supplier (a split COA produces several).
- `status_note` is internal. `attention_reason` is what the supplier reads on their link; left blank, the portal composes a sentence from the requirement's criteria.
- Deciding a requirement the supplier did not tick records a **staff claim**.
- Accepting a typed requirement **confirms** its `document_requirements` link: none → inserted `confirmed` with `source: "request_accept"`; `suggested` → `confirmed`. If a person already marked the link `rejected`, the whole decision is refused with 409 and nothing is written.
- The request must be `issued` (409 otherwise). No email is sent to the supplier.
- Audit: `request_line_status_changed` per requirement (same action as `PUT /api/request-lines/:id`, with `via: "arrival"`), `request_upload.decided`, `request_upload.claim_added`, `document_requirement.confirmed_via_request`.

Response: `{ "arrival": RequestArrival, "counts": DocumentRequestLineCounts }`.

`request_lines.accepted_document_id` records which document a requirement stands accepted on. It is cleared when the line moves away from `accepted` (by `PUT /api/request-lines/:id`, which cannot set it) or when the supplier sends a newer file, and it is carried across amendments with the status.

`GET /api/queue` also accepts `?source=request_link` to show only portal arrivals.

---

## Files Received Again (exact duplicates)

Every intake door computes a SHA-256 of the bytes. Before a file becomes a Review Queue card it is compared with what **the same tenant** already holds (migration 0108, `functions/lib/intake/duplicates.ts`, called from `enqueueDocument` so every door shares it):

| The identical file is… | What happens |
|---|---|
| **already approved** (a live document version with that checksum, or an approved queue item — which covers page-scoped sublot documents and order/shipment approvals) | No card. An `intake_duplicates` row (`match_kind: "already_approved"`) links the arrival to that document. Audit `intake.duplicate_suppressed`. |
| **already waiting** in the Review Queue (`status: pending`, any processing state) | No second card. Row `already_waiting` against that queue item; the card shows "also received from …". |
| **rejected** before | Queued normally. The card shows "this exact file was rejected on … for …" (`intake_history.previously_rejected`). Audit `intake.previously_rejected_file`. |

Byte-identical only: a re-scan of the same paper is a different file and is reviewed like any other. Nothing is deleted or rejected; the stored file stays and **Review anyway** puts it in the queue.

What each door returns for a suppressed file:

- `POST /api/documents/process` — the item has `id: ""` and `intake_duplicate: { intake_duplicate_id, match_kind, matched_document_id, matched_queue_id }` (plus the older `duplicate` object naming the document). A queued item identical to a rejected one carries `previously_rejected`.
- `POST /api/sources/:id/drop` — still `200` and `queued: true` (the file was received), with `queue_id: null` and `duplicate: { received_again: true, match_kind }`. No document title is returned to a partner. The run header is closed as `success`.
- `POST /api/sources/:id/run`, `POST /api/sources/:id/runs/:runId/retry` — `queue_id: null` and `intake_duplicate`.
- `POST /api/webhooks/connector-email-ingest` — the attachment's item has `queue_id: null` and `intake_duplicate_id`.
- `POST /api/webhooks/email-ingest` — result `status: "duplicate"` (checked before any model runs); the summary email says "Already received".
- Supplier portal upload — **unchanged for the supplier** (200, their items say received). For staff: identical to an approved document → `request_uploads.document_id` is set to it (arrival state `document_linked`, decide it on Arrivals as usual; no requirement is accepted by this); identical to a waiting item → `request_uploads.queue_id` points at that item, and every arrival on it is linked when it is approved.
- `POST /api/request-uploads/:id/enqueue` — response adds `intake_duplicate` (null when queued); 409 when the arrival is already linked to a document.
- The S3 poller counts suppressed files in `received_again` per connector.

**`POST /api/documents/ingest` is not checked.** It is not a Review Queue door: it creates a document or adds a version to the one named by `external_ref`, and its caller relies on that upsert returning a document. Sending identical bytes twice still adds a version, exactly as before.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/intake-duplicates` | any tenant user | `state=open\|reviewed\|all` (default all), `document_id` (the document page's "Received again" list — includes arrivals matched to the queue item the document was approved from), `matched_queue_id`, `limit` (≤200), `offset`; `tenant_id` for super_admin (omitted = all tenants). Response: `{ duplicates, total, open_count, limit, offset }`. |
| `POST /api/intake-duplicates/:id/review` | super_admin, org_admin, user | **Review anyway.** Replays the door's enqueue with the check skipped, stamps `queue_id`/`overridden_by`/`overridden_at`, audits `intake_duplicate.review_anyway`. For a portal arrival, points `request_uploads.queue_id` at the new item and clears the document link only if no claim on it has been decided. 409 if already sent; 410 if the stored file is gone. Response: `{ duplicate, queue_id }`. |

`GET /api/queue` and `GET /api/queue/:id` add `intake_history` to each item: `also_received[]`, `previously_rejected`, `identical_documents[]` (pending items only), and `sent_anyway` (set on a card created by Review anyway).

Existing surplus copies are reported (never changed) by `bin/audit-duplicate-documents [--tenant <id>] [--remote] [--json]`.

---

## Out-of-Spec Register

`document_spec_checks` holds every judged COA test result: the verdict (`in_spec` / `out_of_spec` / `not_checked`), the limit it was judged against (frozen in `limit_snapshot`), and who acknowledged it. The Out of Spec page (`/spec-alerts`) reads it.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/spec-checks` | any tenant user | List rows. `verdict` (default `out_of_spec`; `all` for everything), `acknowledged` (`0`/`1`), `origin` (see below), `document_id`, `supplier_id`, `spec_test_id`, `since`, `limit` (max 200), `offset`; `tenant_id` for super_admin. |
| `POST /api/spec-checks` | any tenant user | `{ "ids": [...], "note": "..." }`. Acknowledge results. It never changes a verdict. |

**Who judged it.** Rows have two producers, and each row says which one wrote it:

- `judgement_origin: "approval"`: a reviewer approved the document with this result showing (migration 0103).
- `judgement_origin: "bulk_recheck"`: `bin/backfill-spec-register` computed it over approved history. `bulk_run_at` is that pass's timestamp. Nobody reviewed the result at approval, and nobody was emailed.

`?origin=approval` or `?origin=bulk_recheck` narrows the list. The default, `all`, returns both. Any other value returns 400. Acknowledgement works the same on both kinds, and it never changes the origin.

**Which result.** `result_location` (migration 0105) says where on the certificate the result was printed, for example `"Table 1, row 3 (26141R)"`. `result_key` is the same location as a machine key. A certificate that covers several lots lists the same test once per lot, so two rows with equal test, value and verdict are separate results when their locations differ. Rows written before 0105 have NULL here until `bin/backfill-spec-register --stamp-identity` fills them.

---

## Renewal Alert Lead Time

How many days before a document is due its owner is emailed (migration 0111). Clients differ: some want three months to chase suppliers, others one month so suppliers are not chased about something that cannot be renewed yet.

The lead time is resolved **per document**, most specific first:

1. `document_types.renewal_alert_lead_days`: the type's override (source `document_type`)
2. `tenants.renewal_alert_lead_days`: the organization's setting (source `tenant`)
3. 60 days (source `default`)

A document is alerting when `days_until <= alert_lead_days`, or when it is already overdue or expired. The scheduled run (`POST /api/expirations/run-scheduled`) and the manual button (`POST /api/expirations/notify`) both work this way. Neither accepts a window any more. A `window_days` sent to either is ignored and reported as `window_days_ignored: true`. Each digest document in the response (`groups[].documents[]`, `unrouted.documents[]`) carries `alert_lead_days` and `alert_lead_source`, and the email row says "warned 90 days ahead (document type)".

The dashboard (`GET /api/expirations`) look-ahead `window_days` is a view filter. It defaults to the organization's lead time. Each row has `status` (judged against the look-ahead) and `alert_status` (judged against its own lead time, which is what gets mailed).

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/expirations/lead-time` | super_admin (`tenant_id`), org_admin | The setting, its effective value, presets (30/60/90), who changed it and when, and the document types that override it. |
| `PUT /api/expirations/lead-time` | super_admin (`tenant_id`), org_admin | `{ "lead_days": 90 }`, or `null` for the default. Whole number 7-365. Stamps who and when, and audits `renewal_alert_lead_time_updated` with the previous value. A no-op save writes nothing. |
| `GET /api/expirations/lead-time/preview?lead_days=90` | super_admin, org_admin | Read-only. Counts what the change would do at the next run: `newly_entering_count`, `newly_entering_would_send_count` (re-alert cooldown applied), `leaving_count`, and up to 25 documents each way. Add `document_type_id` to preview a type override. Use `lead_days=inherit` to preview clearing it. |
| `PUT /api/document-types/:id` | super_admin, org_admin | `{ "renewal_alert_lead_days": 30 }` or `null` to inherit. Also accepted on `POST /api/document-types`. A change audits `document_type.renewal_alert_lead_time_updated`. |

**Changing the lead time does not re-send.** The re-alert ledger (`renewal_alert_state`) is keyed on the document and does not store a lead time. Lengthening the lead time adds documents to the alert set. Those never alerted get a first email, and the preview counts them before you save. Those alerted within the last 7 days stay quiet. Shortening it only removes documents. A lead time moves a document only between `current` and `expiring`, so it cannot trigger an escalation that skips the cooldown.

---

## Spec Gaps — what was NOT judged

`document_spec_gaps` (migration 0109) is the other half of the register. A register of passes and failures alone would imply everything absent from it was fine, so what could not be judged is recorded too — in its own table, because a gap has no value, no limit and nothing to acknowledge.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/spec-gaps` | any tenant user | `kind` (`all` default, `missing_required`, `unjudged`), `document_id`, `supplier_id`, `limit` (max 500), `offset`. Returns `{ specGaps, total, limit, offset }`. |

- `missing_required` — an analyte this supplier's certificates of this type MUST report (a watch set through `/api/spec-required-analytes`) that this certificate did not report. **A COA is complete by default**; only a watch makes one incomplete.
- `unjudged` — a printed result with no limit in scope and no printed specification.

Read-only. Rows are written at approval and replaced on re-approval: an unjudged result is resolved by configuring a limit, a missing analyte by the supplier sending one.

---

## Product Identifiers

What one of OUR products goes by (migration 0107), and who said so. One row per identifier: `our_sku`, `supplier_item`, `supplier_name`, `alias`, `gtin` or `pack`, each with `source`, `confirmed`, `superseded` (a former number) and its evidence in `note`. Since migration 0113 this is the ONLY store of supplier-side product identity — `GET/PUT /api/product-map` is removed.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/products/:id/identifiers` | any tenant user | `{ identifiers }` for one product. |
| `POST /api/products/:id/identifiers` | org_admin, super_admin | `{ kind, value, supplier_id?, confirmed?, superseded?, note? }`. Written `confirmed: true, source: 'reviewer'` unless the body says otherwise. 201 when created, 200 with `created: false` when it already existed. Audited. |
| `PUT /api/product-identifiers/:id` | org_admin, super_admin | `{ confirmed?, superseded?, note? }`. Audited. |
| `DELETE /api/product-identifiers/:id` | org_admin, super_admin | Removes it. The `product_identifier.removed` audit row carries the whole row, since nothing else keeps it. |
| `GET /api/suppliers/:id/product-identifiers` | any tenant user | The supplier-side view: this supplier's identifiers with our product for each, plus the certificate products that resolve to nothing and why. `?coa_product=&item=` returns a single `resolution`. |

The value, kind and supplier of an identifier are its **identity** and are not editable — a wrong number is removed and the right one added, so the audit log shows both. Uniqueness is per product, not per tenant: two products claiming one number is an ambiguity search must SHOW, not one the schema may hide. Anything reached through an unconfirmed identifier is reported as `likely` ("confirm"), never covering.

---

## Approved Items, Facilities, Customer Contacts and COA Requirements

Migration 0135. **None of this changes a verdict**: no gap, renewal alert, search answer or order send reads it in order to decide anything. Approval, facility and a customer's requirements are recorded and shown; the order review gains a pre-filled address list and a warning.

### Approved items

`GET /api/approved-items` — any role in the organization. One row per **item-and-supplier pair**.

| Query | Meaning |
|-------|---------|
| `supplier_id`, `product_id`, `facility_id` | one supplier / item / facility |
| `approval` | `approved` \| `pending` \| `not_approved` |
| `supplied` | `1` = currently supplied, `0` = no longer supplied |
| `q` | item, supplier, brand owner, producer, facility, or any identifier of the item |
| `limit` (100, max 500), `offset` | paging |
| `tenant_id` | super_admin only (required for them) |

```json
{
  "items": [{
    "link_id": "ps_1", "product_id": "p_1", "product_name": "Whole Milk", "product_active": true,
    "our_sku": "30417", "supplier_id": "s_1", "supplier_name": "Acme Creamery",
    "facility": { "id": "f_1", "name": "Lynden Plant", "plant_code": "53-104", "active": true },
    "approval_status": "approved", "approval_source": "initial",
    "approval_decided_at": null, "approval_decided_by": null, "approval_decided_by_name": null, "approval_note": null,
    "supplied": true, "discontinued_at": null, "link_source": "import",
    "brand_owner": "Northwind Foods", "producer": "Acme Creamery", "plant_code": null, "private_label": true
  }],
  "total": 1, "counts": { "approved": 1, "pending": 0, "not_approved": 0 }, "limit": 100, "offset": 0
}
```

- **Approval is not "supplied".** `approval_status` and `supplied` are separate facts; both are always returned.
- `approval_source`: `initial` = on file when approvals were introduced (nobody decided it), `person`, `import` (the verified supplier list), or `null` = nothing said yet (a new pair is `pending` with no source).
- `link_id: null` = the pair exists only through the legacy `products.supplier_id` column and was made after 0135; it reads `pending`.
- `private_label` = brand owner and producer both recorded and different, ignoring case and spaces. A display flag: nothing is blocked by it.
- `counts` ignore the `approval` filter, so a screen can count each status for the rest of what was asked.
- `facility: null` = no facility recorded; the item counts toward the whole supplier.

Deciding an approval or naming a facility is `PUT /api/suppliers/:id/products/:productId` (org_admin, super_admin):

| Field | Meaning |
|-------|---------|
| `approval_status` (+ `approval_note`) | `approved` / `pending` / `not_approved`. **`not_approved` needs a note** (400, and nothing else in the request is applied). Stamped `approval_source: "person"` with who and when; the supplier list never overrides it. Audited `product_supplier.approval_decided` with the previous state. |
| `facility_id` | One of this supplier's facilities that is in use, or `null`. 400 for another supplier's or a retired one. Audited `product_supplier.facility_set`. |
| `discontinued`, `nothing_owed_reason` | As before (0123). |

`GET /api/products?supplier_id=` rows also carry `link_approval_status` / `_source` / `_note` / `_decided_at` and `link_facility_id` / `link_facility_name` for that supplier's link (null on a legacy-only link).

**The supplier list sets approval.** `POST /api/supplier-list/import`: when a row's product is found in the catalog, its `Approved (Y/N)` value is that item's approval from that supplier. The response's `approvals[]` has one entry per pair — `lines`, `supplier_name`, `product_label`, `listed`, `current`, `current_source`, and `action`: `set` (written; on a dry run, would be), `unchanged`, `kept_person` (a person decided otherwise; not overridden), `unresolved` (the product is not in the catalog, so there is no pair to approve), `conflict` (the list's own rows disagree; nothing changed) — and `counts.approvals_set` / `_unchanged` / `_kept_person_set` / `_unresolved` / `_conflicting`. A dry run writes none of it.

### Facilities

A facility is a named record under a supplier that **a person adds**. Nothing infers one from a certificate. `plant_code` is recorded, never matched on.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/suppliers/:id/facilities` | any tenant user | `{ supplier, facilities[] }`; each facility has `item_count`. |
| `POST /api/suppliers/:id/facilities` | org_admin, super_admin | `{ name, plant_code?, notes? }`. 409 when the supplier already has a facility of that name (case and spacing ignored). Audited `supplier.facility_added`. |
| `PUT /api/suppliers/:id/facilities/:facilityId` | org_admin, super_admin | Any of `name`, `plant_code`, `notes`, `active`. `active: false` retires it: items that name it keep it, no new item can take it. Audited `supplier.facility_updated` (no row for a save that changes nothing). |
| `DELETE /api/suppliers/:id/facilities/:facilityId` | org_admin, super_admin | Removes it. Items that named it go back to no facility recorded (`cleared_items` in the response, their ids in the audit row); no item is removed. Audited `supplier.facility_removed`. |

A supplier merge moves the loser's facilities to the winner; one both have is kept once and its items re-pointed.

### Customer contacts

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/customers/:id/contacts` | any tenant user | `{ customer: { id, name, email }, contacts[] }`. Each contact: `name`, `email`, `role`, `is_primary`, `coa_recipient`. |
| `POST /api/customers/:id/contacts` | org_admin, super_admin | `{ email, name?, role?, is_primary?, coa_recipient? }`. `coa_recipient` defaults true for a contact added here (a contact the order connector wrote is false until edited); the first contact is the primary unless told otherwise. 409 for an address the customer already has. Audited `customer.contact_added`. |
| `PUT /api/customers/:id/contacts/:contactId` | org_admin, super_admin | Naming a new primary steps the previous one down. Audited `customer.contact_updated` with both sides. |
| `DELETE /api/customers/:id/contacts/:contactId` | org_admin, super_admin | A COA requirement that named it keeps its other details and has no delivery contact. Audited `customer.contact_removed`. |

### Customer COA requirements by item

One row per customer and item.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/customers/:id/item-requirements` | any tenant user | `{ customer, requirements[] }`. |
| `POST /api/customers/:id/item-requirements` | org_admin, super_admin | `{ product_id, coa_required?, must_show?, timing?, delivery_contact_id?, notes? }`. `coa_required` is `yes` (default) / `no` / `on_request`. 409 when the customer already has a requirement for that item. Audited `customer.item_requirement_added`. |
| `PUT /api/customers/:id/item-requirements/:requirementId` | org_admin, super_admin | Any field except `product_id` (another item is another row). Audited `customer.item_requirement_updated`. |
| `DELETE /api/customers/:id/item-requirements/:requirementId` | org_admin, super_admin | Audited `customer.item_requirement_removed` with the whole row. |

### What the order review reads

`GET /api/orders/:id/send-preview` gains, beside `recipient` (still the customer's own address):

- `recipients[]` — the addresses to pre-fill: the customer's contacts with `coa_recipient`, primary first, then any delivery contact named by a requirement for an item on this order; capped at 10. With no such contact, `[customers.email]`. `recipient_source` is `coa_contacts` / `customer_email` / `none`; `recipients_over_cap` counts what the cap left off (also said in `warnings`).
- `item_requirements[]` — per line whose item has a requirement: `order_item_id`, `product_name`, `lot_label`, `coa_required`, `must_show`, `timing`, `summary` ("COA required - must show … - with the shipment"), `delivery_contact`, `document_on_line`, and `missing` (required, and that line sends nothing).

A `missing` requirement adds one line to `warnings`. **It never sets `blocked`**, and none of this is part of the `fingerprint`, which covers what leaves. `POST /api/orders/:id/send` with no `recipients` uses the same default.

## Supplier Contacts and the Supplier Renewal Send

Migration 0133. **The portal never emails a supplier on its own.** The renewal run (`POST /api/expirations/run-scheduled`, `POST /api/expirations/notify`) only **drafts** a request to the supplier's document contact; one approval by a person sends it. Both run responses carry `supplier_requests` (what was drafted, superseded, ended, escalated, and what could not be drafted and why).

### Contacts

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/suppliers/:id/contacts` | any tenant user | `{ supplier, contacts[], document_contact }`. `document_contact` is the one address renewal requests go to, or `null`. |
| `POST /api/suppliers/:id/contacts` | org_admin, super_admin | `{ email, name?, role?, priority?, is_document_contact? }`. The first contact becomes the document contact unless told otherwise. 409 when the supplier already has that address (case-insensitive). Audited `supplier.contact_added`. |
| `PUT /api/suppliers/:id/contacts/:contactId` | org_admin, super_admin | Any of `name`, `email`, `role`, `priority`, `is_document_contact`, `active`. Naming a new document contact demotes the previous one in the same write. Audited `supplier.contact_updated` with both sides and who was replaced. |
| `DELETE /api/suppliers/:id/contacts/:contactId` | org_admin, super_admin | Audited `supplier.contact_removed` with the whole row. |

A supplier has **at most one** active document contact. Removing or deactivating it leaves none: nothing is promoted in its place, and drafting for that supplier stops until one is chosen. Adding a contact sends nothing.

The verified supplier list (`POST /api/supplier-list/import`) writes its `Supplier contact email` column to contacts on apply and reports `counts.contacts_added` on a dry run. An address already on file is never changed.

### The ladder

A request is drafted when a document with a supplier enters its alert window (the same lead time as the internal alert), on the day of expiry, and 7 and 14 days after. A newer stage supersedes an unapproved older one, so at most one draft is waiting and at most four messages reach a supplier per cycle. At 21 days past due with no replacement accepted the cycle is `escalated`: nothing further is drafted and the organization's admins (and master user) are told once. A changed due date, an archived document, or a replacement accepted against the request ends the cycle.

### Requests

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/renewal-requests` | any tenant user (`tenant_id` for super_admin) | `{ requests[], not_drafted, link_block_preview, email_configured, escalate_after_days }`. Each request has its `sends[]` (stage, status, the draft, the approver, and for a sent stage the exact `sent_subject` / `sent_body`), the current `contact`, `waiting_send_id`, and `can_approve` for the caller. `not_drafted` lists alerting documents with `no_supplier`, `no_contact`, or `past_escalation`. |
| `POST /api/renewal-requests/:id/sends/:sendId/approve` | the assigned approver, org_admin, super_admin | `{ subject, body }` - the draft as edited. Issues one document request for the expiring document on the first approval of a cycle (as the approving person), then emails the supplier from "<Organization> via SupDox" with reply-to the approver and the system's link block appended. Audited `renewal_request.sent` with the exact text. |
| `POST /api/renewal-requests/:id/sends/:sendId/skip` | the assigned approver, org_admin, super_admin | Sends nothing for this stage. The cycle stays open; the next stage is still drafted. Audited `renewal_request.skipped`. |
| `GET /api/expirations/default-owner` | org_admin, super_admin (`tenant_id`) | The master user and the active users who can be chosen. `resolves: false` when the stored user is no longer active. |
| `PUT /api/expirations/default-owner` | org_admin, super_admin | `{ "user_id": "..." }` or `null`. Must be an active user of the organization. Audited `renewal_default_owner_updated`. |

**Approver.** The first active portal user on the record's owner route; otherwise the master user; otherwise any org_admin (`approver_user_id: null`).

**Approve responses.** `200 { sent: true, request }`. `409` the draft is no longer waiting (sent, skipped, superseded, cancelled) or the supplier has no document contact (`code: no_document_contact`). `503` `code: email_not_configured` - nothing sent, the draft keeps waiting. `502` `code: send_failed` - the provider refused it; the stage is `failed` with the reason and can be approved again. `403` the caller is neither the approver nor an admin.

The body is a fixed template filled only from supplier-facing text (organization name, contact name, the request line names, the due date). The link block is not part of `body` and cannot be supplied or removed.

### Changing a renewal date after approval

`PUT /api/documents/:id` with a different `renewal_due_date` records a decision: `renewal_decision` becomes `overridden` (or `cleared` when the date is set to `null`, which means "does not renew"), `renewal_decided_at/_by` are stamped, and `{ previous_due_date, new_due_date, decision, reason, decided_by, decided_at }` is appended to `renewal_snapshot.post_approval_edits` - the approval-time snapshot fields are kept. Send `renewal_reason` with it. Audited `document.renewal_decided` with `via: "document_edit"`. An unchanged value records nothing.

## Declared Lot Formats

Each supplier's lot format is **declared data** (migration 0110), never a global regex: a pattern that silently mis-parses another supplier's lot is worse than no parser.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/suppliers/:id/lot-scheme` | any tenant user | Every declared version, the one in force, and a read-only preview of how this supplier's stored lots read against it. With no declaration the legacy `suppliers.lot_scheme` enum is mapped onto an equivalent spec. |
| `PUT /api/suppliers/:id/lot-scheme` | org_admin, super_admin | `{ spec, note? }`. Validated before anything is written; a declaration that cannot mean one thing (a Julian day with no year, a date segment with no role) is refused 400. Appends a **new version** — nothing is updated in place, so a stored decode stays explainable. Re-saving the format in force writes nothing and returns `unchanged: true`. Audited `supplier.lot_scheme_declared` with the previous spec and the fit counts. |

`spec.kind = 'none'` is a declaration ("this supplier's lot codes encode nothing"), distinct from having no row at all.

**A declaration is a validator and a labelled fallback, never an authority.** Saving one rewrites no stored lot key and no stored date. It flags Review Queue invariants, fills `lots.production_date` only when nothing was stated (as `production_date_source = 'lot_decode'`), and makes search read a decoded date as *likely — confirm*. Stored keys a format would store differently are reported by `bin/report-lot-key-scheme`, which applies nothing.

---

## Verified Supplier List Import

What a supplier owes, derived from the client's verified supplier list instead of one uniform guess (migration 0112). The rules live in `shared/requirementDerivation.ts` and are reached through exactly one door, so a spreadsheet and a future webhook cannot produce different requirements for the same supplier.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `POST /api/supplier-list/import` | super_admin, org_admin | Exactly one list source: `csv`, `xlsx_base64` (first sheet), `rows`, or `rerun_of` (an earlier applied run, whose stored input is re-run). Plus `dry_run` (**default true**), `file_name`, `pack`, `tenant_id` (super_admin). 200 on a dry run, 201 on an apply. |
| `GET /api/supplier-list/imports` | super_admin, org_admin | Applied runs, newest first (`{ imports }`). A dry run is not a run and never appears. |
| `GET /api/supplier-list/imports/:id` | super_admin, org_admin | One run with its per-row outcomes (`{ import }`). |

**`dry_run` defaults to true and writes nothing at all** — not even a run row. A caller has to say it means to write. The response is the same shape either way, so the reviewer reads one report.

Applying creates missing suppliers, writes derived rows with their provenance, **adopts** rows nobody had attributed (never lowering their tier — a lower derived tier is left for a person), and **flags** derived rows the list no longer implies rather than deleting them. A row a human or a packet wrote is never touched. A requirement slug the tenant does not hold is reported, never invented. An applied import also records each matched product as supplied by its supplier (`product_suppliers.source = 'import'`), so per-product requirements judge it.

---

## Requirement Scope — per supplier, per product, per lot

What a requirement is owed PER (migration 0123). `requirements.scope` is `supplier` (default — closed once by any confirmed document), `product` or `lot`; validated in code (`shared/requirementScope.ts`), no SQL CHECK. `supplier_requirements` stays the one attach point: attaching a per-product requirement to a supplier means "owed for every **active** product of that supplier" (linked through `product_suppliers` or the legacy `products.supplier_id`, `products.active = 1`, not marked no longer supplied).

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `POST /api/requirements`, `PUT /api/requirements/:id` | super_admin, org_admin | Accept `scope`. A change writes `requirement.scope_changed` with `{from, to}`. |
| `GET /api/requirements/:id/scope-preview?scope=` | super_admin, org_admin | Read-only: per supplier, status before/after, product obligations created, confirmed documents that would stop counting. |
| `GET/POST /api/product-requirements`, `PUT/DELETE /api/product-requirements/:id` | read: any role; write: super_admin, org_admin | `exempt` one product from an inherited per-product requirement (**reason required**) or `add` one to one product. Only for a `product`-scope requirement and a product the supplier ships. |
| `PUT /api/suppliers/:id/products/:productId` | super_admin, org_admin | `{ discontinued }` (no longer supplied) and `{ nothing_owed_reason }` (declared: owes nothing per product; reason required, null clears). Since 0135 also `{ approval_status, approval_note }` and `{ facility_id }` -- see "Approved Items, Facilities, Customer Contacts and COA Requirements". |

Rules the gap engine keeps (`GET /api/supplier-gaps`):

- A (requirement, product) pair is closed only by a confirmed document **linked to that product** (`document_products`). A confirmed document linked to no product closes **nothing** — it is listed under `unattributed`, never read as "every product".
- Zero active products is **open** (`gap_reason: no_products`), never a vacuous pass.
- Inactive / no-longer-supplied products are named in a `products_excluded` caveat; a product created from a certificate's name with no confirmed identifier raises `possible_duplicate_products`.
- **Gated:** a supplier with no per-product requirement (and no `add` row) is judged exactly as before; its `products` entries say `not_checked`. Once product scope is in use, a product with nothing applying and no declaration is `not_configured`, and the supplier reads `products_not_configured` (amber) rather than `satisfied`.
- A claim about one product (`document_claims.subject_type = 'product'`) opens a per-product requirement for that product only; a facility claim applies supplier-wide with a caveat.
- `lot` scope is stored but judged once per supplier until per-lot checking ships (`lot_evaluation: supplier_level`, caveat `lot_scope_not_evaluated`).

The request composer's line closure reads the same closures (`loadConfirmedClosures`), so a per-product ask is never shown as closed by a document that names no product. Existing tenants: `bin/propose-requirement-scopes --tenant <id>` (dry run default) proposes the starter pack's scopes for rows still at the default with no audit row naming a scope.

---

## Agentic Integration

The document portal supports an email-to-agent-to-portal pipeline for automated document ingestion. Here is the typical flow:

1. **Email arrives** at a monitored mailbox with a document attachment.
2. **Agent processes the email** — extracts the attachment, determines the `external_ref` (e.g., message ID or a reference number from the subject line), and collects metadata.
3. **Agent calls the ingest endpoint** to upsert the document into the portal.

### Example: Full Agentic Workflow

```bash
# Step 1: Create an API key for the agent (one-time setup)
API_KEY=$(curl -s -X POST https://supdox.com/api/api-keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"Email Agent"}' | jq -r '.key')

# Step 2: Agent ingests a document from an email
curl -X POST https://supdox.com/api/documents/ingest \
  -H "X-API-Key: $API_KEY" \
  -F "file=@/tmp/attachment.pdf" \
  -F "external_ref=msg-id-12345@mail.example.com" \
  -F "tenant_id=TENANT_ID" \
  -F "title=Safety Report from vendor@acme.com" \
  -F "category=regulatory" \
  -F 'tags=["email-ingested","safety"]' \
  -F "changeNotes=Received via email on 2026-03-24" \
  -F 'source_metadata={"source":"email","from":"vendor@acme.com","subject":"Updated Safety Report","received_at":"2026-03-24T12:00:00Z"}'

# Step 3: Agent checks if a document already exists before deciding what to do
curl -s "https://supdox.com/api/documents/lookup?external_ref=msg-id-12345@mail.example.com&tenant_id=TENANT_ID" \
  -H "X-API-Key: $API_KEY"
```

The ingest endpoint handles the create-vs-update decision automatically via `external_ref`, so agents can call it idempotently without first checking for existence.

---

## GraphQL API

The GraphQL endpoint is at `POST /api/graphql`. A GraphiQL IDE is available at `GET /api/graphql` in the browser.

Authentication works the same way: pass the JWT in the `Authorization: Bearer <token>` header.

### Example Queries

```graphql
# Get current user
query {
  me {
    id
    email
    name
    role
    tenant {
      name
      slug
    }
  }
}

# List documents
query {
  documents(status: ACTIVE, limit: 10) {
    id
    title
    category
    currentVersion
    createdBy {
      name
    }
    versions {
      versionNumber
      fileName
      fileSize
    }
  }
}

# Search documents
query {
  searchDocuments(query: "safety", category: "regulatory", limit: 20) {
    total
    documents {
      id
      title
      tags
    }
  }
}

# Get audit log
query {
  auditLog(action: "document_created", limit: 10) {
    total
    entries {
      action
      user { name }
      resourceType
      resourceId
      details
      createdAt
    }
  }
}
```

### Example Mutations

```graphql
# Login
mutation {
  login(email: "admin@example.com", password: "AdminPass1") {
    token
    user {
      id
      name
      role
    }
  }
}

# Create a tenant
mutation {
  createTenant(name: "Acme Corp", description: "Manufacturing") {
    id
    name
    slug
  }
}

# Create a user
mutation {
  createUser(
    email: "jane@acme.com"
    name: "Jane Doe"
    password: "Welcome123"
    role: USER
    tenantId: "tenant-id"
  ) {
    id
    email
    role
  }
}

# Create a document
mutation {
  createDocument(
    title: "Safety Data Sheet"
    category: "regulatory"
    tags: ["safety", "osha"]
    tenantId: "tenant-id"
  ) {
    id
    title
    currentVersion
  }
}

# Update a document
mutation {
  updateDocument(id: "doc-id", status: ARCHIVED) {
    id
    status
  }
}

# Generate a report
mutation {
  generateReport(category: "regulatory", dateFrom: "2024-01-01") {
    total
    data {
      title
      category
      currentVersion
      fileName
    }
  }
}

# Admin password reset
mutation {
  resetUserPassword(id: "user-id") {
    temporaryPassword
    emailSent
  }
}
```

### GraphQL Types

The schema defines: `Tenant`, `User`, `Document`, `DocumentVersion`, `AuditEntry`, `AuthPayload`, `ReportRow`, `SearchResult`, `AuditResult`, `ResetPasswordResult`.

Enums: `Role` (SUPER_ADMIN, ORG_ADMIN, USER, READER), `DocumentStatus` (ACTIVE, ARCHIVED, DELETED).

### GraphQL Errors

GraphQL answers the same condition the same way REST does. The five deliberate,
caller-facing errors pass through with their own message plus a code and a
matching HTTP status:

| Thrown | `extensions.code` | Status |
|---|---|---|
| `UnauthorizedError` | `UNAUTHENTICATED` | 401 |
| `ForbiddenError` | `FORBIDDEN` | 403 |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `BadRequestError` | `BAD_REQUEST` | 400 |
| `ConflictError` | `CONFLICT` | 409 |

A module refusal keeps the `module_disabled` / `module_not_visible` code the
REST gate uses.

**Everything else is masked.** A D1 failure, a `TypeError`, a resolver bug all
return `Unexpected error.` with code `INTERNAL_SERVER_ERROR` and nothing of the
original message, stack or extensions. The allow-list is the point: it is
exactly the list `errorToResponse` answers on the REST side
(`functions/lib/graphql/errors.ts`).

Before this, every one of the five came back as `Unexpected error.`, which
reads as our fault and invites a retry that can never succeed — and erases the
difference between "that does not exist" and "that is not yours".

---

## Document Versioning

Documents use a two-step creation process:

1. **Create document** (`POST /api/documents`) — creates metadata with `current_version = 0`.
2. **Upload file** (`POST /api/documents/:id/upload`) — creates a version record and stores the file.

Each upload increments the version number. All versions are retained; you can download any past version by specifying `?version=N`.

### R2 Storage Layout

Files are stored in R2 with the key format:

```
{tenant_slug}/{document_id}/{version_number}/{file_name}
```

Example: `acme-corp/abc123def456/3/safety-data-sheet-v3.pdf`

This structure ensures:
- Tenant isolation at the storage level
- All versions of a document are grouped together
- Easy to identify files by their path

### Checksums

SHA-256 checksums are computed on upload and stored in the `document_versions` table. The checksum is also returned as an `ETag` header on download. Intake compares them to recognise a file that arrives again (see [Files Received Again](#files-received-again-exact-duplicates)).

---

## Audit Trail

Every significant action is logged to the `audit_log` table with:
- Who performed the action (`user_id`)
- Which tenant was affected (`tenant_id`)
- What action was performed (`action`)
- What resource was affected (`resource_type`, `resource_id`)
- Change details as JSON (`details`) — includes before/after diffs for updates
- Client IP address

The audit log is append-only and cannot be modified through the API.

---

## Email Notifications

Emails are sent via the [Resend](https://resend.com) API when `RESEND_API_KEY` is configured. Three email types:

1. **Invitation email** — sent when a new user is registered via `POST /api/auth/register`. Contains login credentials and a sign-in link.
2. **Password reset email** — sent when `POST /api/auth/forgot-password` is called. Contains a one-time reset link (1 hour expiry).
3. **Admin reset email** — sent when an admin resets a user's password via `POST /api/users/:id/reset-password`. Contains the temporary password.

All emails are sent from `noreply@supdox.com`.

### A document that arrives by email: who is told

Two mails follow an emailed-in document: the ingest summary (`POST /api/webhooks/email-ingest`) and
"Review Needed" (when the worker posts results for an item whose `source` is `email`). **Neither is
sent to the sender unless the sender's address is an active user of the tenant the document landed
in.** The sender of inbound mail is usually a supplier, and nothing in the portal mails a supplier
without a person deciding to.

| Sender | Who is mailed |
|---|---|
| an active user of that tenant | the sender (summary / "Review Needed", link to the Review Queue) |
| anyone else — a supplier, an inactive account, a user of another tenant | the tenant's org_admins: "N document(s) arrived by email from `<address>`", which says the address was not answered |
| anyone else, and the tenant has no org_admin | nobody |

Every decision writes an `intake.sender_notice` audit row: `kind` (`ingest_summary` /
`review_needed`), `path` (`sender` / `org_admins` / `nobody`), `sender`, `sender_is_tenant_user`,
`recipients`, `sent`. The Review Queue link is built from the request's own origin. Logic:
`functions/lib/intake/sender-notice.ts`.

---

## File Storage

### Allowed File Types

| MIME Type | Extensions |
|-----------|-----------|
| application/pdf | .pdf |
| application/msword | .doc |
| application/vnd.openxmlformats-officedocument.wordprocessingml.document | .docx |
| application/vnd.ms-excel | .xls |
| application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | .xlsx |
| text/csv | .csv |
| text/plain | .txt, .text, .log, .md |
| image/png | .png |
| image/jpeg | .jpg, .jpeg |

Maximum file size: **100 MB**.

The upload endpoint validates both the MIME type and file extension, rejecting mismatches.

---

## Search

`GET /api/documents/search` provides text search using SQL LIKE queries against:
- `title`
- `description`
- `tags` (JSON string)
- `file_name` (from document_versions, joined)

The search term is wrapped in `%..%` wildcards. Only active documents are returned. The join against `document_versions` means you can search for documents by the name of any file that was uploaded to them.

For more advanced search, use the GraphQL `searchDocuments` query which provides the same functionality with typed parameters.

### Search and the module toggles

`/api/search*` belongs to no module, but orders and customers are the **fulfillment** module's
records. When that module is off for the caller — switched off for the organization, or not among
what the caller's department sees — search leaves them out and says so:

- `GET /api/search`: the `orders` and `customers` blocks are `{ total: 0, results: [] }` and are not read.
- `POST /api/search/query`: a clause on `order` or `customer` is not run and its id is in
  `not_applied`; no WMS order is read to explain a typed number or to follow a customer's PO. A PO or
  invoice is still answered from what the documents themselves print.
- `POST /api/search/interpret`, `POST /api/documents/search/natural` and `GET /api/search/examples`
  read no order either.
- Every one of those responses carries `"modules_not_applied": ["fulfillment"]`.

A caller who has the module gets the response they always got: the key is absent. A super_admin is
never narrowed. The lookup fails open, like every other module check.

### Coverage: covering documents vs. near misses

`GET /api/search` (instant) and `POST /api/documents/search/natural` (AI) answer a *document request* differently from a text search. The rule, from the client's retrieval spec: **a confident wrong answer is worse than a null.**

When a query states something a document must BE, it becomes a **constraint**:

| Typed | Constraint | Checked against |
|---|---|---|
| `1042620303`, `10426203-03`, `lot 10426203 sublot 03` | lot | linked lot records + extracted `lot_number` / `sub_lot_*` |
| `production date 7/31/2026`, `produced 7/22/26`, `packed 9/2` | date, role `production` | `production_date`, `mfg_date`, `pack_date`, ... |
| `code date 03/01/2026` | date, role `code` | `code_date` only |
| `exp 31-Jul-2026`, `best by Jul 31 2026` | date, role `expiration` | `expiration_date`, `document_expires_on`, `renewal_due_date` |
| a bare `2026-07-31` | date, role `any` | any document date (the result says which) |
| a supplier name next to a lot/date | supplier | linked supplier + aliases |
| the words left over | text | the full-text index |

Each document is classified against its **own** fields:

- `covering`: every constraint verified;
- `candidate_not_matching`: nearby, with `match_reason` naming what failed ("The production date on this document is Jul 22, 2026; you asked for production date Jul 31, 2026.");
- `unreviewed_candidate`: a pending Review Queue file (in `unreviewed_candidates`, with `review_url`). Never covering.

The response adds `coverage` (`covered` / `none` / `unconstrained`), `constraints`, `dropped_constraints`, `coverage_summary`, `covering_count`, `candidate_count`, `unreviewed_candidates`. Existing fields are unchanged.

What is deliberately **not** a match: a lot the query only prefixes (`partial_lot`); the same base lot with a different sublot (`near`); a date under a different role (`role_mismatch`: a code date is not a production date); a stored date that reads two ways, like `02/07/2026` (`ambiguous`, unless the same document writes another date whose order is unmistakable); a field holding several dates (`multiple_values`). A typed ambiguous date such as `9/2/2026` is read month/day and the constraint's `note` says so.

The natural-language endpoint never loosens: an unknown document type or an uncomparable filter goes into `dropped_constraints`, and coverage is then `none`. A date phrase typed with a role ("produced 7/31/2026") overrides the model's reading, so a production date is never applied to upload time.

Query-time folding (no index rebuild): simple plurals (`bags` -> `bag`) and `gal/gallon`, `lb/lbs/pound`, `oz/ounce`.

`GET /api/search` parameters: `q` (required), `tenant_id` (super_admin), `limit` (max 200), `offset`, `limit_per_type` (max 25), and `lot` + `sublot` — a lot typed as its own input rather than inside `q`. Given both, the two halves are matched **part against part**: a sublot never matches against a base lot number.

### Getting the documents out (migration 0115)

Search results can be selected and taken out of the portal two ways. Both are
module-gated under `library` and both are audited with the id list.

**`POST /api/document-exports/zip`** — body `{ document_ids, tenant_id? }`.
Streams a ZIP of the CURRENT version of each document plus `manifest.csv`
(file name, document, supplier, document type, lot, production date, version,
filed-on). Tenant isolation is in the SQL, so another tenant's id is *missing*,
never a file in the archive; the missing ids appear in the audit row and in the
`X-Export-Missing` header. Any authenticated user with tenant access may call
it, **reader included** — the same bar as downloading one document at a time.
Refused with 413 over **50 documents** or **40 MB**, with the cap in the
message; an export is never silently truncated. One audit row per export
(`document_export.zip`).

**`POST /api/document-exports/send`** — body `{ document_ids, recipients[],
on_behalf_of?, message?, tenant_id? }`. Sends a **token-gated link, never
attachments**: attachments blow mail size limits and leave no trail. The mail
comes from the portal's own sender with a **reply-to of the calling user**, and
`on_behalf_of` is printed as context ("Dana sent these on behalf of Marco in
Sales") — nothing is sent as a customer's domain. 30 sends per hour per user.
**`user` and above**, unlike the ZIP: minting an unauthenticated URL to up to
50 documents and mailing it outside the organization is publishing, not
reading, so a `reader` is refused 403. If the send fails the link is revoked,
so a live link never exists for a message nobody received. Audited as
`document_export.sent` with the recipients.

The recipient's page is `/export/:token`, reading
`GET /api/document-exports/public/:token` (allow-list projection, no internal
ids), with `…/download` for the ZIP and `…/file/:index` for one file. **`index`
is a POSITION in the link's own frozen list**, not a document id, so a
forwarded link can never be edited into covering something else. Links expire
in 30 days, carry a `revoked_at` kill switch, and every view and download
writes an audit row.

Both routes, and every read of a link, obey the sharing rule below.

### The sharing rule (migration 0137)

Every document carries one answer to "may this leave the organization":

| rule | words on screen | means |
|---|---|---|
| `free` | Send freely | Anyone who can see it may send it. API keys can read it. |
| `qa` | Needs QA approval | Leaves only when QA or an administrator sends it. API keys cannot read it. |
| `locked` | Locked | Never leaves: no ZIP, no link, no order, no API key. |

**Where the answer comes from**, most specific first: the document's own
override; a document with **no type at all** is `locked`; the rule stored on its
document type (`document_types.sharing_rule`); the type's NAME against the
starting table; a name nobody recognises is `qa`.

The starting table: **free** - certificate of analysis, specification sheet,
allergen statement, kosher / halal / organic certificates, safety data sheet.
**qa** - audit certificate, HACCP or food safety plan, letter of guarantee,
insurance. **locked** - audit report, W-9. A new type is given its rule from
this table when it is created and the rule is stored, so an admin can see and
change it.

**What "leaving" is.** A ZIP, an emailed link, a recipient reading a link, a
bundle ZIP, an order send or resend, and ANY file read made with an API key. A
logged-in person opening or downloading one file in the portal is not leaving,
whatever their role and whatever the rule.

**Who may release a `qa` document.** A super admin, an org admin of the
organization, a non-reader user on the `QA` owner route (`/api/owner-routes`),
and - only when that route names nobody usable - the organization's master
user. Never a read-only account. There is no separate approval step: when one
of those people ZIPs or sends a `qa` document themselves, that act is the
approval, and it writes a `document.qa_release_approved` audit row naming them
and the documents. Nobody releases `locked`.

**A refusal is always stated.** No exit drops a document silently:

| exit | when some may go | when none may go |
|---|---|---|
| `POST /api/document-exports/zip` | 200; `manifest.csv` has a "Not included" block; headers `X-Export-Refused: N` and `X-Export-Refused-Ids: id:reason,...` | 403 |
| `POST /api/document-exports/send` | 200; `refused[]` in the body (each with `document_id`, `title`, `rule`, `reason`, `message`); nothing refused is on the link | 403; no link is minted, no mail sent |
| `GET /api/bundles/:id/download` | 200; `NOT-INCLUDED.txt` in the archive; headers `X-Bundle-Refused`, `X-Bundle-Refused-Ids` (and `X-Bundle-Unavailable`, `X-Bundle-Unavailable-Ids` for a file missing from storage; a deleted document is not served) | 403 |
| `GET /api/orders/:id/send-preview`, `POST .../send` | the line is in `lines_not_sent` with `sharing_refusal` and the reason; the order is not marked delivered | preview `blocked.code = nothing_to_send`; send 400 |
| `POST /api/orders/:id/sends/:sendId/resend` | each file is re-checked before its bytes are read, for whoever is pressing resend; a refused file fails its part with the reason | - |
| public link reads | a document locked since the send is not listed or served; `unavailable_count` says how many are gone | 404 on the ZIP |
| single file with an API key (`documents/:id/download`, and `queue/:id/file` / `request-uploads/:id/file` once the item or arrival has become a document) | - | 403 |

Every 403 from the rule has `code: "sharing_rule_refused"` and, for the multi
document exits, `refused[]`; the `error` sentence names each document under its
reason.

**One file, several documents.** A packet original and a whole multi-lot
certificate take the strictest rule of every document on them, including lots
that are not on the order. When the whole certificate may not go, the order
sends each lot's own page instead and the review screen says so.

**A link already sent.** The rule is re-read on every read of a public export
link, on the authority of the person who minted it. A `qa` document is served
only while that person can still release QA documents: a link an ordinary user
sent while the document was "send freely" stops serving it once it becomes
`qa`, and so does a link whose sender has lost the QA route or been
deactivated. That includes the never-expiring link an order send mints for an
oversize file. A document that is `locked` now is never served. Either way it
is counted in `unavailable_count`.

**Setting it.**

```bash
# On a document type (admin). Audited as document_type.sharing_rule_updated.
curl -X PUT http://localhost:8788/api/document-types/TYPE_ID \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"sharing_rule":"qa"}'

# On one document (an admin or a QA releaser; a reason is required).
# null goes back to the type's rule. Audited as document.sharing_rule_overridden.
curl -X PUT http://localhost:8788/api/documents/DOC_ID \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"sharing_rule_override":"locked","sharing_rule_reason":"Wrong lot on it"}'
```

`POST /api/document-types` takes an optional `sharing_rule`; left out, the rule
is proposed from the name. `PUT` refuses `null` (a type is not set back to "not
stored"), and renaming a type that has no stored rule writes down the rule it
was read as first, so a rename never moves the rule.

**Changing a document's TYPE changes its rule, and is checked the same way.**
The rule before and after the whole change is compared, on every route that
writes a document's type: `PUT /api/documents/:id` (`document_type_id`, and
`categories`, whose primary becomes the type), the upsert of
`POST /api/documents/ingest` and `/ingest-url`, and "Replace existing" in the
Review Queue.

| the change | who may make it |
|---|---|
| tightens the rule, or leaves it where it was | whoever may edit the document |
| `qa` to `free` | a QA releaser (which includes administrators) |
| off `locked` (a document with no type is locked) | an administrator of the organization only |
| any loosening, of a document or of a type's `sharing_rule` | never an API key, whoever owns it |

A refused change is `403` with `code: "sharing_rule_change_refused"` and the
reason in words, and refuses the whole request: an ingest writes no version
(send the file without `document_type_id` to add one and keep the type). A
`document_type_id` must belong to the document's own organization (`400`
otherwise); a document that already points at another organization's type is
read as having no type. Every move of a document's effective rule is audited as
`document.sharing_rule_changed` (`from`, `to`, `direction`, `cause`, `via`).
`GET /api/documents/:id` returns `document.sharing`: `rule`, `source`
(`override` / `no_type` / `type` / `type_name` / `unrecognised`), `type_rule`,
the override with who / when / why, and `can_edit` / `can_unlock` for the caller.

**Types that predate 0137** have no stored rule and are read by name, so there
is no unguarded window. `bin/backfill-sharing-rules` (dry run by default;
`--tenant <id>`, `--all` to report, `--remote`, `--apply`) writes the rule each
such type is already read as, so the Document Types screen shows a stored
setting. It never overwrites a stored rule.

### Building an order by hand, and sending its certificates (migration 0134)

On the basic tier nothing feeds orders in, so a person records what the matcher
would otherwise be told and puts the approved certificate on each line. It is
the same order record a connector writes -- there is no second "manual order"
object. All of it is module-gated under `fulfillment`, and every write needs
`user` or above (a read-only account builds and sends nothing).

**`POST /api/orders`** — body `{ order_number, po_number?, customer_id?,
customer_name?, customer_number?, ship_date?, items? }`. `ship_date` is
`YYYY-MM-DD` and must be a real day. A `customer_id` must belong to the
organization (400 otherwise) and supplies the order's customer name and number
unless others are typed. An order number already in use answers **409** with
the number in the message. The creating user is stored as `created_by`.
`PUT /api/orders/:id` takes `ship_date` and applies the same customer check.

**`GET /api/orders/:id`** — `{ order, items, suggestions, sends }`. Each item
carries what a person checks before a certificate goes out: the linked lot row
(`lot_row_number`, `sub_lot_code`), the production date **with its doubt**
(`production_date_state`: `stated` / `decoded` / `legacy` / `ambiguous` /
`conflict` / `unparseable` / `none`, plus `production_date_label` and
`production_date_note` -- only `stated` is a date the certificate printed and
that reads one way), `picked_by` / `picked_by_name`, the certificate's
`coa_document_status`, type, supplier and `coa_file_size`, and `coa_original`
(`not_split` / `on_file` / `missing`: whether the whole certificate behind a
per-lot page is on file). `sends` is the record of what has already left.

**`POST /api/orders/:id/items`** — body `{ document_ids: [...] }` and/or
`{ item: { product_id?, product_name?, product_code?, quantity?, lot_number? } }`.
Picking a document writes **one line per lot row** it certifies, exactly the
way accepting a lot-match suggestion writes one (`coa_document_id`, `lot_id`,
`lot_matched = 1`, `coa_match_status = 'matched'`, `coa_matched_at`), stamps
`picked_by` / `picked_at`, and records an `accepted` suggestion with
`match_basis: "manual_pick"` -- so the fulfillment report, lot counts and
search coverage read it as a person's accepted match. An existing line for that
lot with no certificate is **filled** rather than duplicated. Only **active
documents of the order's own organization with a file** may be picked: anything
else is listed in `refused` with its reason and the rest still land
(`results[].outcome` is `added` / `filled` / `already_on_order`; 400 when
nothing at all could be written). At most 50 documents per call. A typed line's
lot number is resolved and the matcher is asked for certificates, which arrive
as suggestions. A staged order (still in connector review) answers 409; another
organization's order answers 404. Audited `order_item.coa_picked` /
`order_item.added`.

**`PUT /api/orders/:id/items/:itemId`** — `product_id`, `product_name`,
`product_code`, `quantity`, `lot_number`, and the pick itself:
`coa_document_id` (a document id puts it on the line; `null` takes it off, and
the pair is then never offered back by the matcher) with an optional `lot_id`
when the document certifies several lots (400 asking which, if it is not
given). **`DELETE /api/orders/:id/items/:itemId`** removes the line, with the
whole row in the audit record.

**`GET /api/orders/:id/send-preview`** — exactly what Send would do; sends
nothing. `files[]` (each under the **generated** name it travels under, with
`bytes`, `delivery` `attachment` / `link`, `source` `document` / `original`,
`part_number`, the order lines it stands for, and `notes` in plain words),
`parts[]` (the subject each email will carry), `part_count`, `recipient` (the
customer's address on record), `recipients[]` / `recipient_source` and
`item_requirements[]` (migration 0135 -- see "What the order review reads"),
`from_name`, `reply_to`, `lines_not_sent[]`
(with the reason), `warnings`, `blocked` (`nothing_to_send` /
`too_many_parts` / `too_many_linked` / `order_staged`, or null), `limits`, and
a `fingerprint`. No storage key or queue id is in it.

**`POST /api/orders/:id/send`** — body `{ recipients?, subject?, message?,
fingerprint? }`. The customer gets an exact copy of each file **attached**, not
a link: from `"<Organization> via SupDox"` at the portal's own address, with a
reply-to of the calling user. `recipients` defaults to the customer's COA
contacts, else the customer's address (400 when there is neither); at most 10.
Rules:

- **Generated file names only.** The uploaded name appears nowhere in the mail.
- **A multi-lot certificate goes whole**, once, however many lines were cut
  from it (`source: "original"`). When the original is not on file, or could
  not be confirmed as the source of that version, the per-lot page is sent and
  the file's `notes` say so.
- **15 MB of files per email.** What does not fit goes in numbered emails
  (`"… (2 of 3)"`), in line order. More than **10** emails is refused **413**
  with both numbers; nothing is ever dropped to make it fit.
- **A single file over 15 MB leaves as a link** in the first email. That link
  does not expire (`never_expires`) and can be revoked.
- **A plan that changed since the preview is refused 409** (`fingerprint`).
- **Each email succeeds or fails on its own.** 200 with `send.status` `sent` or
  `partial` when at least one went; **502** when none did. A file missing from
  storage fails its email with the reason rather than being left out. The
  order's status becomes `delivered` only when every part went AND no line was
  left behind (a line with no document, or one that is no longer active).
- 30 sends an hour per user (429); 503 when email is not configured.

Audited `order.coas_sent` (or `order.coas_send_failed`) naming every file, its
documents, its part, how it went, and the recipients.

**`POST /api/orders/:id/sends/:sendId/resend`** — sends again **only** the
emails that did not go, rebuilt from the stored record (same files, names,
subject and recipients; the reply-to stays the original sender's). The sender
or an admin; 409 when every part already went.

**`GET /api/document-exports/links`** — "Documents you sent". One row per send:
when, by whom, on whose behalf, to which addresses, how many documents (with
the first few titles), the view and download counts, and a resolved `state` of
`active` / `expired` / `revoked` (revoked wins over expired — what a reader
wants to know is whether a person stopped it). An **admin sees the
organization's sends, anybody else their own**; `scope=mine|tenant` is a
request, and the response reports the `scope` it actually answered in, so a
client can never render "everyone" over a filtered list. **The token is never
returned** — this is the accountability screen, not a second way to open every
export ever sent. A link minted for a file too large to attach to an order send
has `never_expires: true`: its `state` is `active` until somebody revokes it,
never `expired`. The response also carries **`order_sends`** -- documents sent
from an order as attachments (migration 0134), in the same scope -- each with
its recipients, per-email outcomes and files. There is nothing to revoke or
count for those: an attachment is in the recipient's inbox.

**`POST /api/document-exports/links/:id/revoke`** — the kill switch, reachable
at last (migration 0116 records who pressed it). Effective immediately and on
**all three** recipient routes: the landing read, the ZIP and the per-file
download all resolve a token through the one gate, `loadUsableExportLink`,
which returns null for a revoked row, and all three answer the same 404 they
answer for a token that never existed. The sender may revoke their own; an
admin may revoke anyone's; another tenant's link is a 404, never a 403. A
second press is a no-op that does not move the first revocation's timestamp.
Audited as `document_export.revoked` with the recipients, the id list, and the
view/download counts at the moment it was pulled.

**A connector file for an order a person has worked on.** Approving an order file in the Review
Queue (`PUT /api/queue/:id`, `status: "approved"`) upserts by order number. For an order where a
person picked a certificate, or accepted / rejected a suggestion, the lines are reconciled instead
of replaced: the header updates; a file line matching an existing line (same product code or name,
same lot) updates it in place; an unmatched file line is added; **a line a person decided is never
deleted or overwritten**, whether or not the file still lists it; an undecided line the file dropped
is removed. When decided lines were kept the response carries `notes` (plain words, one per order),
also written to the `queue_item.approved` audit row and to `connector_runs.details.notes`:

```json
{ "item": { "id": "...", "status": "approved" }, "summary": "0 created, 1 updated, 0 failed",
  "notes": ["Order 1650438: kept 1 line a person had decided (not changed by this file). The file listed 2 lines: 1 added, 1 removed, 0 updated."] }
```

**There is deliberately no "extend".** Lengthening a link after the fact
quietly changes the terms of a mail already sent ("this link expires on the
15th") and hides that decision in a row nobody re-reads. A new send is the
honest answer: it names its own recipients, its own expiry and its own audit
row. Revoking also cannot recall a file already downloaded, and the UI says so
rather than implying otherwise.

---

## Error Handling

### Error Response Format

All error responses use a consistent JSON format:

```json
{
  "error": "Human-readable error message"
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created (new resource) |
| 400 | Bad request (validation error, missing fields) |
| 401 | Unauthorized (missing/invalid/expired token, wrong password) |
| 403 | Forbidden (insufficient permissions, wrong tenant) |
| 404 | Not found (resource does not exist) |
| 409 | Conflict (duplicate email, duplicate slug) |
| 429 | Too many requests (rate limited) |
| 500 | Internal server error |

### Rate Limiting

Two endpoints are rate limited:
- **Login** (`POST /api/auth/login`): 5 attempts per 15 minutes per IP+email
- **Forgot password** (`POST /api/auth/forgot-password`): 3 attempts per 15 minutes per IP

Rate limit state is stored in the `rate_limits` D1 table. Successful login clears the rate limit.
