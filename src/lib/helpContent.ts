/**
 * helpContent — typed content library for in-app self-documentation.
 *
 * Single source of truth for the explanatory copy that lives in:
 *   - <HelpWell> banners at the top of pages
 *   - <InfoTooltip> hover-help next to labels
 *   - <EmptyState> headlines + descriptions for empty lists
 *   - the /help admin docs viewer
 *
 * Phase D0 ships only the scaffolding (top-level module keys with at
 * minimum a `headline` + one `well` entry each). Phases D1–D6 fill the
 * rest in incrementally as each module is woven up.
 *
 * Conventions:
 *   - Keys are stable. Renaming a key is a breaking change for any
 *     `<HelpWell id="...">` dismissal stored in a user's localStorage.
 *   - Copy is plain ASCII (no smart quotes) — keeps grep + diff sane.
 *   - Body strings stay short — long form lives in the /help viewer.
 */

interface ListSurface {
  /** Page heading the user sees. */
  headline: string;
  /** One-paragraph explanation rendered in a HelpWell at the top. */
  well: string;
  /** Empty-list title for <EmptyState>. */
  emptyTitle?: string;
  /** Empty-list supporting copy for <EmptyState>. */
  emptyDescription?: string;
}

interface DetailSurface {
  /** Page heading. */
  headline: string;
  /** Optional HelpWell body. */
  well?: string;
}

interface ModuleHelp {
  /** Default top-of-section copy used by /help and as a fallback. */
  headline: string;
  /** Top-level "what is this module?" paragraph. */
  well: string;
  /** Optional list-surface copy (the "/<module>" page). */
  list?: ListSurface;
  /** Optional detail-surface copy (the "/<module>/:id" page). */
  detail?: DetailSurface;
  /**
   * Per-field tooltip strings, looked up by field key. Filled out
   * incrementally per slice. Plain text only — wrap in InfoTooltip
   * children if you need rich content.
   */
  fields?: Readonly<Record<string, string>>;
}

export const helpContent = {
  connectors: {
    headline: 'Connectors',
    well:
      "Connectors are how dox ingests documents and signals from external systems — public drop links, scheduled R2 prefix polls, email parse hooks, and more. Each connector has its own credentials, schedule, and downstream pipeline.",
    list: {
      headline: 'Connectors',
      well:
        "Connectors are how dox ingests documents and signals from external systems. Set one up to receive vendor uploads, watch an S3/R2 prefix, or accept inbound emails.",
      emptyTitle: 'No connectors yet',
      emptyDescription:
        'Connectors are how you ingest orders and customer data from external systems. Click "New connector" to set one up.',
    },
  },
  orders: {
    headline: 'Orders',
    well:
      'Orders represent inbound purchase orders parsed from emails, CSVs, or ERP feeds. Each order ties customer + line items together and feeds the COA workflow downstream.',
  },
  customers: {
    headline: 'Customers',
    well:
      "Customers are the buyers your tenant ships to. dox tracks each customer's identifiers (account numbers, ship-to codes) so inbound orders can be matched to the right downstream pipeline.",
  },
  suppliers: {
    headline: 'Suppliers',
    well:
      'Suppliers are the vendors your tenant buys from. Each supplier is a first-class entity that documents (specs, COAs, SDS) link to via supplier_id.',
  },
  products: {
    headline: 'Products',
    well:
      'Products are the items your tenant tracks documents for. Documents link to products many-to-many, with optional per-link expiration dates so you can flag stale paperwork.',
  },
  documents: {
    headline: 'Documents',
    well:
      'The document library — every spec, COA, SDS, and report your tenant has uploaded or ingested. Documents are versioned: each new upload to the same external_ref appends a version rather than replacing.',
  },
  document_types: {
    headline: 'Document Types',
    well:
      'Document types (COA, Spec Sheet, SDS, etc.) are per-tenant. Each type can carry a naming format and extraction examples so the AI pipeline knows what to pull from a freshly ingested file.',
  },
  naming_templates: {
    headline: 'Naming Templates',
    well:
      "Naming templates control how ingested files are renamed at rest. Use generic placeholders like {lot_number}, {supplier}, or {doc_type} — anything in a document's metadata is fair game.",
  },
  bundles: {
    headline: 'Bundles',
    well:
      'Bundles are named compliance packages that pin specific document versions together. Build one for an audit, a customer ship-set, or a regulatory submission, then download as a single ZIP.',
  },
  reports: {
    headline: 'Reports',
    well:
      'Reports turn document and audit data into CSV/JSON exports. Use them for compliance attestations, customer ship-sets, or feeding downstream systems.',
  },
  activity: {
    headline: 'Activity',
    well:
      'Activity is a unified timeline of what has happened in your tenant — uploads, ingests, version bumps, role changes, and more. Filter by actor, type, or time range.',
  },
  audit: {
    headline: 'Audit Log',
    well:
      'The audit log records every privileged action: user creation, password resets, document deletions, role changes. Read-only and immutable — useful for compliance attestations.',
  },
  search: {
    headline: 'Search',
    well:
      'Full-text search across document titles, metadata, and file names. Use the filters on the left to narrow by tenant, supplier, product, or document type.',
  },
  tenants: {
    headline: 'Tenants',
    well:
      'Tenants are isolated organizations within dox. Each tenant has its own users, documents, suppliers, products, and document types. Visible to super_admin only.',
  },
  users: {
    headline: 'Users',
    well:
      "Users belong to a tenant and have one of four roles: super_admin (cross-tenant), org_admin (manage own tenant's users + audit), user (upload + edit), or reader (read-only).",
  },
  api_keys: {
    headline: 'API Keys',
    well:
      'API keys (prefix dox_sk_) provide programmatic access to the REST API via the X-API-Key header. Each key authenticates as the user who created it; revoke at any time.',
  },
  settings: {
    headline: 'Settings',
    well:
      "Tenant-level settings: branding, default document types, email-to-tenant domain mappings, and naming templates. Changes here apply to every user in the tenant.",
  },
  records: {
    headline: 'Records',
    well:
      "Records sheets are flexible tables for anything that doesn't fit the document library — quality issues, approval workflows, item requests. Each sheet can drive forms, kanbans, calendars, and workflows.",
  },
  approvals: {
    headline: 'Approvals',
    well:
      'Approvals are workflow steps that pause on a human decision. The decision page is a magic-link URL — recipients can approve, reject, or comment without logging in.',
  },
} as const satisfies Readonly<Record<string, ModuleHelp>>;

/** Top-level module keys (handy for /help nav generation, etc.). */
export type HelpModuleKey = keyof typeof helpContent;

/** Read-only handle to the full content library. */
export type HelpContent = typeof helpContent;
