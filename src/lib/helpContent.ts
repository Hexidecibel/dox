/**
 * helpContent — typed content library for in-app self-documentation.
 *
 * Single source of truth for the explanatory copy that lives in:
 *   - <HelpWell> banners at the top of pages
 *   - <InfoTooltip> hover-help next to labels
 *   - <EmptyState> headlines + descriptions for empty lists
 *   - the /help admin docs viewer
 *
 * Phase D0 shipped only the scaffolding (top-level module keys with at
 * minimum a `headline` + one `well` entry each). Phases D1–D6 fill the
 * rest in incrementally as each module is woven up. D1 (this file's
 * primary expansion) fleshes out `connectors.*`.
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
  /** Optional column-header tooltip strings, looked up by column key. */
  columnTooltips?: Readonly<Record<string, string>>;
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

// ---------------------------------------------------------------------------
// Connectors — Phase D1 expanded shape.
// ---------------------------------------------------------------------------
//
// Connectors carry the most surface area in the app (list + detail with
// five intake doors + a multi-step wizard) so this module gets its own
// shape on top of `ModuleHelp`. Everything below is plain ASCII strings;
// the JSX consumes them directly without further formatting.

interface ConnectorsHelp extends ModuleHelp {
  list: ListSurface & {
    columnTooltips: Readonly<{
      slug: string;
      system: string;
      lastRun: string;
      status: string;
    }>;
  };
  detail: DetailSurface & {
    /** Tooltip on the slug pill in the header. */
    slugTooltip: string;
    /** Per-intake-door tooltips, surfaced next to each door title. */
    intakeDoorTooltips: Readonly<{
      manual: string;
      api: string;
      s3: string;
      public: string;
      email: string;
      remote: string;
    }>;
    /** Tooltip on the "Field mappings" section title. */
    fieldMappingsTooltip: string;
    /** Tooltip on the "Stored sample" section title. */
    sampleTooltip: string;
    /** Empty-state copy for the runs table. */
    runsEmptyTitle: string;
    runsEmptyDescription: string;
    /** Tooltips on the Health card metric labels. */
    healthCard: Readonly<{
      dispatched24h: string;
      successRate: string;
      lastError: string;
      perSourceBreakdown: string;
    }>;
    /** Column tooltips for the runs table. */
    runColumnTooltips: Readonly<{
      status: string;
      source: string;
      started: string;
      completed: string;
      found: string;
      created: string;
      errors: string;
    }>;
  };
  wizard: {
    /** HelpWell copy on the wizard page itself. */
    headline: string;
    well: string;
    steps: Readonly<{
      name: {
        headline: string;
        well: string;
        tooltips: Readonly<{
          name: string;
          slug: string;
          systemType: string;
        }>;
      };
      uploadSample: {
        headline: string;
        well: string;
        tooltips: Readonly<{
          fileFormats: string;
          paste: string;
        }>;
      };
      reviewSchema: {
        headline: string;
        well: string;
        tooltips: Readonly<{
          mapTo: string;
          confidence: string;
          extendedKey: string;
          formatHint: string;
          acceptAll: string;
          sheetPicker: string;
        }>;
      };
      livePreview: {
        headline: string;
        well: string;
      };
      save: {
        headline: string;
        well: string;
        tooltips: Readonly<{
          activate: string;
        }>;
      };
    }>;
  };
  /** Long-form documentation rendered on /help/connectors. */
  help: {
    sections: ReadonlyArray<{ heading: string; body: string }>;
  };
}

const connectors: ConnectorsHelp = {
  headline: 'Connectors',
  well:
    "Connectors are the channels you set up to ingest orders and customer data from external systems. Each connector has multiple delivery doors (manual upload, email, API, S3 bucket, public link); vendors use whichever fits their tooling.",
  list: {
    headline: 'Connectors',
    well:
      "Connectors are the channels you set up to ingest orders and customer data from external systems. Each connector has five delivery doors (manual upload, email, API, S3 bucket, public link); vendors use whichever fits their tooling.",
    emptyTitle: 'No connectors yet',
    emptyDescription:
      "Connectors are how you ingest orders and customer data from external systems. Set one up and you'll get five intake doors ready for vendors to use.",
    columnTooltips: {
      slug: 'URL-safe identifier used in vendor-facing addresses (email, API path, S3 bucket name, public link). Auto-generated from the connector name; rename via the wizard.',
      system: 'Loose grouping — ERP, WMS, or Other. Affects nothing functional; only shown in the list for orientation.',
      lastRun: 'Most recent successful or failed run, regardless of which intake door it came in through.',
      status: 'Active connectors process inbound files immediately. Drafts hold mappings + config but ignore inbound traffic until activated.',
    },
  },
  detail: {
    headline: 'Connector detail',
    well:
      "This is your connector's dashboard. The cards below show the five ways vendors can deliver files (manual, email, API, S3, public link). Each works independently — pick whichever fits the vendor's tooling. Below the doors: run history, field mappings, and connector config.",
    slugTooltip:
      'URL-safe identifier used in vendor-facing addresses (email, API path, S3 bucket name, public link). Vendors only ever see the slug, never the internal id.',
    intakeDoorTooltips: {
      manual:
        "Best for one-off testing or tiny vendors who can't automate. Drag a file in and the connector runs against it immediately.",
      api:
        'Best for vendors with automation scripts. Stable URL plus bearer token; can be hit programmatically from any HTTP client (curl, Python, etc.).',
      s3:
        'Best for vendors who already use AWS / S3 tooling. They get an S3-compatible bucket and an access key + secret; drop files via aws-cli, rclone, or boto3.',
      public:
        'Best for vendors with no tooling at all. A no-login web upload form they can hit from a browser. The URL itself is the credential — rotate or revoke if it leaks.',
      email:
        'Best for vendors already emailing reports as attachments. Send to the connector address; PDFs / CSVs / XLSX in the attachments are processed.',
      remote:
        'For unattended ingestion when files land in your own R2 bucket on a schedule. A poller checks the prefix every 5 minutes and runs against any new files.',
    },
    fieldMappingsTooltip:
      "Defines which columns in incoming files map to canonical order fields like order_number, customer, product, lot. Edit inline here, or click 'Edit in wizard' for a guided remap with a fresh sample.",
    sampleTooltip:
      "Last sample file used to discover this connector's schema. Re-test runs the current mappings against it; remap walks the wizard with a fresh file.",
    runsEmptyTitle: 'No runs yet',
    runsEmptyDescription:
      'Drop a file via any of the doors above (manual upload, email, API, S3, or public link) to see runs appear here. Each run shows the parser status, source door, and how many records were created.',
    healthCard: {
      dispatched24h:
        'Total runs dispatched against this connector in the last 24 hours, across every intake door.',
      successRate:
        'Percentage of dispatched runs that finished without errors. Below 70% turns red; below 90% turns yellow.',
      lastError:
        'Most recent failed run. Click View to scroll to the runs table for full context, including the parser error and a Retry button.',
      perSourceBreakdown:
        'Counts grouped by which intake door the run came in through (manual, email, api, s3, public_link). Helps narrow down which door a vendor is actually using.',
    },
    runColumnTooltips: {
      status:
        'Outcome: success, partial (some rows errored), error (no rows ingested), or running (in flight). Failed runs show the parser error inline below the chip.',
      source:
        'Which intake door the run came in through. NULL on legacy rows that pre-date Phase B5 source tagging.',
      started: 'When the run was queued.',
      completed: 'When the run finished, regardless of outcome.',
      found: 'Total rows the parser saw in the source file.',
      created: 'Rows that resulted in a new order or customer. Click the count to view the orders.',
      errors: 'Rows that failed to ingest. Click into a failed run for the per-row error list.',
    },
  },
  wizard: {
    headline: 'New connector',
    well:
      "You're creating a connector. Walk through the steps and once you save you'll land on the connector detail page with five intake doors ready for vendors to deliver files into.",
    steps: {
      name: {
        headline: 'Name your connector',
        well:
          "Give the connector a recognizable name and pick a system type. The slug derived from the name becomes the vendor-facing handle — it's used in the email address, API URL, S3 bucket name, and public link.",
        tooltips: {
          name: "A friendly label for admins. Pick something you'll recognize at a glance, like 'Daily ERP Report' or 'ACME Vendor Feed'.",
          slug: 'URL-safe handle baked into vendor-facing addresses. Lowercase, kebab-case, alphanumeric only (1-64 chars). Auto-generated from the name; type to override.',
          systemType:
            "Loose grouping — ERP, WMS, or Other. Doesn't change behavior; just helps you organize the list when you have many connectors.",
        },
      },
      uploadSample: {
        headline: 'Upload a sample',
        well:
          "Drop a representative file the vendor will deliver. We'll auto-detect the columns and pre-fill the field mappings in the next step. CSV / TSV / XLSX / PDF / EML / plain text are all supported.",
        tooltips: {
          fileFormats:
            'CSV / TSV / TXT up to 5 MB; XLSX / PDF up to 10 MB. EML supported for raw email captures. The file is uploaded once for schema discovery — it never leaves your tenant.',
          paste:
            'For when you only have a copy-pasted email or table. We process the text through the same schema-discovery pipeline as an uploaded file.',
        },
      },
      reviewSchema: {
        headline: 'Review the schema',
        well:
          "Confirm how each detected column maps onto a canonical dox field. High-confidence guesses are pre-applied — you only need to fix the ones marked with a low confidence chip or that we couldn't classify.",
        tooltips: {
          mapTo:
            'Pick a canonical dox field for this column (order_number, customer_name, etc.) or send it to extended_metadata as a free-form key. Choose Skip to ignore the column.',
          confidence:
            "How sure the AI is about its guess for this column. Above 70% gets auto-applied on first entry; below 50% the column stays unmapped and we ask you to pick. The chip is colored green / yellow / red so it's easy to scan.",
          extendedKey:
            "snake_case key the value lands under in `extended_metadata`. Defaults to a snake_case version of the column name; rename if you want a friendlier key.",
          formatHint:
            'Optional pattern hint for the parser. For dates, use a strftime-style pattern like YYYY-MM-DD. For ids, an example like SO-12345 lets the parser warn on mismatches.',
          acceptAll:
            "Bulk-apply every AI suggestion at or above the confidence threshold. Useful after you've manually fixed a few and want to settle the rest in one click.",
          sheetPicker:
            'XLSX workbooks with multiple sheets — pick which sheet the connector should ingest. Default is the sheet with the most detected columns.',
        },
      },
      livePreview: {
        headline: 'Live preview',
        well:
          "What the connector would actually emit with the current mappings. If anything looks wrong, hit Back and adjust. The preview updates automatically as you tweak.",
      },
      save: {
        headline: 'Review and save',
        well:
          "Final summary. Save as Draft to land the connector in standby (intake doors return 'inactive'), or Save & Activate to start accepting files immediately.",
        tooltips: {
          activate:
            "When active, every intake door processes files as they arrive. Drafts hold mappings + config but reject inbound traffic with an 'inactive' message — useful for staging a connector before going live.",
        },
      },
    },
  },
  help: {
    sections: [
      {
        heading: 'What connectors do',
        body:
          'A connector is a single ingestion channel for one upstream system or vendor. It owns a set of field mappings (which columns map onto canonical dox fields like order_number, customer_name, etc.), a sample file used during schema discovery, and five separate "intake doors" that each accept files independently. Files dropped into any door run through the same field mappings and produce the same downstream records — orders, customers, line items — that feed the COA workflow.',
      },
      {
        heading: 'The five intake doors',
        body:
          "Each connector exposes all five doors simultaneously; pick whichever fits the vendor's tooling. " +
          "Manual upload: drag a file directly onto the connector detail page. Best for one-off testing or vendors who cannot automate. " +
          "API drop: a stable URL plus a bearer token. Vendors POST a multipart file body from any HTTP client (curl, Python, Node). Best for vendors with automation scripts. " +
          "S3 drop: an auto-provisioned per-connector S3-compatible bucket plus an access key and secret. Vendors upload via aws-cli, rclone, boto3, or any S3 client. Best for vendors already on AWS tooling. " +
          "Public link: a no-login web upload form at /drop/<slug>/<token>. The URL itself is the credential, so treat it like a password. Best for vendors with no automation at all. " +
          "Email ingest: a per-connector inbox at <slug>@supdox.com. Vendors email files as attachments; PDFs, CSVs, and XLSX in attachments are processed. Best for vendors already emailing reports. " +
          "There is also a sixth, internal door — the scheduled R2 prefix poller — for files that land in your own R2 bucket and need to be ingested unattended.",
      },
      {
        heading: 'Slugs and naming',
        body:
          "The slug is the URL-safe identifier baked into every vendor-facing address. It must be lowercase, kebab-case, and alphanumeric (1 to 64 characters). " +
          "When you create a connector the slug is auto-generated from the name; type into the slug field to override. Once you save, the slug is locked into the email address (<slug>@supdox.com), the API URL (/api/connectors/<slug>/drop), the S3 bucket name (dox-<slug>-<random>), and the public link path. " +
          "Renaming a connector is fine — the slug is independent of the name and stays put unless you explicitly change it. Slugs must be globally unique across all tenants; the wizard surfaces a conflict suggestion if you pick one that's taken.",
      },
      {
        heading: 'Token rotation',
        body:
          "Three of the doors carry credentials that can be rotated independently: the API bearer token, the S3 access key + secret, and the public link token. Each rotate operation is a hard cutover — the moment you confirm, the old credential stops working. " +
          "Make sure you have a way to deliver the new credential to whoever was using the old one before you rotate. The S3 secret is special: we don't keep a recoverable copy, so it's only visible immediately after provision or rotate. Copy it before you navigate away.",
      },
      {
        heading: 'Field mappings',
        body:
          "Every connector has a single set of field mappings that every intake door uses. Mappings are split into core (the canonical dox fields like order_number, customer_name, line_quantity — required for downstream order processing) and extended (free-form metadata that gets stuffed into the extended_metadata column for later use). " +
          "Edit mappings inline on the connector detail page for quick tweaks, or click 'Edit in wizard' for a guided remap with a fresh sample file. The Live Preview step in the wizard shows what the parser would actually emit with the current mappings before you save.",
      },
      {
        heading: 'Common gotchas',
        body:
          "Vendor sees a 401 from the API drop? Their token is expired or was rotated — re-share the new one from the API drop card. " +
          "Email connector not picking up an email? Check the subject patterns on the Receive Info card. If patterns are set, only matching emails route to this connector; if you want to match every email for the tenant, leave patterns empty (and consider setting a sender filter instead so the connector isn't greedy). " +
          "S3 secret missing from the card? The plaintext secret is only shown immediately after provision or rotation. Hit Rotate to issue a fresh one — the bucket and access key id are preserved. " +
          "Public link returns 'not active'? The token was revoked, expired, or the connector itself is in Draft. Check the public-link card for the token state and the header card for active/draft status. " +
          "Field mappings show 'No core fields enabled'? Enable at least order_number on the field mappings card; the connector cannot ingest without it.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Other modules — unchanged from D0 scaffold; D2-D6 fill these in.
// ---------------------------------------------------------------------------

export const helpContent = {
  connectors,
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
} as const;

/** Top-level module keys (handy for /help nav generation, etc.). */
export type HelpModuleKey = keyof typeof helpContent;

/** Read-only handle to the full content library. */
export type HelpContent = typeof helpContent;

/** Re-export the connectors module shape for components that want a stronger contract. */
export type { ConnectorsHelp };
