# Universal ERP/WMS Integration Architecture

SupDox integration layer for connecting any ERP and WMS system to the COA automation pipeline. This document describes a config-driven adapter pattern that lets tenants connect their systems without custom development.

---

## Table of Contents

1. [Vision](#1-vision)
2. [Architecture: Adapter Pattern](#2-architecture-adapter-pattern)
3. [Data Model](#3-data-model)
4. [Order Pipeline](#4-order-pipeline)
5. [Field Mapping System](#5-field-mapping-system)
6. [Per-Tenant Configuration UI](#6-per-tenant-configuration-ui)
7. [Security](#7-security)
8. [Implementation Phases](#8-implementation-phases)
9. [Current User's Setup](#9-current-users-setup)
10. [Success Metrics](#10-success-metrics)

---

## 1. Vision

Every SupDox tenant has an ERP and a WMS. They are never the same product, never the same version, and never configured the same way. A universal integration layer must accept this reality and work anyway.

**Principles:**

- **Any vendor, any era.** SAP, NetSuite, Dynamics 365, Fishbowl, QuickBooks, homegrown Access databases, green-screen AS/400 terminals — all are valid integration targets.
- **Config-driven, not code-driven.** A new tenant connects their ERP by filling out a form, not by filing a feature request. No custom adapter code per customer.
- **Multiple integration methods.** Not every system has an API. The architecture supports five intake methods — email, API, file upload, webhook, and browser automation — so there is always a path forward.
- **Incremental value.** Each integration method works independently. A tenant can start with email parsing on day one and upgrade to a direct API connection later without losing data or reconfiguring downstream steps.
- **Tenant-isolated.** Integrations, credentials, orders, and customers are fully scoped to a tenant. No cross-tenant data leakage.

---

## 2. Architecture: Adapter Pattern

Every integration — regardless of whether it talks to an ERP or WMS, via API or email — implements the same standard interface. Downstream pipeline stages (lot matching, report building) never care how the data arrived.

### 2.1 Standard Interface

Every adapter implements the same contract:

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `lookupOrder(orderNumber)` | Order number | Order details, PO number, customer, line items | Get order info from ERP |
| `lookupLots(orderOrPO)` | Order or PO number | Lot numbers, products, quantities | Get shipment/lot details from WMS |
| `lookupCustomer(customerNumber)` | Customer number (e.g. K#####) | Name, email, COA delivery preferences | Resolve customer identity |
| `syncProducts()` | — | Product catalog entries | Keep product list in sync with source system |

Not every adapter implements every method. An ERP adapter typically implements `lookupOrder` and `lookupCustomer`. A WMS adapter implements `lookupLots` and `syncProducts`. The pipeline calls whichever methods are available and fills in gaps from other sources.

### 2.2 Built-in Adapter Types

#### Email Parser Adapter

Receives structured emails and uses AI to parse them into structured order data. This is the most common starting point because nearly every ERP can send automated email reports.

| Aspect | Detail |
|--------|--------|
| **How it works** | Emails arrive at `{slug}@supdox.com` via the existing CF Email Worker. A subject-line pattern match routes the email to the ERP integration. AI parses the body into structured records. |
| **Best for** | ERP systems that send automated reports but lack APIs. Daily batch emails, order confirmation emails, shipping notifications. |
| **Config** | Email subject pattern (regex), sender address filter, parsing instructions (natural language prompt for the AI), output field mappings. |
| **Existing infra** | The email routing pipeline (`{slug}@supdox.com` → CF Email Worker → webhook) is already built and live for COA intake. This adapter extends it to recognize ERP report emails alongside document attachments. |
| **Limitations** | Batch-oriented (processes when emails arrive, not on-demand). Parsing accuracy depends on email format consistency. |

#### API Adapter (REST / SOAP / GraphQL)

A config-driven HTTP client that connects directly to ERP/WMS APIs. No custom code — the tenant provides endpoints, auth, and field mappings through the UI.

| Aspect | Detail |
|--------|--------|
| **How it works** | Makes HTTP requests to configured endpoints with variable substitution (e.g., `/api/orders/{orderNumber}`). Parses responses using field mappings (see Section 5). Handles pagination, rate limiting, and retry automatically. |
| **Best for** | Modern ERP/WMS systems with documented APIs: NetSuite (SuiteTalk/REST), SAP Business One (Service Layer), Dynamics 365 (OData), Fishbowl (REST), Cin7, DEAR Inventory, etc. |
| **Config** | Base URL, auth method and credentials, endpoint URL templates with variables, response field mappings (JSONPath), pagination strategy (offset, cursor, link-header), rate limit (requests/second), timeout. |
| **Auth support** | API key (header or query param), OAuth 2.0 (client credentials flow, authorization code flow with PKCE), HTTP basic auth, custom header auth. |
| **Limitations** | Requires the target system to have an accessible API. Some on-premise systems may need VPN or tunnel configuration. |

#### CSV/File Adapter

Accepts uploaded or dropped files — CSV, Excel (XLSX), or EDI — and parses rows into order/lot records.

| Aspect | Detail |
|--------|--------|
| **How it works** | Tenant uploads a file through the UI, or a file lands via a configured drop mechanism (R2 bucket watch, SFTP, etc.). The adapter parses the file using configured column mappings and creates order/lot records. |
| **Best for** | Legacy systems that can only export flat files. ERP systems where API access is restricted but "Export to CSV" works. Periodic bulk imports. |
| **Config** | File format (CSV, XLSX, EDI), delimiter, header row index, column-to-field mapping, date format, encoding. |
| **Limitations** | Manual or batch-only (no real-time). Requires someone or something to produce and upload the file. |

#### Webhook Adapter

Receives push notifications from ERP/WMS systems when events occur (order created, shipment confirmed, inventory updated).

| Aspect | Detail |
|--------|--------|
| **How it works** | Each integration gets a unique webhook URL: `https://supdox.com/api/webhooks/integrations/{integrationId}`. The ERP/WMS posts event payloads to this URL. Field mappings extract the relevant data. |
| **Best for** | Systems that support outbound webhooks or event notifications: Shopify, many modern cloud ERPs, Zapier/Make-connected systems. |
| **Config** | Payload field mappings, event type filter (which events to process), signature verification (HMAC secret, header name), IP allowlist. |
| **Limitations** | Requires the source system to support outbound webhooks. Tenant must configure the webhook on their end. |

#### Browser Automation Adapter (Future)

A Playwright-based agent that logs into ERP/WMS web UIs, navigates screens, enters data, and reads results. The adapter of last resort.

| Aspect | Detail |
|--------|--------|
| **How it works** | A headless browser logs into the ERP/WMS using stored credentials. Navigation scripts (configurable step sequences) drive the UI: click here, enter order number there, read the table on this page. Results are extracted via CSS selectors or AI vision. |
| **Best for** | Systems with zero API access, no export capability, and no webhook support. Legacy web apps. Systems behind restrictive firewalls where only a browser works. |
| **Config** | Login URL, credentials (encrypted), navigation script (sequence of steps: goto, click, fill, wait, extract), CSS selectors or AI extraction prompts for reading results. |
| **Risks** | Fragile — breaks when the target UI changes. Slow (seconds per operation vs. milliseconds for API). Requires credentials with appropriate access. May violate ToS of the target system. Should always be presented as a temporary bridge until a better integration method is available. |

### 2.3 Adapter Selection Guide

| Situation | Recommended Adapter | Fallback |
|-----------|-------------------|----------|
| ERP sends daily report emails | Email Parser | — |
| ERP/WMS has a documented REST API | API Adapter | Email Parser |
| ERP/WMS has webhook/event support | Webhook Adapter | API Adapter |
| System only exports CSV/Excel | CSV/File Adapter | — |
| System has web UI but nothing else | Browser Automation | CSV/File (manual export) |
| Tenant uses Zapier/Make | Webhook Adapter (Zapier pushes to our URL) | — |

---

## 3. Data Model

### 3.1 New Tables

#### `integrations` — Per-tenant integration configurations

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | ULID |
| `tenant_id` | TEXT FK | Owning tenant |
| `name` | TEXT | Human-readable name (e.g., "Acme ERP", "Fishbowl WMS") |
| `system_type` | TEXT | `erp` or `wms` |
| `adapter_type` | TEXT | `email`, `api`, `csv`, `webhook`, `browser` |
| `config` | TEXT (JSON) | Adapter-specific settings (endpoints, patterns, column maps) |
| `field_mappings` | TEXT (JSON) | Source fields → SupDox fields (see Section 5) |
| `credentials` | TEXT (encrypted JSON) | API keys, OAuth tokens, passwords — AES-256-GCM encrypted |
| `active` | INTEGER | 1 = enabled, 0 = disabled |
| `polling_schedule` | TEXT | Cron expression for pull-based adapters (e.g., `30 15 * * 1-5` for 3:30pm weekdays) |
| `last_sync_at` | TEXT | ISO timestamp of last successful sync |
| `last_error` | TEXT | Last error message (null if last sync succeeded) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

#### `orders` — The core work queue

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | ULID |
| `tenant_id` | TEXT FK | Owning tenant |
| `integration_id` | TEXT FK | Which integration created this order |
| `order_number` | TEXT | Order number from ERP |
| `po_number` | TEXT | PO number (may come from ERP lookup or WMS) |
| `customer_id` | TEXT FK | Resolved customer reference |
| `customer_number` | TEXT | Raw customer number from source (e.g., K12345) |
| `customer_name` | TEXT | Customer name from source |
| `status` | TEXT | `pending` → `enriched` → `matched` → `delivered` → `error` |
| `source_data` | TEXT (JSON) | Raw data from the source system, preserved for debugging |
| `error_message` | TEXT | Details when status = error |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

#### `order_items` — Line items per order

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | ULID |
| `order_id` | TEXT FK | Parent order |
| `product_id` | TEXT FK | Matched product in SupDox (nullable until matched) |
| `product_name` | TEXT | Product name from source system |
| `product_code` | TEXT | Product code/SKU from source system |
| `quantity` | REAL | Quantity ordered/shipped |
| `lot_number` | TEXT | Lot number from WMS (nullable until WMS enrichment) |
| `lot_matched` | INTEGER | 0 = unmatched, 1 = COA found |
| `coa_document_id` | TEXT FK | Matched COA document (nullable until matched) |
| `match_confidence` | REAL | Confidence score of the lot-to-COA match (0.0–1.0) |
| `created_at` | TEXT | ISO timestamp |

#### `customers` — Customer registry

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | ULID |
| `tenant_id` | TEXT FK | Owning tenant |
| `customer_number` | TEXT | Customer number in ERP (K#####, P######, etc.) |
| `name` | TEXT | Business name |
| `email` | TEXT | Primary contact email for COA delivery |
| `coa_delivery_method` | TEXT | `email`, `portal`, `none` |
| `coa_requirements` | TEXT (JSON) | What this customer needs (e.g., specific doc types, format preferences) |
| `active` | INTEGER | 1 = active, 0 = inactive |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

Unique constraint: `(tenant_id, customer_number)`.

### 3.2 Relationships to Existing Tables

```
integrations.tenant_id        → tenants.id
orders.tenant_id              → tenants.id
orders.integration_id         → integrations.id
orders.customer_id            → customers.id
order_items.order_id          → orders.id
order_items.product_id        → products.id
order_items.coa_document_id   → documents.id
customers.tenant_id           → tenants.id
```

**Lot matching join:** `order_items.lot_number` matches against `documents.primary_metadata` where the JSON field `lot_number` equals the order item's lot number. This is the critical link between the order pipeline and the document store.

### 3.3 Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `integrations` | `(tenant_id, active)` | List active integrations for a tenant |
| `orders` | `(tenant_id, status)` | Query orders by status (the main dashboard view) |
| `orders` | `(tenant_id, order_number)` UNIQUE | Prevent duplicate order imports |
| `orders` | `(tenant_id, customer_id)` | Orders by customer |
| `order_items` | `(order_id)` | Items for an order |
| `order_items` | `(lot_number)` | Lot-based lookups for matching |
| `customers` | `(tenant_id, customer_number)` UNIQUE | Customer lookup by number |

---

## 4. Order Pipeline

The pipeline is a linear state machine. Each step is independent, idempotent, and resumable. If any step fails, the order stays at its current status and retries on the next run.

```
┌─────────────────────────────────────────────────────────────┐
│                      INTAKE                                 │
│  ERP Email / API Poll / File Upload / Webhook Push          │
│              ↓                                              │
│  Adapter parses source data into orders + order_items       │
│  Status: pending                                            │
└─────────────────┬───────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────┐
│                   WMS ENRICHMENT                            │
│  WMS Adapter looks up lot numbers + products for each order │
│  order_items populated with lot_number, product_code, qty   │
│  Status: enriched                                           │
└─────────────────┬───────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────┐
│                   LOT MATCHING                              │
│  For each order_item.lot_number:                            │
│    Search documents.primary_metadata.lot_number             │
│    If found → set coa_document_id, lot_matched = 1          │
│    If missing → flag for manual review                      │
│  Status: matched (all lots matched)                         │
│          or stays enriched (partial match, flagged)          │
└─────────────────┬───────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────┐
│                   REPORT & DELIVERY                         │
│  Assemble matched COAs into customer package                │
│  Apply report template (per customer or per tenant)         │
│  Send via configured method (email, portal, etc.)           │
│  Status: delivered                                          │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Status Transitions

| From | To | Trigger | Failure Behavior |
|------|----|---------|-----------------|
| — | `pending` | Adapter creates order | — |
| `pending` | `enriched` | WMS adapter populates lot numbers | Retries on next polling cycle. Order stays `pending`. |
| `enriched` | `matched` | All lots matched to COAs | Partial matches stay `enriched` with unmatched lots flagged. Missing COA alert sent. |
| `matched` | `delivered` | Report sent to customer | Retry delivery. Alert on repeated failure. |
| Any | `error` | Unrecoverable failure | Error message stored. Manual intervention required. |

### 4.2 Pipeline Runner

The pipeline runs as a background worker (same pattern as the existing process-worker for document extraction). On each cycle:

1. Query orders at each status that are ready for the next step.
2. Process one order at a time (prevents overloading external APIs).
3. Update status and timestamps after each step.
4. Log all transitions to the audit log.

Pull-based integrations (API adapter with polling schedule, email parser) run on their configured cron schedule. Push-based integrations (webhook, email) create orders immediately on receipt.

---

## 5. Field Mapping System

This is the key to "one size fits all." Every ERP and WMS uses different field names, response structures, and data formats. The field mapping system lets tenants define how their system's data maps to SupDox's standard fields — without writing code.

### 5.1 The Problem

The same concept has different names in every system:

| SupDox Field | SAP | NetSuite | QuickBooks | Fishbowl |
|-------------|-----|----------|------------|----------|
| Order Number | `VBELN` | `tranId` | `DocNumber` | `orderNumber` |
| Customer Number | `KUNNR` | `entity.internalId` | `CustomerRef.value` | `customerNum` |
| Customer Name | `NAME1` | `entity.name` | `CustomerRef.name` | `customerName` |
| Product Code | `MATNR` | `item.itemId` | `Line.ItemRef.value` | `partNumber` |
| Lot Number | `CHARG` | `inventoryDetail.lotNumber` | N/A | `lotNumber` |
| Quantity | `MENGE` | `quantity` | `Line.Qty` | `qty` |

### 5.2 JSONPath Mapping

Each integration's `field_mappings` column contains a JSON object that maps SupDox's standard fields to JSONPath-style selectors applied against the source data.

**Example: SAP Business One API response mapping**

```json
{
  "order_number": "$.DocumentLines[0].DocEntry",
  "po_number": "$.NumAtCard",
  "customer_number": "$.CardCode",
  "customer_name": "$.CardName",
  "line_items": "$.DocumentLines[*]",
  "line_items.product_code": "$.ItemCode",
  "line_items.product_name": "$.ItemDescription",
  "line_items.quantity": "$.Quantity",
  "line_items.lot_number": "$.BatchNumbers[0].BatchNumber"
}
```

**Example: CSV column mapping**

```json
{
  "order_number": "$[0]",
  "customer_number": "$[1]",
  "customer_name": "$[2]",
  "line_items.product_code": "$[3]",
  "line_items.quantity": "$[4]",
  "line_items.lot_number": "$[5]"
}
```

**Example: Email parser (AI-extracted fields)**

```json
{
  "order_number": "$.orders[*].order_number",
  "customer_number": "$.orders[*].customer_number",
  "customer_name": "$.orders[*].customer_name"
}
```

For the email parser adapter, the AI first extracts structured JSON from the email body, then the field mappings are applied to that JSON. The AI extraction prompt is part of the adapter config; the field mappings normalize the AI output to SupDox's schema.

### 5.3 Transforms

Some fields need transformation beyond simple extraction:

| Transform | Example | Config |
|-----------|---------|--------|
| `prefix_strip` | `K12345` → `12345` | `{ "transform": "prefix_strip", "prefix": "K" }` |
| `date_parse` | `04/07/2026` → `2026-04-07` | `{ "transform": "date_parse", "format": "MM/DD/YYYY" }` |
| `split` | `"LOT-A, LOT-B"` → `["LOT-A", "LOT-B"]` | `{ "transform": "split", "delimiter": ", " }` |
| `lookup` | Status code → status name | `{ "transform": "lookup", "map": { "01": "open", "02": "shipped" } }` |
| `template` | Combine fields | `{ "transform": "template", "pattern": "{firstName} {lastName}" }` |

Transforms are optional per field and applied after JSONPath extraction.

### 5.4 Mapping Builder UI

The configuration UI presents a two-column layout:

- **Left column:** SupDox's standard fields (order_number, customer_name, etc.) with descriptions.
- **Right column:** A text input for the JSONPath selector, populated by either typing directly or clicking on a field in a sample response.
- **Test button:** Paste or fetch a sample response, see the extracted values in real time.
- **Transform dropdown:** Optional per-field transform with configuration.

---

## 6. Per-Tenant Configuration UI

### 6.1 Integration List Page

Accessible from tenant settings. Shows all configured integrations for the tenant.

| Column | Content |
|--------|---------|
| Name | Integration name (e.g., "Daily ERP Report") |
| Type | ERP or WMS |
| Adapter | Email / API / CSV / Webhook / Browser |
| Status | Active / Inactive / Error |
| Last Sync | Timestamp of last successful data pull |
| Actions | Edit, Test, Disable, Delete |

### 6.2 Integration Detail Page

Tabbed interface:

**General Tab**
- Integration name
- System type (ERP / WMS)
- Adapter type (with description of what each type does)
- Active toggle

**Connection Tab** (varies by adapter type)

| Adapter | Connection Config |
|---------|------------------|
| Email Parser | Subject pattern (regex), sender filter, AI parsing prompt |
| API | Base URL, auth method, auth credentials, endpoint URL templates |
| CSV/File | File format, delimiter, header row, encoding |
| Webhook | Webhook URL (auto-generated, read-only), signature secret, IP allowlist |
| Browser | Login URL, credentials, navigation script editor |

**Field Mapping Tab**
- Two-column mapping builder (see Section 5.4)
- Sample data input for testing
- Live preview of extracted values

**Schedule Tab** (pull-based adapters only)
- Polling frequency (cron builder or preset options: every 5 min, hourly, daily at specific time)
- Next scheduled run

**Activity Tab**
- Log of recent sync attempts with timestamp, status, record count, errors
- Error details expandable

### 6.3 Test Flow

Every adapter supports a "Test Connection" action:

1. **API:** Makes a test request to a configured endpoint, shows the raw response and mapped fields.
2. **Email:** Shows the last 5 emails that matched the subject pattern, with parsed output.
3. **CSV:** Upload a sample file, see the parsed records.
4. **Webhook:** Shows a sample cURL command the tenant can run to test.
5. **Browser:** Runs the navigation script in debug mode, shows screenshots at each step.

---

## 7. Security

### 7.1 Credential Storage

- All credentials (API keys, OAuth tokens, passwords) are encrypted at rest using AES-256-GCM.
- Encryption key is stored in Cloudflare Worker secrets (`INTEGRATION_ENCRYPTION_KEY`), not in the database.
- Each tenant's credentials are encrypted with a tenant-specific derived key (HKDF from the master key + tenant ID).
- Credentials are **write-only** from the frontend. The API accepts new credentials but never returns them. The UI shows masked placeholders (e.g., `sk_****7f3a`).

### 7.2 Auth Methods

| Method | Storage | Refresh |
|--------|---------|---------|
| API Key | Encrypted in `credentials` column | Manual rotation by tenant |
| OAuth 2.0 Client Credentials | Client ID + secret encrypted. Access token cached in memory. | Auto-refresh on 401 using stored client credentials. |
| OAuth 2.0 Authorization Code | Refresh token encrypted. Access token cached in memory. | Auto-refresh using refresh token. Re-auth flow if refresh fails. |
| Basic Auth | Username + password encrypted. | Manual update by tenant. |
| Browser Automation | Login credentials encrypted separately with additional access controls. | Manual update. Session cookies cached, re-login on expiry. |

### 7.3 Network Security

- All outbound API requests use HTTPS exclusively.
- Webhook endpoints validate request signatures (HMAC-SHA256) when configured.
- Webhook endpoints support IP allowlisting per integration.
- Browser automation runs in an isolated environment with no access to other tenants' data.
- Rate limiting on all webhook endpoints to prevent abuse.

### 7.4 Access Control

- Only `org_admin` and `super_admin` roles can create, edit, or delete integrations.
- Only `super_admin` can access browser automation adapter configuration (due to elevated risk).
- All integration configuration changes are written to the audit log.
- Credential access (decryption) is logged.

---

## 8. Implementation Phases

### Phase 2A: Email Parser Adapter + Order Queue

**Goal:** Parse the daily ERP email into structured orders. Build the order queue UI.

**Scope:**
- Migration: `integrations`, `orders`, `order_items`, `customers` tables
- Extend the existing CF Email Worker to recognize ERP report emails (alongside COA attachments)
- AI parsing of email body into order records (reuse existing Qwen infrastructure)
- Orders API: CRUD, list by status, update status
- Customers API: CRUD, lookup by customer number
- UI: Order queue page (list orders by status, drill into line items)
- UI: Customer list page

**Dependencies:** Existing email infrastructure (CF Email Routing, email worker, `{slug}@supdox.com`)

**Effort:** Medium (2-3 weeks)

### Phase 2B: Manual Order Entry + Customer Management

**Goal:** Provide a manual fallback for creating orders and managing customers.

**Scope:**
- UI: Manual order creation form (order number, customer, line items)
- UI: Customer detail page with COA delivery preferences
- UI: Bulk order import from CSV (uses the CSV adapter logic)
- Missing COA alerts: when an order has lots without matching COAs, email `org_admin`

**Dependencies:** Phase 2A (tables and APIs must exist)

**Effort:** Small (1 week)

### Phase 3A: API Adapter Framework

**Goal:** Config-driven HTTP client for direct ERP/WMS API connections.

**Scope:**
- API adapter engine: HTTP client with auth, pagination, retry, rate limiting
- OAuth 2.0 flows (client credentials + authorization code with PKCE)
- Credential encryption layer (AES-256-GCM with per-tenant derived keys)
- Field mapping engine (JSONPath extraction + transforms)
- Integration configuration API and UI
- Test connection flow
- Polling scheduler (cron-based, integrated with the process worker)

**Dependencies:** Phase 2A (order tables to write into)

**Effort:** Large (3-4 weeks)

### Phase 3B: Lot Matching Engine

**Goal:** Automatically match order line item lot numbers to COAs on file.

**Scope:**
- Matching algorithm: exact match on `order_items.lot_number` = `documents.primary_metadata.lot_number` within the same tenant
- Fuzzy matching fallback: normalize lot numbers (strip leading zeros, ignore case/hyphens) before matching
- Partial match handling: orders with some lots matched and others missing
- Missing COA dashboard widget: shows orders blocked on missing COAs
- Missing COA notification: email alert when a lot has no matching COA
- Re-match trigger: when a new COA is ingested, check if it resolves any pending order items

**Dependencies:** Phase 2A (orders with lot numbers), Phase 1 (COAs with lot metadata)

**Effort:** Medium (2 weeks)

### Phase 4: Report Builder + Delivery

**Goal:** Assemble matched COAs into customer packages and deliver them.

**Scope:**
- Report assembly: collect all matched COAs for an order, compile into a delivery package
- Report templates: per-tenant email templates with variable substitution (customer name, order number, PO, product list, lot numbers)
- Email delivery: send COA package to customer email via Resend
- Portal delivery: customer can view/download their COA packages via a shared link (no login required, time-limited)
- Delivery tracking: log every send with timestamp, recipient, documents included
- Delivery dashboard: orders by status (pending, ready, sent), filter by customer/date
- Re-send: one-click re-delivery for any previously sent package
- Bulk delivery: send all "matched" orders for a day in one batch

**Dependencies:** Phase 3B (matched orders with COAs attached)

**Effort:** Medium (2-3 weeks)

### Phase 5: Webhook Adapter + CSV Adapter + Self-Service UI

**Goal:** Expand adapter coverage and make integration setup self-service.

**Scope:**
- Webhook adapter: unique URLs per integration, signature verification, payload field mapping
- CSV/File adapter: upload UI, column mapping builder, support for CSV/XLSX/EDI
- Self-service integration wizard: step-by-step setup flow for non-technical users
- Adapter templates: pre-built configurations for common systems (NetSuite, SAP B1, Dynamics 365, Fishbowl, QuickBooks)
- Integration health monitoring: automatic alerts when syncs fail repeatedly

**Dependencies:** Phase 3A (adapter framework)

**Effort:** Medium (2-3 weeks)

### Phase 6: Browser Automation Adapter (Future)

**Goal:** Last-resort adapter for systems with no API, no export, no webhooks.

**Scope:**
- Playwright-based browser agent running in a sandboxed environment
- Navigation script builder (visual step recorder or script editor)
- Screenshot-based debugging (see what the bot sees at each step)
- Session management (login caching, cookie persistence)
- Automatic retry with exponential backoff on UI changes
- Alert when scripts break (DOM structure change detection)

**Dependencies:** Phase 3A (adapter framework)

**Effort:** Large (4-6 weeks). This phase is deferred and only built when a tenant has no other option.

### Phase Summary

| Phase | Name | Effort | Cumulative Value |
|-------|------|--------|-----------------|
| 2A | Email Parser + Order Queue | 2-3 weeks | Orders parsed from ERP email, visible in queue |
| 2B | Manual Entry + Customers | 1 week | Fallback for missed emails, customer preferences stored |
| 3A | API Adapter Framework | 3-4 weeks | Direct ERP/WMS connections, WMS lot lookup |
| 3B | Lot Matching Engine | 2 weeks | COAs auto-matched to orders |
| 4 | Report Builder + Delivery | 2-3 weeks | Customer COA packages sent automatically |
| 5 | Webhook + CSV + Self-Service | 2-3 weeks | Broad adapter coverage, tenant self-service |
| 6 | Browser Automation | 4-6 weeks | Last-resort coverage for legacy systems |

---

## 9. Current User's Setup

Mapping the architecture to the immediate use case:

| Step | System | Adapter | Detail |
|------|--------|---------|--------|
| Order intake | ERP (daily 3:30pm email) | Email Parser | Subject pattern match, AI parses customer numbers (K#####/P######), names, and order numbers |
| Lot lookup | WMS (web-based) | API Adapter (preferred) or Browser Automation (fallback) | Order number → PO → lot numbers + products |
| COA matching | SupDox | Internal | `order_items.lot_number` matches `documents.primary_metadata.lot_number` (COAs already have lot metadata from Phase 1 intake) |
| Customer delivery | Email | Report Builder | Assemble matched COAs, send to customer email address |

**Implementation path:**

1. **Phase 2A first.** The daily ERP email is already arriving. Build the email parser adapter and order queue. This gives immediate visibility into daily order volume and customer needs.
2. **Phase 3B in parallel.** The lot matching engine can be built alongside the API adapter since it only depends on having orders with lot numbers (which can be manually entered during testing).
3. **Phase 3A for WMS.** Determine if the WMS has an API. If yes, build the API adapter config for it. If no, use manual lot entry (Phase 2B) as a bridge until browser automation is available.
4. **Phase 4 last.** Report building and delivery is the final step and depends on everything upstream being reliable.

---

## 10. Success Metrics

### Operational Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Order intake latency | < 2 minutes from email receipt to order in queue | Timestamp diff: email received → order created |
| WMS enrichment latency | < 1 minute per order | Timestamp diff: pending → enriched |
| COA match rate | > 95% of lots have a COA on file | `order_items WHERE lot_matched = 1` / total `order_items` |
| End-to-end time | < 5 minutes from ERP email to customer COA email (for fully auto-matched orders) | Timestamp diff: order created → status delivered |
| Manual intervention rate | < 10% of orders need human help | Orders that touch "error" status or have unmatched lots / total orders |

### Setup Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Integration setup time (API) | < 30 minutes for a tenant with API docs | Time from starting integration wizard to successful test connection |
| Integration setup time (Email) | < 10 minutes | Time from starting wizard to first parsed test email |
| New tenant onboarding | < 1 hour total (all integrations configured) | End-to-end setup time including testing |

### Business Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Daily labor saved | > 2 hours/day for a typical tenant | Survey / time comparison vs. manual process |
| Customer response time | Same-day COA delivery (currently next-day or later) | Time from customer order to COA delivery |
| Error rate | < 1% wrong COA sent to customer | Customer complaints / total deliveries |
