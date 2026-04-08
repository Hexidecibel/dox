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
```

Audit actions logged by the system:
- `login`, `logout`, `password_changed`
- `user_created`, `user_updated`, `user_deactivated`, `user.password_reset`
- `tenant_created`, `tenant_updated`, `tenant_deactivated`
- `document_created`, `document_updated`, `document_deleted`
- `document_version_uploaded`, `document_downloaded`
- `report.generate`

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

Optional fields: `permissions` (array of strings, default `["*"]`), `expiresAt` (ISO date string), `tenantId` (super_admin only; org_admin auto-scoped).

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

SHA-256 checksums are computed on upload and stored in the `document_versions` table. The checksum is also returned as an `ETag` header on download.

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
