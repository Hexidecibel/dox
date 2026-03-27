# Features

## 2026-03-26: Regulatory Document Management Expansion

### Products (Global Catalog)
- Global product catalog shared across tenants (super_admin manages)
- Tenant-product associations (which suppliers provide which products)
- Full CRUD API + admin UI

### Document Types (Per-Tenant)
- Per-tenant document type definitions (COA, Spec Sheet, SDS, etc.)
- Replaces freeform category with structured classification
- Full CRUD API + admin UI

### Structured Document Metadata
- First-class fields on documents: lot_number, po_number, code_date, expiration_date, document_type_id
- Accepted by ingest, create, update endpoints
- Searchable via document search and list filters

### Document-Product Linking with Expiration
- Many-to-many link between documents and products
- Per-link expiration date and notes
- ProductLinker UI component on document detail page
- Color-coded expiration badges
- MindStudio can send product links via ingest API (product_ids field)

### Smart File Naming Templates
- Per-tenant naming templates with placeholders ({lot_number}, {product}, {doc_type}, etc.)
- Applied automatically during document ingest
- Admin UI with live preview and clickable placeholder chips

### Email Ingest Webhook
- POST /api/webhooks/email-ingest for Mailgun/SendGrid inbound parse
- Maps sender domain to tenant via email_domain_mappings
- Extracts attachments and creates documents automatically
- Admin UI for managing domain mappings

### Expiration Dashboard & Alerts
- Dashboard page showing documents approaching expiration
- Summary cards (expired, critical, warning, ok)
- Configurable look-ahead period (7-365 days)
- Status filters and tenant scoping
- Email notifications to org_admins via Resend

### Document Bundles (Compliance Packages)
- Create named bundles, optionally linked to a product
- Add/remove documents with version pinning
- Download bundle as ZIP
- Draft/finalized workflow
- Reusable DocumentPicker component
