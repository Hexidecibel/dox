# MindStudio Integration Guide

How to connect MindStudio to dox for automated document ingestion with structured metadata extraction.

## Overview

MindStudio processes documents (COAs, Spec Sheets, SDS, etc.), extracts structured data, and sends it to dox via the ingest API. dox stores the document, links it to products, tracks expiration dates, and applies naming templates.

## Authentication

All API calls require an `Authorization: Bearer <token>` header or an `X-API-Key: dox_sk_...` header.

**Getting a token:**
```
POST /api/auth/login
Content-Type: application/json

{"email": "...", "password": "..."}
```
Returns `{"token": "eyJ..."}`. Tokens expire after 24 hours.

**API keys** (recommended for automation): Created by admins in the dox UI. Sent as `X-API-Key: dox_sk_...` header. Keys authenticate as the creating user.

## Workflow

```
Document (PDF/image)
    │
    ▼
MindStudio extracts:
    ├── lot_number
    ├── po_number
    ├── code_date
    ├── expiration_date
    ├── product name(s)
    └── document type (COA, SDS, etc.)
    │
    ▼
Resolve names → IDs:
    ├── GET /api/document-types/by-slug  →  document_type_id
    └── POST /api/products/lookup-or-create  →  product_id(s)
    │
    ▼
POST /api/documents/ingest (multipart form data)
    │
    ▼
dox stores document, links products, tracks expiration
```

## Step 1: Resolve Document Type ID

Look up the document type by slug or name within the tenant.

```
GET /api/document-types/by-slug?slug=coa&tenant_id=TENANT_ID
```

Or by name (server derives the slug):
```
GET /api/document-types/by-slug?name=Certificate+of+Analysis&tenant_id=TENANT_ID
```

**Response (200):**
```json
{
  "documentType": {
    "id": "abc123",
    "name": "Certificate of Analysis",
    "slug": "certificate-of-analysis",
    "tenant_id": "...",
    "active": 1
  }
}
```

**Response (404):** Document type not found — admin needs to create it in dox first.

### Common document type slugs

These depend on what the tenant admin has configured. Typical slugs:

| Name | Likely slug |
|------|-------------|
| Certificate of Analysis | `certificate-of-analysis` |
| Spec Sheet | `spec-sheet` |
| Safety Data Sheet | `safety-data-sheet` |

> **Note:** Slugs are auto-generated from names. The slug for "COA" would be `coa`, but if the admin named it "Certificate of Analysis", the slug is `certificate-of-analysis`. Use the `?name=` parameter to let the server derive the slug.

## Step 2: Resolve Product IDs

Look up products by name, creating them automatically if they don't exist yet.

**Lookup only (GET):**
```
GET /api/products/lookup-or-create?name=Vitamin+A&tenant_id=TENANT_ID
```
Returns the product if found, 404 if not.

**Lookup or create (POST):**
```
POST /api/products/lookup-or-create
Content-Type: application/json

{
  "name": "Vitamin A",
  "tenant_id": "TENANT_ID"
}
```

**Response (200 if found, 201 if created):**
```json
{
  "product": {
    "id": "prod-456",
    "name": "Vitamin A",
    "slug": "vitamin-a",
    "tenant_id": "...",
    "active": 1
  },
  "created": true
}
```

- Matching is **case-insensitive exact match** ("vitamin a" matches "Vitamin A")
- POST is **idempotent** — calling it twice with the same name returns the existing product
- The `user` role can create products via this endpoint

## Batch Product Resolution

Resolve multiple product names in a single call. Creates any that don't exist.

```
POST /api/products/lookup-or-create-batch
Content-Type: application/json

{
  "names": ["Vitamin A", "Vitamin D3", "Fish Oil"],
  "tenant_id": "TENANT_ID"
}
```

**Response (201 if any created, 200 if all existed):**
```json
{
  "products": [
    { "name": "Vitamin A", "product": { "id": "abc", "name": "Vitamin A", "slug": "vitamin-a", "active": 1 }, "created": false },
    { "name": "Vitamin D3", "product": { "id": "def", "name": "Vitamin D3", "slug": "vitamin-d3", "active": 1 }, "created": true },
    { "name": "Fish Oil", "product": { "id": "ghi", "name": "Fish Oil", "slug": "fish-oil", "active": 1 }, "created": true }
  ]
}
```

- Max 50 names per batch
- Case-insensitive matching
- Idempotent — safe to call repeatedly
- Use POST (not GET) since it may create products

## Step 3: Ingest the Document

Send the document with all extracted metadata via **multipart form data**.

```
POST /api/documents/ingest
Authorization: Bearer <token>
Content-Type: multipart/form-data

Fields:
  file:              (binary) the document file
  external_ref:      (string, required) unique ID from MindStudio
  tenant_id:         (string, required) tenant UUID
  title:             (string) document title
  document_type_id:  (string) from step 1
  lot_number:        (string) extracted lot number
  po_number:         (string) extracted PO number
  code_date:         (string) extracted code/manufacture date
  expiration_date:   (string) extracted expiration date
  product_ids:       (JSON string) product links array
  source_metadata:   (JSON string) arbitrary metadata
  description:       (string) document description
  category:          (string) document category
  tags:              (JSON string) array of tag strings
  changeNotes:       (string) version notes
```

### curl example

```bash
curl -X POST https://your-dox-instance.com/api/documents/ingest \
  -H "X-API-Key: dox_sk_your_key_here" \
  -F "file=@/path/to/coa.pdf;type=application/pdf" \
  -F "external_ref=mindstudio-job-$(date +%s)" \
  -F "tenant_id=abc123" \
  -F "title=Vitamin A COA Lot 2026-001" \
  -F "document_type_id=doctype-id-from-step-1" \
  -F "lot_number=LOT-2026-001" \
  -F "po_number=PO-5678" \
  -F "code_date=2026-01-15" \
  -F "expiration_date=2027-01-15" \
  -F 'product_ids=[{"product_id":"prod-id-from-step-2","expires_at":"2027-01-15","notes":"COA expiration"}]' \
  -F 'source_metadata={"source":"mindstudio","parsed_at":"2026-03-31","confidence":0.95}'
```

### product_ids format

JSON array of objects:

```json
[
  {
    "product_id": "prod-456",
    "expires_at": "2027-01-15",
    "notes": "Per COA expiration date"
  }
]
```

- `product_id` (string, required) — from step 2
- `expires_at` (string, optional) — ISO date for the product-document link expiration
- `notes` (string, optional) — free text

### Response

**201 Created (new document):**
```json
{
  "action": "created",
  "document": {
    "id": "doc-789",
    "external_ref": "mindstudio-job-123",
    "title": "Vitamin A COA Lot 2026-001",
    "current_version": 1,
    "lot_number": "LOT-2026-001",
    "po_number": "PO-5678",
    "document_type_id": "...",
    "expiration_date": "2027-01-15"
  },
  "version": { "version_number": 1, "file_size": 45230, "checksum": "..." }
}
```

**200 OK (new version of existing document):**
Same external_ref + tenant_id → adds a version instead of creating a duplicate.
```json
{
  "action": "version_added",
  "document": { "id": "doc-789", "current_version": 2, ... },
  "version": { "version_number": 2, ... }
}
```

## Alternative: URL-Based Ingest

If MindStudio has the document at a URL (not a local file), use the JSON endpoint instead. This endpoint now supports **all structured metadata fields** — full parity with the multipart `ingest` endpoint.

```
POST /api/documents/ingest-url
Content-Type: application/json

{
  "file_url": "https://example.com/coa.pdf",
  "external_ref": "mindstudio-job-123",
  "tenant_id": "abc123",
  "title": "Vitamin A COA Lot 2026-001",
  "file_name": "vitamin-a-coa.pdf",
  "document_type_id": "doctype-id-from-step-1",
  "lot_number": "LOT-2026-001",
  "po_number": "PO-5678",
  "code_date": "2026-01-15",
  "expiration_date": "2027-01-15",
  "product_ids": [
    {
      "product_id": "prod-id-from-step-2",
      "expires_at": "2027-01-15",
      "notes": "COA expiration"
    }
  ],
  "source_metadata": {
    "source": "mindstudio",
    "parsed_at": "2026-03-31",
    "confidence": 0.95
  },
  "category": "COA",
  "tags": ["vitamins", "2026"]
}
```

Same upsert logic as the multipart endpoint. The server downloads the file from the URL. Naming templates are applied automatically if configured for the tenant.

## Checking if a Document Exists

Before ingesting, you can check if a document already exists:

```
GET /api/documents/lookup?external_ref=mindstudio-job-123&tenant_id=abc123
```

**200:** Returns the document and current version.
**404:** Document doesn't exist yet.

## File Requirements

| Constraint | Value |
|-----------|-------|
| Max file size | 100 MB |
| Allowed types | PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JSON, PNG, JPG/JPEG |
| Extension matching | File extension must match MIME type |

## Naming Templates

If the tenant has a naming template configured, dox automatically renames the stored file. For example, with template `{lot_number}_{product}_{doc_type}.{ext}`:

- Upload: `scan_001.pdf`
- Stored as: `LOT-2026-001_Vitamin-A_COA.pdf`

Available template variables: `{title}`, `{lot_number}`, `{po_number}`, `{code_date}`, `{expiration_date}`, `{ext}`

MindStudio does not need to worry about naming — just send the raw file and metadata fields.

## Error Handling

| Status | Meaning |
|--------|---------|
| 400 | Bad request — missing required fields, invalid file type, bad JSON |
| 401 | Unauthorized — missing or expired token/API key |
| 403 | Forbidden — user lacks permission or wrong tenant |
| 404 | Not found — document type, product, or tenant doesn't exist |
| 409 | Conflict — duplicate slug (unlikely with lookup-or-create) |
| 413 | File too large (> 100 MB) |
| 500 | Server error — report to dox admin |

## Quick Reference

| Action | Method | Endpoint |
|--------|--------|----------|
| Get doc type ID | GET | `/api/document-types/by-slug?slug=X&tenant_id=Y` |
| Get/create product ID | POST | `/api/products/lookup-or-create` |
| Get/create product IDs (batch) | POST | `/api/products/lookup-or-create-batch` |
| Ingest document (file) | POST | `/api/documents/ingest` (multipart) |
| Ingest document (URL) | POST | `/api/documents/ingest-url` (JSON) |
| Check if doc exists | GET | `/api/documents/lookup?external_ref=X&tenant_id=Y` |
| List doc types | GET | `/api/document-types?tenant_id=Y` |
| List products | GET | `/api/products?tenant_id=Y&search=X` |
