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
          "Give the connector a recognizable name. The slug derived from the name becomes the vendor-facing handle — it's used in the email address, API URL, S3 bucket name, and public link.",
        tooltips: {
          name: "A friendly label for admins. Pick something you'll recognize at a glance, like 'Daily ERP Report' or 'ACME Vendor Feed'.",
          slug: 'URL-safe handle baked into vendor-facing addresses. Lowercase, kebab-case, alphanumeric only (1-64 chars). Auto-generated from the name; type to override.',
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
// Daily-driver modules — Phase D2 expanded shape.
// ---------------------------------------------------------------------------
//
// The list/detail surfaces below get full ListSurface / DetailSurface entries
// plus per-module long-form `help.sections` arrays that drive /help/<module>.
// Process pages (import, review_queue, ingest_history) deviate from the
// list/detail split and use a `main` section instead — see the inline shapes
// below.

interface ModuleHelpExpanded extends ModuleHelp {
  help?: { sections: ReadonlyArray<{ heading: string; body: string }> };
}

const orders: ModuleHelpExpanded = {
  headline: 'Orders',
  well:
    'Orders represent inbound purchase orders parsed from emails, CSVs, or ERP feeds. Each order ties customer + line items together and feeds the COA workflow downstream.',
  list: {
    headline: 'Orders',
    well:
      "This is every order that has landed in your tenant — from connector ingestion, manual entry, or API. Each row is a purchase order with its line items, customer link, and current status in the COA workflow. Click into one to see line items, matched lots, and the documents attached.",
    emptyTitle: 'No orders yet',
    emptyDescription:
      "Orders show up here when a connector ingests one or you create one manually. Set up a connector to point a vendor's order feed at dox, or hit New Order to enter one by hand.",
    columnTooltips: {
      orderNumber: 'The vendor / customer order number — usually the upstream system identifier (SO-12345, PO-9876, etc.). Matched against incoming COAs and documents.',
      customer: 'Customer the order is for. Resolved from customer_number or customer_name during ingest; click into the order to see the canonical customer record.',
      poNumber: "Purchase order number, when the upstream system separates that from the order number. Optional — many connectors only emit one of the two.",
      status:
        "Where this order is in the COA workflow. pending = just ingested, no enrichment yet. enriched = customer / products resolved. matched = COAs found for the lots on the order. fulfilled = all required docs attached. delivered = COA package sent to the customer. error = ingest or enrichment failed.",
      items: 'Total line items on the order.',
      matched: 'Line items that have a matched lot + COA. Counts against `items` for the matched / total ratio.',
      source: 'Which connector this order came from. Click the chip to filter the list to one connector.',
      created: 'When the order was first ingested or created.',
      lot: 'Lot / batch number for this line. Drives COA matching: ingested COAs that carry the same lot number get auto-attached to lines.',
      coa: 'The matched COA for this line. Click through for the file, version history, and metadata. Empty means no COA matched yet.',
    },
  },
  detail: {
    headline: 'Order detail',
    well:
      "Everything dox knows about this order: line items, customer, source connector, attached documents, and the audit trail of how it moved through the COA workflow.",
  },
  help: {
    sections: [
      {
        heading: 'What an order is',
        body:
          'An order in dox is the inbound purchase-order record that drives the COA workflow. It carries an order number, an optional PO number, a customer reference, line items (each pointing at a product), and zero or more attached documents. Orders are typically created by connector ingestion (parsed from a vendor email, CSV, or API drop) but can also be created manually from the New Order button.',
      },
      {
        heading: 'The order lifecycle',
        body:
          "Orders move through six statuses. pending — just ingested, customer / products not yet resolved. enriched — customer matched against the customer roster, line items resolved against the product catalog. matched — for each line, a lot has been picked and the COA for that lot is on file. fulfilled — every required document is attached. delivered — the COA package has been sent to the customer. error — something failed during ingest or enrichment; check the order detail for the specific error. " +
          "The progression is mostly automatic — pipeline jobs (enrichment + matching) run on creation. You only need to step in for matched ones (pick lots) and to confirm delivery.",
      },
      {
        heading: 'Filtering and search',
        body:
          "The search box matches against order number, PO number, customer name, and customer number. The status filter narrows to a single lifecycle stage. " +
          "Deep-link filters: clicking a connector chip on a run row in the connector detail page navigates here with `?connector_id=...`, restricting the list to orders from that one connector. Clear via the chip in the filter bar.",
      },
      {
        heading: 'Common questions',
        body:
          'Order is stuck in pending? Enrichment didn\'t fire — check the order detail for an error and re-run the pipeline. ' +
          'Customer column is blank? The connector emitted a customer_number that doesn\'t match any record. Add the customer first, then re-run enrichment. ' +
          'Items / Matched mismatch persisting? Some lots have no COA on file. Either upload the missing COAs (the AI pipeline will match them on lot number) or pick a substitute lot.',
      },
    ],
  },
};

const customers: ModuleHelpExpanded = {
  headline: 'Customers',
  well:
    "Customers are the buyers your tenant ships to. dox tracks each customer's identifiers (account numbers, ship-to codes) so inbound orders can be matched to the right downstream pipeline.",
  list: {
    headline: 'Customers',
    well:
      "Your tenant's customer roster. Each customer has an identifier (customer_number), a name, optional contact email, and a default COA delivery preference (email, portal, or none). Inbound orders are auto-matched against this list during enrichment.",
    emptyTitle: 'No customers yet',
    emptyDescription:
      "Add the customers your tenant ships to and dox can auto-match inbound orders against them. You can also let the system create customers on the fly during connector ingest if your data already includes consistent customer numbers.",
    columnTooltips: {
      customerNumber: 'The upstream identifier for the customer — usually their account number or ship-to code in your ERP. Used to match inbound order rows to a customer record.',
      name: "Display name for the customer. Shown on orders, COA packages, and audit reports.",
      email: 'Default email address for COA delivery. Used when delivery method is set to "email"; can be overridden per order.',
      coaDelivery:
        "How COAs reach this customer once an order is fulfilled. email = automated send to the address on file. portal = customer logs into your dox tenant. none = no automatic delivery (you handle distribution out-of-band).",
      status: 'Active customers receive deliveries. Inactive customers stay on file but are skipped by the delivery pipeline — useful for archived accounts.',
    },
  },
  detail: {
    headline: 'Customer detail',
    well:
      "All orders, contacts, and delivery preferences for one customer. Use this to spot-check the COA history for a single buyer, update their delivery method, or look up their account number.",
  },
  help: {
    sections: [
      {
        heading: 'What a customer is',
        body:
          "A customer in dox is one of the buyers your tenant ships to. Each record carries a customer_number (the upstream identifier from your ERP), a display name, an optional email, and a default COA delivery method. Customer records are tenant-scoped — a customer in one tenant is invisible to others.",
      },
      {
        heading: 'How customers get matched',
        body:
          "When a connector ingests an order, the enrichment step looks up the customer using customer_number first, then customer_name as a fallback. If neither matches a record, the order lands in pending status with customer_id null until you either create the customer or correct the data. " +
          "Some connectors (configured in their wizard) auto-create a customer record when a new customer_number arrives — saves you from babysitting the roster, at the cost of fuzzy duplicates if the upstream system isn't disciplined about identifiers.",
      },
      {
        heading: 'COA delivery methods',
        body:
          "Each customer has a default delivery method that drives where COAs go when an order is fulfilled. email — automated send to the address on the customer record (or per-order overrides). portal — the customer logs into your dox tenant and downloads from there (useful for high-volume buyers). none — no automatic delivery; the COA package is generated and you handle distribution by hand. " +
          "Per-order overrides are possible — open an order and use the Delivery section to send to a different address or method without changing the customer's default.",
      },
    ],
  },
};

const suppliers: ModuleHelpExpanded = {
  headline: 'Suppliers',
  well:
    'Suppliers are the vendors your tenant buys from. Each supplier is a first-class entity that documents (specs, COAs, SDS) link to via supplier_id.',
  list: {
    headline: 'Suppliers',
    well:
      "Your tenant's supplier roster. Each supplier has a name, a list of aliases (alternate names that may show up on inbound docs), an active flag, and a roll-up count of products and documents. Used to scope COAs, specs, and SDS sheets to a specific vendor.",
    emptyTitle: 'No suppliers yet',
    emptyDescription:
      "Add the suppliers your tenant sources from and dox can attach inbound COAs to the right vendor. Aliases are useful when the same supplier ships docs under multiple legal names — list them all and the AI pipeline will treat them as one.",
    columnTooltips: {
      name: "Canonical name for the supplier. Used everywhere by default; aliases handle variant names that appear on inbound docs.",
      aliases:
        "Alternate names this supplier might appear as on inbound documents (legal name vs. brand name, abbreviations, regional subsidiaries). The AI pipeline matches incoming COAs against this list when picking the supplier_id.",
      status: 'Active suppliers receive doc attachments. Inactive ones stay on file (with their existing docs) but new inbound docs skip them during matching.',
      created: 'When the supplier record was first created.',
    },
  },
  detail: {
    headline: 'Supplier detail',
    well:
      "Everything tied to one supplier: products they ship, extraction templates that apply to their docs, and the document library scoped to their supplier_id. Use the tabs to switch between views.",
  },
  help: {
    sections: [
      {
        heading: 'What a supplier is',
        body:
          'A supplier in dox is one of the vendors your tenant buys from. Each record has a canonical name, an alias list (for variant names that appear on inbound documents), and an active flag. Suppliers are tenant-scoped — each tenant maintains its own roster.',
      },
      {
        heading: 'Aliases and matching',
        body:
          "Aliases are the cleanup tool for when a supplier shows up under multiple names on inbound documents — legal name vs. brand name, regional subsidiaries, abbreviations. " +
          "Add every variant you've seen to the aliases list (comma-separated when editing). When the AI pipeline parses a COA and tries to assign supplier_id, it checks the canonical name AND every alias across all tenant suppliers — so 'ACME Corp', 'ACME Industries Inc', and 'ACME' all land on the same record.",
      },
      {
        heading: 'Products, templates, and documents',
        body:
          "Open a supplier to see three tabs. Products — the catalog items this supplier ships. Templates — extraction templates pinned to the supplier + document type pair (set up via the Import / Review Queue flow). Documents — every doc with a supplier_id pointing here, listed newest first. The Templates tab is where you tune auto-ingest thresholds for high-trust supplier+doctype pairs.",
      },
      {
        heading: 'Common questions',
        body:
          "Same supplier showing up twice? Likely a case mismatch or punctuation difference (\"ACME, Inc.\" vs \"ACME Inc\"). Pick the canonical record, add the duplicate's name as an alias, then deactivate or delete the duplicate. " +
          "Inbound doc not getting tagged with the right supplier? Check the supplier's aliases — if the name on the doc isn't there, the AI can't match. Add it, then re-run the queue item.",
      },
    ],
  },
};

const products: ModuleHelpExpanded = {
  headline: 'Products',
  well:
    'Products are the items your tenant tracks documents for. Documents link to products many-to-many, with optional per-link expiration dates so you can flag stale paperwork.',
  list: {
    headline: 'Products',
    well:
      "Your tenant's product catalog — the items dox tracks documents for. Each product has a name, slug, optional description, and an active flag. Documents link to products many-to-many; an order line item points at a product so dox knows which COAs to pull.",
    emptyTitle: 'No products yet',
    emptyDescription:
      "Add the products your tenant ships and dox can route incoming COAs to the right item. You can also let connectors create products on the fly during ingest if upstream order data is consistent enough.",
    columnTooltips: {
      name: 'Canonical product name. Shown on orders, line items, and COA packages.',
      slug: 'URL-safe identifier auto-generated from the name. Used in API paths and as a stable key when product names change.',
      description: 'Optional free-form notes about the product. Not used by any matching logic.',
      status: 'Active products show up in the catalog and accept document links. Inactive ones are hidden from new doc + order flows but keep their existing links.',
    },
  },
  detail: {
    headline: 'Product detail',
    well:
      "All documents and orders tied to one product. Use this to audit the doc library for a single SKU or check which orders include the item.",
  },
  help: {
    sections: [
      {
        heading: 'What a product is',
        body:
          "A product in dox is a catalog item your tenant tracks paperwork for — typically a SKU or item code from your ERP. Products are tenant-scoped (since v0.1.17, see migration 0017). They link to documents many-to-many with optional per-link expiration dates and notes.",
      },
      {
        heading: 'Linking documents to products',
        body:
          "Documents are tied to products via the document_products join table. Each link can carry an expiration_date and optional notes — useful when a single doc covers multiple products with staggered re-test cadences. " +
          "Links are created during ingest (the AI pipeline pulls product references out of the doc and matches them against the catalog) or manually from the document detail page. The Expiration Dashboard surfaces products whose docs are about to go stale.",
      },
      {
        heading: 'Auto-create on ingest',
        body:
          "If a connector emits a product reference (line item with a product_name) that doesn't match any catalog entry, the default behavior is to create the product on the fly. This keeps small / dynamic catalogs alive without manual upkeep — the cost is fuzzy duplicates if upstream data isn't consistent. " +
          "If you'd rather have explicit control, set the connector's auto-create-product config to false and unmatched line items will surface as enrichment errors instead.",
      },
    ],
  },
};

const documents: ModuleHelpExpanded = {
  headline: 'Documents',
  well:
    'The document library — every spec, COA, SDS, and report your tenant has uploaded or ingested. Documents are versioned: each new upload to the same external_ref appends a version rather than replacing.',
  list: {
    headline: 'Documents',
    well:
      "Your tenant's document library. Each card shows a doc — title, type (COA, Spec, SDS), supplier, and the products it covers. Filter by status, document type, or use the AI search box to ask in natural language.",
    emptyTitle: 'No documents yet',
    emptyDescription:
      "Documents land here once you import them (Import page), an email connector ingests one, or an API call posts one. Hit the AI search if you've imported some but they aren't turning up — natural-language queries like \"COAs for butter from March\" use a different path than the keyword filters.",
    columnTooltips: {
      title: 'The document title — extracted from the file or set during ingest. Used as the primary display name everywhere.',
      type:
        'The document type (COA, Spec Sheet, SDS, etc.) — per-tenant, configured under Document Types. Drives which extraction template runs on inbound files.',
      supplier: 'Which supplier the doc is from. Pulled from the doc content during ingest and matched against your supplier roster.',
      status:
        "active = current and visible. archived = hidden from default views but still queryable. New uploads to the same external_ref bump the version on the active record rather than creating a new one.",
      version: 'Current version number. Each ingest of a doc with the same external_ref appends a new version; older versions stay accessible via the version history.',
    },
  },
  detail: {
    headline: 'Document detail',
    well:
      "Everything dox knows about one document: file preview, metadata (lot, expiration, supplier, products), version history, and the audit trail of who uploaded what when. Use the actions in the header to download, archive, or delete.",
  },
  help: {
    sections: [
      {
        heading: 'What a document is',
        body:
          "A document in dox is a versioned file with structured metadata — a COA for a specific lot, a spec sheet for a product, an SDS for a supplier. Each document has a title, a document_type, an optional supplier_id, links to one or more products, and a primary_metadata JSON blob with the fields the AI pipeline extracted (lot_number, expiration_date, etc.). The actual file lives in R2 and is served via a signed URL.",
      },
      {
        heading: 'Versioning',
        body:
          "Documents are versioned via external_ref. When a new file is ingested with the same external_ref + tenant_id as an existing doc, dox appends a new version to the existing record rather than creating a duplicate. The current_version field on the doc points at the latest. Older versions remain in document_versions and are accessible via the version history on the detail page. " +
          "external_ref defaults to the doc's stable upstream ID (e.g. lot number for a COA) — the connector / ingest flow generates one if the source doesn't have one.",
      },
      {
        heading: 'Search and filtering',
        body:
          "Two search modes. Keyword search (left of the AI toggle) — matches title, description, tags, file names, and metadata via SQLite full-text. Fast, exact match. AI search — natural language ('COAs for Butter from March'); the query is parsed by an LLM into structured filters (document_type, product, supplier, date range, expiration window) and then executed. Slower, more forgiving. " +
          "Filter chips: status (active vs archived), category (legacy field — being phased out in favor of document_type), and document type (the per-tenant doctype dropdown).",
      },
      {
        heading: 'Common questions',
        body:
          'Imported a doc but it isn\'t showing up? Check the Review Queue — depending on its confidence score it may be waiting for human approval. Once approved it lands in the library. ' +
          'Same doc keeps creating duplicates? The external_ref isn\'t stable — open one, copy its external_ref, compare it to what the upstream system is sending. The connector wizard lets you fix the field mapping that produces external_ref. ' +
          'AI search returns nothing? The natural-language parser couldn\'t find structured filters in the query. Try keyword search or simplify the query (e.g. just the product name).',
      },
    ],
  },
};

const importHelp = {
  headline: 'Import',
  well:
    'Smart upload for documents. Drop a file, the AI pipeline extracts fields, and you confirm before it lands in the library. Higher-confidence + matched-template runs auto-ingest without review.',
  main: {
    headline: 'Import',
    well:
      "Upload one or more files and the smart-upload pipeline runs each through extraction (AI parses fields, detects type, finds product names + lot numbers) and queues them for review. High-confidence runs that match an extraction template can auto-ingest without ever stopping here. Files that need human review surface for editing in the Review Queue or the per-result cards below.",
    sectionTooltips: {
      dropZone:
        'Drag files in or click to browse. PDF, image, CSV, and XLSX are all supported. Multiple files at once run in parallel through extraction.',
      docTypePreselect:
        "Pre-pick a document type to skip AI's type-detection step. Useful for batch uploads where you know everything in this drop is one type (e.g. all COAs). Leave on \"Let AI detect\" if files are mixed.",
      tenantSelect: 'super_admin only — pick which tenant the import lands in. Defaults to the currently selected tenant.',
      processButton: 'Kick off extraction. Files queue for AI processing in the background; you\'ll move to the queued screen and can come back to review when ready.',
      confidenceChip:
        "How sure the AI was about its overall extraction. >=80% high (green) — fields are likely right. 50-79% medium (yellow) — spot-check the fields. <50% low (red) — assume nothing is right and re-check every field.",
      autoIngestedChip: "This doc skipped review entirely — a matched extraction template authorized the AI to ingest it directly because confidence cleared the template's threshold.",
      templateChip: "An extraction template (saved supplier + doc-type field mapping) matched this doc. The AI used the template's field hints, which usually means tighter, more accurate extraction.",
      duplicateBadge: "dox spotted an existing document with the same external_ref. Importing this would bump the version on the existing doc rather than create a new one — confirm that's what you want.",
      summary: "AI-generated one-line summary of what the document is. Useful as a sanity check that the file is what you thought it was.",
      ratingThumbs: "Tell the system whether the extraction was correct. Up = the fields are right. Down = significantly wrong. Ratings feed the learning loop that tunes future extractions.",
    },
  },
  help: {
    sections: [
      {
        heading: 'What Import does',
        body:
          'Import is the manual entry point for documents — drag files in, the AI pipeline runs extraction, and you confirm before they land in the library. It coexists with email and API ingestion (those bypass this page entirely) but is the right place for one-off uploads or batches that came in via a non-automated channel.',
      },
      {
        heading: 'The three stages',
        body:
          'Upload — pick files, optionally pre-select a document type, hit Process. Files are uploaded to R2 and a processing-queue row is created for each. ' +
          'Queued — confirmation that the queue rows were created. The AI extraction runs asynchronously; you can navigate away and check back via the Review Queue. ' +
          'Review — for each file, a card shows the file preview, the AI-extracted fields (editable), the confidence score, and a final Import button. High-confidence template-matched runs may have auto-imported and show an \"Imported\" badge directly. Edit any wrong fields and hit Import to commit.',
      },
      {
        heading: 'Auto-ingest and templates',
        body:
          "An extraction template is a saved supplier + document-type pair with a field mapping and a confidence threshold. Templates are created from the Review Queue (after you correct an AI extraction, dox offers to save the corrections as a template for that supplier+doctype). Future docs from the same supplier+doctype that match the template skip review and auto-ingest if their confidence clears the threshold. Tune thresholds on the Supplier detail page → Templates tab.",
      },
      {
        heading: 'Common questions',
        body:
          "Doc shows duplicate detected? An existing doc has the same external_ref. Re-importing will bump the version. Confirm by checking the existing doc, then proceed if appropriate. " +
          "Confidence is low? The AI couldn't extract cleanly. Edit the fields by hand on the result card, then import. Saving corrections feeds future template-matching. " +
          "Files queued forever? The processing worker may be down. Check the Ingest History page — if items are stuck in 'queued' or 'processing' for >5 minutes, escalate to ops.",
      },
    ],
  },
} as const;

const reviewQueue = {
  headline: 'Review Queue',
  well:
    "AI extraction landing pad. Items here are documents the pipeline has parsed but isn't confident enough to ingest unattended. Review each, correct any wrong fields, then approve or reject.",
  main: {
    headline: 'Review Queue',
    well:
      "Every document the AI pipeline processed but didn't auto-ingest lives here. Review the extracted fields against the original file, fix anything wrong, then approve to push the doc into the library or reject to discard. Approving an item with corrections also feeds the learning loop — future docs from the same supplier+doctype get tighter extractions.",
    fieldTooltips: {
      confidence:
        "Overall extraction confidence from the AI. >=80% high (likely right). 50-79% medium (spot-check). <50% low (re-check everything). Confidence factors in field-by-field certainty plus document-type detection accuracy.",
      status:
        "pending = waiting on you. approved = you confirmed and the doc is now in the library. rejected = you discarded; the file stays in R2 but never becomes a document. Use the filter chips at the top to switch views.",
      autoIngested:
        "Doc skipped this queue entirely — a matched extraction template let the AI commit it directly. These show up with status=approved and processing_status=ready. Use the \"Auto-ingested only\" toggle to audit recent unattended ingests.",
      templateMatch:
        "An extraction template (saved supplier + doc-type field mapping) matched this doc. Field assignments came from the template's hints, which usually tightens extraction.",
      processingStatus:
        "queued — file uploaded, AI hasn't started. processing — extraction in flight. ready — extraction finished, fields are populated and you can review. error — extraction failed; click into the item for the error message.",
      docTypeFilter: 'Narrow the queue to a single document type. Useful when you want to plough through, say, all the pending COAs in one sitting.',
      tenantFilter: 'super_admin only — filter to one tenant. Defaults to all tenants you have access to.',
      autoIngestedToggle: "Show only docs that auto-ingested (skipped this queue). Lets you spot-check the unattended pipeline without paging through approved manual reviews.",
    },
  },
  help: {
    sections: [
      {
        heading: 'What the Review Queue is',
        body:
          "The Review Queue is the human-in-the-loop checkpoint for the AI extraction pipeline. Every file that lands via Import, email, or API runs through extraction and gets a confidence score; if confidence is below the auto-ingest threshold (or no extraction template matched), the result lands here for a human to confirm. " +
          "Approving an item with field corrections does two things: pushes the doc into the library and feeds the corrections back into the learning loop — the supplier + doctype pair will get a tighter extraction next time.",
      },
      {
        heading: 'The review flow',
        body:
          "Click an item to expand. Two-column layout: file preview on the left, extracted fields on the right. Compare them. Edit any field that's wrong (the AI is fast but not infallible — dates and lot numbers are the usual offenders). " +
          "Three actions. Approve — commits the doc to the library with whatever fields are currently filled. Reject — discards the queue item; the file stays in R2 but never becomes a document. Save Template — only shown after corrections, saves the corrected field mapping as an extraction template for this supplier+doctype so future docs auto-extract correctly.",
      },
      {
        heading: 'Auto-ingested items',
        body:
          'Auto-ingested docs skip the queue entirely (they go straight from extraction to the library) but still show up here with status=approved and an "Auto-ingested" badge. Toggle "Auto-ingested only" at the top to audit recent unattended ingests — handy for spot-checking a high-volume connector. Confidence on these is always >= the matched template\'s threshold; if you see a wrong field, lower the threshold or update the template on the Supplier detail page.',
      },
      {
        heading: 'Common questions',
        body:
          'Item stuck in processing? Extraction worker may be down. Check Ingest History; if the same item is in "processing" for >5 min, escalate. ' +
          'Approving but the doc isn\'t showing in the library? Check the Documents page filters — by default only active docs show. Newly approved ones are active immediately. ' +
          "AI keeps getting the same field wrong? After correcting, save the corrections as an extraction template (Save Template button on the expanded item). Future docs from the same supplier+doctype will use the corrected mapping.",
      },
    ],
  },
} as const;

const ingestHistory = {
  headline: 'Ingest History',
  well:
    'Full pipeline view across every queue item — source door, processing status, AI extraction, review outcome, and final ingest. Use it to audit the flow when something looks off.',
  main: {
    headline: 'Ingest History',
    well:
      "The complete audit trail for the AI ingest pipeline. Every file that hit the queue (regardless of source) is one row here, with its journey from upload through extraction, review, and final document creation. Use it to debug stuck items, audit auto-ingest rates, or trace how a specific doc ended up where it did.",
    columnTooltips: {
      timestamp: 'When the queue item was created — i.e. when the file landed in dox via Import, email, or API.',
      fileName: 'Original file name as uploaded. Hover for the full name + size.',
      source:
        "Which intake door brought the file in. Import = manual upload via /import. Email = parsed from an inbound email connector. API = posted to /api/queue/upload. Source detail (sender, etc.) shown beneath when known.",
      processing:
        "Where the file is in the AI pipeline. queued = waiting for the worker. processing = extraction running. ready = extraction finished and fields are populated. error = extraction failed; expand for the error message.",
      reviewStatus:
        "Human-in-the-loop outcome. pending = sitting in the Review Queue. approved = a human (or auto-ingest) confirmed and the doc was created. rejected = a human discarded.",
      confidence:
        "Overall AI confidence in the extraction (0-100). Drives whether auto-ingest fires (template + threshold gates) and informs how carefully a human should review. Color-coded green/yellow/red.",
      supplier: "Supplier the AI assigned (matched against your supplier roster + aliases). Empty when the AI couldn't pick one — usually because no record matched.",
      docType: "Document type the AI assigned, or its raw guess if no per-tenant doctype matched. The doc-type-id column lights up when the guess matches a configured type; otherwise the guess shows as a label-only chip.",
      templateMatch: "An extraction template matched — the AI used a saved supplier+doctype field mapping. Tighter extraction, often auto-ingestible.",
      autoIngested: "This file went from queued straight to approved without a human review. Allowed because a template matched and confidence cleared its threshold.",
    },
    pipelineStageTooltips: {
      reviewFilter: 'Slice the history by the human-review outcome — useful for finding everything you rejected last week, or auditing the auto-approved (ingested) bucket.',
      processingFilter: 'Slice by where in the AI pipeline things landed. \"Error\" is the high-value filter when something\'s broken — surfaces every extraction that failed.',
    },
  },
  help: {
    sections: [
      {
        heading: 'What Ingest History is',
        body:
          "Ingest History is the audit trail for the AI ingest pipeline. Every file that lands in the processing queue — regardless of source (Import, email, API) — appears here as one row. The row carries the file's journey: when it arrived, which door it came in through, the AI extraction outcome (status + confidence), whether a human approved or rejected it, and whether auto-ingest fired. " +
          "Think of it as the join across Import + email-ingest + API + Review Queue: a single chronological view of everything the pipeline has touched.",
      },
      {
        heading: 'Pipeline stages',
        body:
          "Each row reflects up to four stages. " +
          "1. Source — which intake door (Import / email / API). " +
          "2. Processing — the AI extraction (queued -> processing -> ready / error). " +
          "3. Review — human-in-the-loop outcome (pending / approved / rejected; auto-ingest skips human review and lands at approved directly). " +
          "4. Ingest — the actual document creation, only if review was approved. " +
          "Filter chips at the top let you slice by review status and processing status independently — pair them to find, say, every error-state item that's still pending review.",
      },
      {
        heading: 'Using it for debugging',
        body:
          "When a doc \"didn't show up\", this is where you start. Filter to the file name (via the source detail) or the time window. If processing = error, expand the row to see the message — usually a malformed file or an extraction template misconfigured. If processing = ready but review = pending, the item is sitting in the Review Queue waiting on a human. If review = approved but the doc isn't in the library, check the Documents page filters (active/archived). " +
          "For stuck-pipeline triage, filter processing = queued or processing and check timestamps. Anything older than ~5 minutes in queued or processing means the worker is wedged.",
      },
      {
        heading: 'Common questions',
        body:
          'Why is the same file in here twice? Re-uploads create new queue rows even if they\'re duplicates by external_ref. Approve one and reject the rest. ' +
          'Confidence column is empty? The extraction errored before scoring (file unreadable, supplier extraction failed, etc.). Expand for the error. ' +
          'Auto-ingested rate looks low? Means few extraction templates exist or thresholds are too high. Save more templates from the Review Queue.',
      },
    ],
  },
} as const;

const search: ModuleHelpExpanded = {
  headline: 'Search',
  well:
    'Full-text search across documents and orders. Toggle the AI button to use natural-language queries; the parser converts them into structured filters before running.',
  list: {
    headline: 'Search',
    well:
      "Cross-cutting search over your tenant's documents and orders. Two tabs: Documents (titles, tags, file content, metadata) and Orders (order #, customer, PO, line items). Each tab supports keyword search by default and an AI mode that takes natural language and converts it to structured filters.",
    columnTooltips: {
      aiToggle: "Switch between keyword search (exact match) and natural-language search (LLM parses your query into filters). Keyword is faster; AI is more forgiving when you don't know the exact words used.",
      docCategory: 'Filter docs by the legacy category field — being phased out in favor of document_type. Most tenants leave this alone.',
      docDateRange: "Restrict to docs created or updated within a window. Date-from inclusive, date-to inclusive — both optional.",
      orderStatus: "Filter orders to a single lifecycle stage (pending, enriched, matched, fulfilled, delivered, error).",
      exportFormat: "Pick the export format. CSV for spreadsheets and BI tools; JSON for piping into another system. Export only available on documents tab in keyword mode.",
      relevanceScore: 'How closely the result matches the query (0-100). Computed by the search engine when AI mode is on; hidden in keyword mode where matches are binary.',
    },
  },
  help: {
    sections: [
      {
        heading: 'What Search does',
        body:
          'Search is the cross-cutting query surface for documents and orders. Two tabs (Documents, Orders), two modes per tab (keyword, AI). Use it when you don\'t want to navigate to the specific list page first — same data, just a query box up front.',
      },
      {
        heading: 'Keyword vs. AI mode',
        body:
          "Keyword search is exact-match SQLite full-text against title, description, tags, file_name, and indexed file content (for docs); order_number, po_number, customer fields (for orders). Fast, predictable, but you have to know the right words. " +
          "AI mode takes your natural-language query and runs it through an LLM that emits structured filters — \"COAs for Butter from March\" becomes {document_type: 'COA', product: 'Butter', date_from: '2025-03-01'}. The structured query then runs against the same data. Slower and pricier per query, but tolerant of fuzzy wording.",
      },
      {
        heading: 'Filters and exports',
        body:
          "Document keyword search supports category + date-range filters, plus a CSV/JSON export of the result set (uses the same query the search ran). Order keyword search supports a status filter. AI mode disables the manual filters because the LLM produces its own. " +
          "Tenant scoping always applies — super_admin sees only the tenant currently selected in the tenant switcher; others only their own tenant.",
      },
      {
        heading: 'Common questions',
        body:
          "AI search returned nothing? The parser couldn\'t pull structured filters from your query. Try keyword mode or simplify the wording. " +
          "Search returned more than expected? Keyword search ORs across fields by default — a query that matches a tag won\'t exclude docs that don\'t. Refine via the manual filters. " +
          "Export is empty? You\'re in AI mode (export not supported there) or no docs matched — try export from keyword mode.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Admin/config modules — Phase D3 expanded shape.
// ---------------------------------------------------------------------------
//
// The shapes below mirror what D2 introduced: each module gets a `list` (or
// `main` for non-list surfaces), per-column tooltips, empty-list copy, and a
// long-form `help.sections` array consumed generically by /help/<module>.

const documentTypes: ModuleHelpExpanded = {
  headline: 'Document Types',
  well:
    "Document types (COA, Spec Sheet, SDS, etc.) are per-tenant tags. Each type carries optional naming-format hints and extraction-field guidance so the AI pipeline knows what to pull when an inbound file is classified as that type.",
  list: {
    headline: 'Document Types',
    well:
      "Per-tenant catalog of the document categories you care about — Certificate of Analysis, Spec Sheet, SDS, Lab Report, etc. Each type can flip on auto-ingest (skip review when extraction confidence clears the bar), control whether tabular data is extracted, and carry a naming-format hint plus an extraction-field list that the AI uses to tighten parsing on inbound files.",
    emptyTitle: 'No document types yet',
    emptyDescription:
      "Document types are how dox classifies inbound files. Add the categories your tenant cares about (COA, Spec Sheet, SDS, etc.) and the AI pipeline will route every ingest to one of them.",
    columnTooltips: {
      name: 'Display name for the document type — shown on documents, in the Review Queue, and in the type filter dropdowns. Pick something users will recognize at a glance (COA, Spec Sheet, SDS).',
      slug: 'URL-safe identifier auto-generated from the name. Stable across renames; used in API paths and as the canonical key when matching the AI\'s detected document_type to your catalog.',
      description: "Optional free-form notes about what this type is and isn't. Surfaced as a tooltip in pickers; doesn't affect any matching logic.",
      tenant: 'Which tenant owns this document type. Document types are tenant-scoped — every tenant maintains its own catalog.',
      status: 'Active types show up in pickers and accept new ingests. Inactive types are hidden from new flows but keep their existing documents.',
      created: 'When the document type was first created.',
      autoIngest:
        "When on, documents the AI extracts as this type with confidence >= the auto-ingest threshold skip the Review Queue and land in the library directly. Requires a few approved examples to calibrate, so the toggle is a no-op for the first 3 ingests of each (supplier, type) pair.",
      extractTables:
        'When on, the AI also extracts tabular data (test results, spec rows, line items) into structured tables on the document. Off keeps extraction to scalar fields only — faster, less reliable for spec / lab docs that hinge on table content.',
      namingFormat:
        "Per-type filename template applied at ingest, e.g. {lot_number}_{product}_{doc_type}.{ext}. Placeholders are any metadata key the AI extracts — {lot_number}, {supplier}, {expiration_date}, etc. Falls back to the source filename when a placeholder is missing. Defined on the document type so all ingests of that type get the same naming convention.",
      extractionFields:
        "Comma-separated list of canonical fields the AI is asked to look for when classifying a document as this type — e.g. lot_number, expiration_date, manufacturer, product_name. Acts as a hint to the LLM (and pre-populates editable fields in the Review Queue). Leave blank to let the AI guess from the file alone.",
    },
  },
  detail: {
    headline: 'Document type detail',
    well:
      "Configuration for one document type — naming format, extraction fields, and the auto-ingest / extract-tables toggles. Most tenants set this up once per category and revisit when they want to tighten extraction on a noisy supplier.",
  },
  help: {
    sections: [
      {
        heading: 'What document types are',
        body:
          "A document type is a tenant-scoped category for inbound files — Certificate of Analysis, Spec Sheet, Safety Data Sheet, Lab Report, etc. Every document in the library carries a document_type_id, set at ingest by the AI's classifier and confirmed (or corrected) by a reviewer. Document types drive: which extraction template the AI applies, the naming format used to rename the file at rest, the type filter in the Documents list, and the auto-ingest gate.",
      },
      {
        heading: 'Naming format — what it is and why',
        body:
          "The naming_format field is a string like {lot_number}_{product}_{doc_type}.{ext}. When a file ingests as this document type, dox renames it to match — so the file in R2 (and the file_name shown in the library) follows your organization's convention rather than whatever the vendor sent. " +
          "Placeholders are any key the AI extracts: {lot_number}, {supplier}, {expiration_date}, {document_type}, {product_name}, plus the literal {ext} for the original file extension. If a placeholder is missing from a particular document, that segment is dropped (no \"undefined\" placeholders ever land in the filename). " +
          "Set this once per type; it applies to every future ingest of that type and to every connector / email / API that drops files in. Existing documents keep their original names unless you re-ingest them.",
      },
      {
        heading: 'Extraction fields — what they do',
        body:
          "extraction_fields is a comma-separated list of canonical fields the AI is asked to look for when it classifies a document as this type. For a COA you might list: lot_number, expiration_date, manufacturer, product_name, batch_size. For an SDS: product_name, manufacturer, hazard_class, signal_word. " +
          "Two effects. (1) The list is included in the AI prompt — the model is steered toward those fields and tends to fill them more reliably. (2) The Review Queue pre-renders editable fields in that order so reviewers can scan and correct quickly. " +
          "Leave it blank for types where you trust the AI to pick the right fields on its own (small / generic types). Fill it in for high-volume regulated types where consistency matters.",
      },
      {
        heading: 'Auto-ingest and extract tables',
        body:
          "Auto-ingest — when on, documents the AI extracts as this type with confidence >= the auto-ingest threshold skip the Review Queue and land directly in the library. dox needs a handful of reviewer-approved examples (3+ per supplier+type) to calibrate the threshold; the toggle is a no-op until that calibration completes. Use it on high-trust types where the AI is reliably right and review is bottlenecking ingest. " +
          "Extract tables — when on, the AI also pulls tabular data (test results, line items, spec rows) into structured tables on the document. On for COA / Spec Sheet (table content is the point); off for SDS / generic notes where there's no useful table. Extracting tables is slower and noisier, so leave off when you don't need it.",
      },
      {
        heading: 'Common questions',
        body:
          "AI keeps misclassifying a file as the wrong type? Tighten the extraction_fields list — adding 2-3 distinguishing fields nudges the classifier toward the right type. " +
          "Naming format isn't applying? Check the placeholder spelling. Placeholders are case-sensitive and must match the canonical field name (lot_number, not LotNumber). Also confirm extraction is actually pulling that field — if the AI doesn't extract {lot_number}, the filename will be missing that segment. " +
          "Auto-ingest stays disabled? You don't have enough approved examples yet. Approve 3+ docs of this (supplier, type) pair from the Review Queue and the gate opens automatically. " +
          "Want to retire a type? Deactivate rather than delete. Existing documents keep their type even after deactivation; new ingests just stop landing on it.",
      },
    ],
  },
};

const namingTemplates: ModuleHelpExpanded = {
  headline: 'Naming Templates',
  well:
    "Naming templates control how ingested files are renamed at rest. They live on the document type (since migration 0018) — set the template once per type and every inbound file of that type follows the same convention.",
  list: {
    headline: 'Naming Templates',
    well:
      "Naming templates aren't a separate page in dox — they're the naming_format field on each document type. Set the template on the Document Types page, and every inbound file classified as that type gets renamed at ingest. Use generic placeholders like {lot_number}, {supplier}, or {doc_type} — any metadata key the AI extracts is fair game.",
  },
  help: {
    sections: [
      {
        heading: 'What a naming template is',
        body:
          "A naming template is a string like {lot_number}_{product}_{doc_type}.{ext} that dox uses to rename inbound files. Templates live on the document_type — set the template on the Document Types page and every file ingested as that type is renamed accordingly. There is no separate Naming Templates page; the field lives on the document type itself.",
      },
      {
        heading: 'Placeholder syntax',
        body:
          "Placeholders are wrapped in curly braces and use the canonical (snake_case) name of the metadata field. Common ones: {lot_number}, {product}, {supplier}, {doc_type}, {expiration_date}, {manufacturer}, {batch_size}. Plus the special {ext} for the original file extension. " +
          "Anything outside the braces is treated as a literal — so {lot_number}_{product}.pdf produces filenames like 12345_ButterMilk.pdf. Underscores, dashes, dots are all fine; avoid path separators (/) and spaces — dox sanitizes them but the result is uglier than necessary. " +
          "If a placeholder isn't extracted from a particular document, that segment is dropped entirely (no literal \"undefined\" or \"null\" lands in the filename). Order the template so missing-but-rare fields land at the tail rather than the head.",
      },
      {
        heading: 'Example templates',
        body:
          "Strict COA convention: {lot_number}_{product}_{doc_type}_{expiration_date}.{ext} -> 12345_ButterMilk_COA_2027-08-31.pdf. " +
          "Supplier-first sort order: {supplier}_{lot_number}_{doc_type}.{ext} -> ACMECorp_12345_COA.pdf. " +
          "SDS with manufacturer: {manufacturer}_{product}_SDS.{ext} -> Sigma_AceticAcid_SDS.pdf. " +
          "Always wins (least surprise): {doc_type}_{product}_{lot_number}.{ext} — the doc type prefix means alphabetical sort groups COAs together, specs together, etc.",
      },
      {
        heading: 'Common gotchas',
        body:
          "Placeholder produces nothing? The AI didn't extract that field. Open one of the affected documents and check primary_metadata / extended_metadata; if the field is missing, either tighten the extraction_fields list on the document type or accept that this template segment will be skipped. " +
          "Filename has __ (double underscore)? A placeholder evaluated to empty and the literals around it collapsed. dox cleans up consecutive separators automatically, but if it bothers you, drop the unreliable placeholder from the template. " +
          "Want different conventions per supplier? Naming templates are per-type, not per-supplier+type. The recommended pattern is to keep the template generic and let supplier metadata fall in via {supplier}; if you really need supplier-specific naming, fork the document type (one COA-AcmeCorp, one COA-OtherCorp) and template each.",
      },
    ],
  },
};

const bundles: ModuleHelpExpanded = {
  headline: 'Bundles',
  well:
    "Bundles are named compliance packages that pin specific document versions together. Build one for an audit, a customer ship-set, or a regulatory submission, then download as a single ZIP — the version pin guarantees the package never drifts even if the underlying docs are revised.",
  list: {
    headline: 'Bundles',
    well:
      "Every bundle in your tenant. Each bundle is a named, optionally product-scoped collection of documents pinned to specific versions, with a draft / finalized status. Click into one to manage its contents or download as a ZIP.",
    emptyTitle: 'No bundles yet',
    emptyDescription:
      "Bundles are how you package documents together for an audit, a customer ship-set, or a regulatory submission. Create one, add the docs you need, then finalize to lock in the versions and download as a ZIP.",
    columnTooltips: {
      name: "The bundle's display name. Shown in the list, in audit logs, and on the downloaded ZIP filename.",
      product:
        'Optional product link — scopes the bundle to a single SKU. Useful for customer ship-sets where every document needs to be for the same product. Leave blank for cross-product packages (compliance audits, regulatory submissions).',
      status:
        "Draft = editable; you can add / remove documents and tweak metadata. Finalized = read-only and version-pinned; the ZIP you download today will be byte-identical to the one you download in a year, even if the underlying docs are revised.",
      items: 'How many documents are currently pinned in the bundle.',
      createdBy: 'Which user created the bundle. Only the original creator (and admins) can finalize or delete.',
      created: 'When the bundle was first created.',
    },
  },
  detail: {
    headline: 'Bundle detail',
    well:
      "One bundle's contents and controls. Drafts can be edited (add / remove documents, rename, re-link to a product). Finalized bundles are immutable — you can still download and delete them, but the document list is locked. Use Download ZIP to grab everything in one shot.",
  },
  help: {
    sections: [
      {
        heading: 'What a bundle is',
        body:
          "A bundle is a named collection of documents that travel together as a single deliverable. Each bundle has a display name, an optional product link (scopes the bundle to one SKU), a status (draft or finalized), and zero or more bundle items — each item points at a document and pins a specific version of it. The Download ZIP action streams every pinned-version file plus a manifest into a single archive.",
      },
      {
        heading: 'Why version pinning matters',
        body:
          "Documents in dox are versioned — every re-ingest of the same external_ref appends a new version on the existing record. That's great for the library (you always see the latest) but bad for compliance: an audit done on Tuesday must show the documents that were current on Tuesday, not whatever drifted in by Friday. " +
          "When you add a document to a bundle, the bundle item records the document's current version. Finalizing the bundle locks every version pin in place. From then on, downloading the ZIP always returns those exact versions, regardless of how many revisions land later. The downstream auditor sees what you sent them.",
      },
      {
        heading: 'Draft vs. finalized — the workflow',
        body:
          "New bundles start in Draft status. Add documents (via the Add Document button or the document picker), remove the wrong ones, rename, retarget to a different product. The version pin updates each time you swap a document — drafts are alive. " +
          "When the bundle is right, click Finalize. The status flips to Finalized, the version pins lock, and the document list becomes read-only. You can still download or delete; you cannot add / remove items or change names. To start a new revision of the same package, create a new bundle (Draft) and copy items over — finalized bundles are intentionally one-way.",
      },
      {
        heading: 'Common questions',
        body:
          "Document was revised after I finalized — does the ZIP update? No. Finalized bundles are version-pinned. Re-create the bundle as a fresh Draft if you need the latest revisions. " +
          "Can readers download bundles? Yes, if their role allows downloads on the underlying documents. The bundle ZIP respects per-document permissions; any doc the user can't see is omitted with a manifest note. " +
          "Need to scope to multiple products? Leave the product link empty — bundles can carry docs across many products. The product link is purely informational; it doesn't restrict what you can add.",
      },
    ],
  },
};

const reports: ModuleHelpExpanded = {
  headline: 'Reports',
  well:
    "Reports turn document and audit data into CSV / JSON exports. Generated on demand against the current tenant scope; the audit log records every report.generate event so you can prove what was exported and when.",
  list: {
    headline: 'Reports',
    well:
      "There isn't a dedicated Reports page in dox today — exports are surfaced inline on the lists they apply to (Documents, Audit, Search). Each export hits the /api/reports/generate endpoint, which builds a CSV or JSON snapshot of the current filter set and writes a report.generate row to the audit log.",
  },
  help: {
    sections: [
      {
        heading: 'What reports do',
        body:
          "Reports in dox are inline CSV / JSON exports rather than a separate page. The Documents list, the Audit log, and the Search results page each expose an Export button that calls /api/reports/generate with the active filter set; the response is downloaded as a CSV or JSON file. Reports are tenant-scoped and respect the current user's role — readers see only docs they can download, org_admins see everything in their tenant, super_admins can scope to any tenant via the tenant switcher.",
      },
      {
        heading: 'Report types',
        body:
          "Documents export — every document matching the current filters (status, doctype, supplier, date range). Columns: title, type, supplier, products, current version, file_name, file_size, created_at, updated_at. Use it for compliance attestations, customer ship-sets, or feeding downstream BI. " +
          "Audit export — every audit_log row in the date range. Columns: timestamp, user, action, resource_type, resource_id, ip_address, details (JSON). Use it for regulator-facing audits or internal review. " +
          "Search export — same shape as the documents export but constrained by the search query. Only available in keyword mode (AI mode disables export because the LLM-emitted filters aren't repeatable on demand).",
      },
      {
        heading: 'Snapshot vs. live',
        body:
          "Reports are a snapshot at the moment of generation. The CSV / JSON you download reflects the database state at that instant; it's not a live link, so refreshing it tomorrow won't add new rows. Re-export to refresh. " +
          "The audit log records each report.generate event with the filter parameters used, the user, the IP, and a row count. If a regulator asks \"what did you export and when?\", the answer lives in the audit trail.",
      },
      {
        heading: 'Common questions',
        body:
          "Why doesn't AI search support export? AI mode lets an LLM produce the structured filters from natural language. Those filters aren't deterministic across calls (the LLM's parse can drift), so re-running the same query later might not produce the same result set. Keyword search uses literal SQLite filters that are stable, so we can persist them in the audit log and the export is repeatable. Switch to keyword mode if you need the export. " +
          "Can I schedule recurring reports? Not built in. The /api/reports/generate endpoint is API-key authable, so a downstream cron / agent can call it on a schedule and shuttle the result wherever you want. " +
          "Export is empty? Either no rows match the active filters, or the user's role doesn't see any of the matching rows. Check the filter chips before assuming a bug.",
      },
    ],
  },
};

const activity: ModuleHelpExpanded = {
  headline: 'Activity',
  well:
    "Activity is the unified timeline for ingest events — connector runs, document ingests, order creation, and audit entries — across the whole tenant. Filter by date, type, source door, status, or specific connector.",
  list: {
    headline: 'Activity',
    well:
      "One chronological view of everything the ingest pipeline has touched. Every connector run, every document that hit the queue, every order created, and every privileged audit event lives here as one row. Use the filter bar to narrow by time range, event type, source, status, or specific connector; expand a row for the full payload + cross-navigation links.",
    emptyTitle: 'No activity in this window',
    emptyDescription:
      "Either nothing happened in the selected time range, or the filters are too narrow. Try widening the date range (7d / 30d) or clearing the source / status filters.",
    columnTooltips: {
      when: "When the event happened, shown as a relative time (\"5m ago\") with the absolute timestamp on hover. Sorted newest-first.",
      type:
        "Which kind of event. Connector Run = a parser ran against an inbound file. Document = a single file landed in the processing queue. Order = an order record was created (usually downstream of a connector run). Audit = a privileged action (user create, password reset, etc.) was logged.",
      summary: 'One-line description of what happened — connector name, file name, order number, or actor + action depending on the event type. Click into the row to expand the full payload.',
      status:
        "Outcome of the event. Connector runs: success / partial / error / running. Documents: queued / processing / ready / error. Orders: pending / matched / fulfilled / etc. Audit entries don't carry a status — they always succeeded.",
      connectorFilter:
        "Restrict to one connector — useful when you're debugging why a specific vendor's feed is misbehaving. Pre-fills from a ?connector_id= URL param, so deep-linking from a connector detail page works.",
      sourceFilter:
        "Filter by which intake door brought the file in: manual upload, API drop, public link, email, S3 bucket, webhook, or the legacy import / file_watch sources. Helps answer \"is the email connector noisy today?\" without paging through everything.",
      statusFilter:
        "Filter by event outcome. Pair with the source filter to find, say, every email-source error in the last 24 hours.",
      crossTenant:
        "super_admin only — toggle between \"only my current tenant\" and \"every tenant the cross-tenant view exposes\". Default is current tenant, since cross-tenant is rarely what you want.",
    },
  },
  help: {
    sections: [
      {
        heading: 'What Activity is',
        body:
          "Activity is the cross-cutting timeline for everything the ingest pipeline does. Four event types feed into it. " +
          "Connector runs — every time a parser executes against an inbound file (regardless of which door). " +
          "Document ingests — every file the AI processing queue saw, with its current processing status. " +
          "Order creations — every order record, whether created automatically by a connector run or entered manually. " +
          "Audit entries — every privileged action recorded in the audit log (user creation, password resets, doc deletions, etc.). " +
          "The events are folded into one chronological feed, sorted newest-first, with an unbounded time-range filter so you can scope to the last hour, last day, last month, or a custom window.",
      },
      {
        heading: 'When to use Activity',
        body:
          "Triage. Vendor reports a missing file? Filter to that connector + the suspected time range; you'll see the ingest land (or not), the parser status, the resulting orders, and any errors — all in one place. " +
          "Auditing the unattended pipeline. Filter source = email, status = error to spot every email-ingest that bounced. Filter type = audit, action = user_deactivated to review user lifecycle events. " +
          "Cross-checking. Activity is the source of truth when the per-module pages disagree — if Orders shows N orders for a connector but the connector runs page only shows M, expand both into Activity to find the missing rows.",
      },
      {
        heading: 'Filter combinations that pay off',
        body:
          "type=connector_run + status=error — every parser that crashed in the window. Pair with a connector filter for one-vendor focus. " +
          "type=document_ingest + processing=error — every file the AI pipeline failed on. Click in for the per-file error message. " +
          "type=audit + a specific actor — every privileged action one user took (useful for offboarding reviews). " +
          "source=email — everything the inbound email processor handled. Pair with status=error to find addresses that bounced. " +
          "source=public_link — public-link uploads only. Useful for vendors with no automation; correlates with a single connector by definition.",
      },
      {
        heading: 'Common questions',
        body:
          "Activity is slow? The query window matters — 30d cross-tenant against a busy tenant returns thousands of events. Narrow to 24h or pick a specific event type. " +
          "Same event shows up twice? Likely once as a connector_run and once as the order_created that followed. The pipeline emits separate events per stage; this is expected. " +
          "Where's the file content? Activity stores event metadata, not the file. Click through to the document detail page for the file itself; the expanded row links you there.",
      },
    ],
  },
};

const audit: ModuleHelpExpanded = {
  headline: 'Audit Log',
  well:
    "The audit log is the immutable record of every privileged action in your tenant — user creation, password resets, document deletions, role changes, report exports. Read-only, append-only, and tenant-scoped. Use it for compliance attestations and security reviews.",
  list: {
    headline: 'Audit Log',
    well:
      "Every privileged action that happened in your tenant. Each row records the timestamp, the user (if known), the action, the affected resource, the IP address, and a JSON details blob with whatever context the action emitted. Filter by action type, user, or date range; expand a row to see the per-field before/after diff (when applicable).",
    emptyTitle: 'No audit entries',
    emptyDescription:
      "Audit entries appear here as users perform privileged actions — creating accounts, deleting documents, rotating credentials. If your tenant is brand new and quiet, this view will stay empty until activity starts.",
    columnTooltips: {
      timestamp: 'When the action happened, in your local time zone. Sorted newest-first; the audit log is append-only so timestamps are stable.',
      user: 'Which user performed the action. Hover the name for the email. \"System\" entries are background jobs (cron pollers, email ingesters) where no human user was involved.',
      action:
        "What kind of action was taken — login, document_created, document_deleted, user_updated, password_changed, report.generate, etc. The chip is colored by category (auth / document / user / tenant / report).",
      resource:
        "The object the action affected — a document, a user, a tenant, etc. The trailing (xxx...) is the first 8 chars of the resource id; clickable navigation isn't built in (the audit log is read-only by design).",
      ipAddress:
        "The originating IP address. Useful for security reviews — a privileged action from an unfamiliar IP is a red flag. Pulled from the request headers; may be empty for system events or behind a proxy with no X-Forwarded-For.",
      details:
        'Click the chevron to expand the per-field before/after diff (for update actions) or the raw JSON details blob. Most actions populate this with structured context — the values that changed, the parameters of the call, etc.',
      actionFilter: "Narrow to a single action type — handy when you're auditing one specific thing (every document_deleted, every user_created).",
      userSearch:
        'Filter rows where the user name or email contains your search. Client-side filter — runs only over the current page of results, so paginate first if you need to find a specific user across the whole log.',
      dateRange: "Restrict to a time window. Open-ended on either side — set just from to grab everything since a date, or just to to grab everything before.",
    },
  },
  help: {
    sections: [
      {
        heading: 'What the audit log is',
        body:
          "The audit log is the immutable, append-only record of every privileged action in your tenant. Every login, every user lifecycle change, every document deletion, every credential rotation, every report export — they all write a row here. The log is read-only via the UI: there's no way to edit or delete entries from inside dox (and no admin role can do it either). The append-only property is what makes the log useful for compliance attestations.",
      },
      {
        heading: 'What gets logged',
        body:
          "Auth events: login, logout, password_changed, password_reset_requested. " +
          "User lifecycle: user_created, user_updated, user_deactivated, role changes. " +
          "Document operations: document_created, document_updated, document_deleted, document_version_uploaded, document_downloaded (when configured). " +
          "Tenant operations: tenant_updated, tenant_deactivated. " +
          "Reports: report.generate (with the filter parameters used). " +
          "Read-only operations like list / get aren't logged by default — too noisy. The principle is \"every state change, plus auth events.\"",
      },
      {
        heading: 'Retention',
        body:
          "Audit entries are retained indefinitely in production. There's no automatic pruning, no rotation, no soft-delete. If you need to remove specific entries for legal reasons (PII deletion requests, etc.), that has to happen via a direct D1 mutation by a super_admin and should itself be documented out-of-band. " +
          "The CLAUDE.md describes the audit table as \"immutable\"; the implementation enforces this only by convention — there is no DB-level trigger preventing deletes. Treat that as a known limitation if your compliance regime is strict.",
      },
      {
        heading: 'Common questions',
        body:
          "Where's the audit entry for X? Some actions don't generate audit rows by design (read-only operations, unprivileged endpoints). If a state-changing action is missing audit coverage, that's a bug — file it. " +
          "Why is the User column \"System\"? The action was performed by a background job (cron poller, scheduled report, email ingester) that doesn't run as a real user. The IP address column will usually be blank for these too. " +
          "Can I export the log? Yes — use the Reports section's audit export (CSV / JSON of the current filter set). The export itself generates a report.generate audit row, so the trail is self-documenting.",
      },
    ],
  },
};

const apiKeys: ModuleHelpExpanded = {
  headline: 'API Keys',
  well:
    "API keys are programmatic credentials that authenticate as the user who created them. Each key carries a dox_sk_ prefix, an optional expiration, an optional tenant scope, and a last-used timestamp so you can spot stale keys. Revoke at any time — revocation is immediate.",
  list: {
    headline: 'API Keys',
    well:
      "Every API key that's been issued under this admin's purview. Each key is a programmatic credential (X-API-Key header) that authenticates as the user who created it; the key's tenant scope, expiration, and last-used time are visible at a glance so you can identify stale or risky keys before they become a problem.",
    emptyTitle: 'No API keys yet',
    emptyDescription:
      "API keys give external systems programmatic access to dox. Create one for each integration (one per agent / script / pipeline) — that way you can revoke the credential for one consumer without breaking the others.",
    columnTooltips: {
      id: 'The opaque internal identifier for the key — useful only for support. Click the copy icon to grab it.',
      name: "Friendly label for the key, e.g. 'MindStudio Email Agent' or 'Make.com Order Sync'. Pick something specific enough to identify the consumer when you're triaging which key to revoke.",
      key: "The dox_sk_ prefix and the first few chars of the key. The full key is shown only once — at creation time — and never recoverable. Lose it, rotate it.",
      tenant:
        'Which tenant the key authenticates against. super_admin keys can be tenant-less (Global) and operate cross-tenant; org_admin and below are scoped to one tenant. The key inherits the role of its creator.',
      created: 'When the key was issued.',
      lastUsed:
        "When the key last authenticated a request. Empty means it's never been used (recently issued or forgotten). A last-used timestamp from months ago plus an active status is a strong signal the key is stale and ripe for revocation.",
      status:
        "Active = the key is live and accepting auth. Expired = the expires_at has passed; the key auto-rejects requests but stays in the list for audit. Revoked = a human revoked the key; permanent (cannot be unrevoked, just create a new one).",
    },
  },
  help: {
    sections: [
      {
        heading: 'What an API key is',
        body:
          "An API key is a long-lived programmatic credential for the dox REST API. Each key has the format dox_sk_<32 random chars> and is presented to the API via the X-API-Key header (or the Authorization: Bearer header for backwards compatibility with some clients). The key authenticates as the user who created it — it inherits that user's role, tenant scope, and permissions. There is no separate role model for API keys; if you need a key with reduced scope, create a dedicated user, set its role appropriately, and issue the key as that user.",
      },
      {
        heading: 'The dox_sk_ prefix',
        body:
          "Every key starts with dox_sk_ (sk = secret key). The prefix is fixed and useful for two things: (1) string-grepping logs / config files for accidental key leaks (\"any line containing dox_sk_ in our git history is bad\"), and (2) telling at a glance whether a string is a dox key or some other system's credential. " +
          "The first 12 characters (dox_sk_ plus 5 random chars) are stored in the database as key_prefix and shown in the list / detail views; the full key is only visible at creation time and is never recoverable. If you lose the full key, revoke it and issue a new one.",
      },
      {
        heading: 'Tenant scope and last-used',
        body:
          "Tenant scope. A key authenticates with the tenant of its creating user — so a user in Tenant A creating a key produces a Tenant-A-scoped key. super_admin keys can be tenant-less (Global) and operate against any tenant the API caller specifies; org_admin and below cannot create cross-tenant keys. " +
          "Last-used timestamp. Every successful authentication updates the key's last_used_at. The list view surfaces this so you can spot keys that haven't been used in months — those are usually safe to revoke as cleanup. Revocation is immediate and one-way: a revoked key is permanently dead, even if the audit shows it was working yesterday. There is no \"unrevoke\" — issue a fresh one if you revoked in error.",
      },
      {
        heading: 'Common questions',
        body:
          "Key returns 401 unexpectedly? Check three things in order: (1) the key isn't expired, (2) the key isn't revoked, (3) you're sending it via the X-API-Key header (case-insensitive name) and not in a query param. The Authorization: Bearer dox_sk_xxx form also works for some legacy clients. " +
          "Want to limit a key to a single endpoint? Not built in. The minimum unit of permission is the role of the creating user. Create a dedicated user with the role you want, then issue the key as that user. " +
          "Where do I rotate a key? You don't — keys don't have a rotate endpoint. Issue a new one, deploy the new value to your consumer, then revoke the old one. The pattern is intentional: revocation is one-way, so the new+old overlap window is always under your control.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Super-admin + auth modules — Phase D4 expanded shape.
// ---------------------------------------------------------------------------
//
// Tenants is super_admin-only. Users covers both super_admin (cross-tenant)
// and org_admin (own tenant). Profile is the user's self-service page;
// settings is the /help-only doc that pulls together the tenant-level
// configuration surfaces that don't have a dedicated page (naming templates,
// document types, email domain mappings — all of which already have their
// own helpContent entries). Auth is the umbrella for login / register /
// forgot / reset.

const tenants: ModuleHelpExpanded = {
  headline: 'Tenants',
  well:
    "Tenants are isolated organizations within dox. Each tenant has its own users, documents, suppliers, products, document types, and naming templates — data is scoped per tenant and never bleeds across boundaries. Visible only to super_admin.",
  list: {
    headline: 'Tenants',
    well:
      "Every organization on this dox installation. Each row is a self-contained workspace: its own user roster, document library, suppliers, products, and configuration. Use this list to onboard new customers, deactivate inactive ones, or pop into a tenant to investigate a support ticket.",
    emptyTitle: 'No tenants yet',
    emptyDescription:
      "Add a tenant for each customer organization you onboard. Each tenant is a fully isolated workspace with its own users, documents, and configuration.",
    columnTooltips: {
      id: 'Internal identifier for the tenant. Used in API calls, audit log filters, and as a foreign key on every tenant-scoped record. Click the copy icon if you need to paste it into a config or a support ticket.',
      name: "Display name shown to users in the navbar, on COA packages, and across reports. Pick whatever the customer prefers to be called.",
      slug: "URL-friendly identifier — lowercase, kebab-case, alphanumeric. Used in tenant-scoped URLs and inbound email mappings. Auto-generated from the name on create; can be edited if the customer rebrands.",
      description: 'Free-form notes — billing tier, account owner, onboarding date, anything that helps you orient when triaging.',
      status:
        "Active tenants accept logins and ingestion. Inactive tenants stay on file (data preserved) but reject logins and incoming connector traffic — useful for offboarding without nuking the data.",
      created: 'When the tenant record was first created.',
    },
  },
  help: {
    sections: [
      {
        heading: 'What a tenant is',
        body:
          "A tenant in dox is a fully isolated organizational workspace. Every row in every tenant-scoped table (documents, users, suppliers, products, document_types, audit_log, etc.) carries a tenant_id, and the API enforces that callers only see rows from the tenant they belong to. The only exception is super_admin users, who can see across tenants for support and operational purposes. " +
          "Tenants are typically one-per-customer — if you're hosting dox for multiple manufacturer or distributor organizations, each one gets its own tenant. Inside a tenant the org_admin manages users and configuration; super_admins reach across tenants only when intervention is needed.",
      },
      {
        heading: 'Creating and naming',
        body:
          "Each tenant has a name (display, shown in the navbar and on reports), a slug (URL-friendly identifier — lowercase, kebab-case, alphanumeric), and an optional description (free-form notes for your operational records). The slug is auto-generated from the name when you first create the tenant; you can override it before saving. " +
          "Renaming the display name later is harmless — the slug is independent and stays put unless you explicitly change it. Slugs must be unique across the whole installation; the create form will reject duplicates.",
      },
      {
        heading: 'Active vs inactive',
        body:
          "Toggling a tenant inactive is a soft delete — the data stays on disk and on D1, but the tenant's users can no longer log in and inbound connector traffic is rejected. This is the right move when offboarding a customer: you preserve the audit trail and document library in case you need to refer back to it, without keeping their accounts live. " +
          "Reactivating restores access immediately. There is no hard-delete UI by design; if you actually need to purge a tenant, do it via the database (and only after exporting whatever records you need).",
      },
      {
        heading: 'Common gotchas',
        body:
          "Why can't an org_admin see other tenants? By design — tenant isolation is enforced at the API layer. Only super_admin can see across. " +
          "User in Tenant A creates a document, then is moved to Tenant B — does the doc come along? No. Documents are tenant-scoped via tenant_id; the user's old doc stays in Tenant A and they lose access to it on the move. " +
          "Slug clash on create? Pick another. Slugs are globally unique, even across inactive tenants. " +
          "Want a 'staging' copy of a tenant for testing? Easiest path is to create a separate tenant named '<Customer> Staging' — there's no built-in clone or fork.",
      },
    ],
  },
};

const users: ModuleHelpExpanded = {
  headline: 'Users',
  well:
    "Users belong to a tenant (or are tenant-less for super_admin) and have one of four roles: super_admin (cross-tenant), org_admin (manage own tenant's users + audit), user (upload + edit documents), or reader (read-only). Each user has an email + password, an optional last-login timestamp, and a force_password_change flag that fires on first login after admin reset.",
  list: {
    headline: 'Users',
    well:
      "Every user this admin can see — for super_admin that's everyone across all tenants, for org_admin it's only users in their own tenant. Each row shows the role, tenant assignment, and last-login timestamp; reset a password or toggle active from the row actions.",
    emptyTitle: 'No users yet',
    emptyDescription:
      "Add users so your team can log in and work. Each user is assigned a role (which gates their permissions) and a tenant (which scopes the data they see).",
    columnTooltips: {
      id: 'Internal identifier for the user. Useful when grepping audit logs or API logs.',
      name: 'Display name for the user — shown in the navbar, on uploaded documents, and in audit entries.',
      email: 'Primary identifier and login. Also the destination for password-reset emails and (for org_admins) expiration alerts.',
      role:
        "super_admin = cross-tenant access, manage tenants and all users. org_admin = manage own tenant's users (user + reader only — cannot create org_admins or super_admins) and view audit. user = create / upload / edit / delete documents. reader = read-only, can download files but cannot modify anything.",
      tenant:
        "Which tenant the user belongs to. Tenant-scoped data (documents, suppliers, etc.) is invisible across tenant boundaries. super_admins can be tenant-less (Global) and operate across every tenant; everyone else must have a tenant.",
      status:
        "Active users can log in and use the API. Inactive users keep their record + audit history but can't authenticate — preferred over deletion for departing employees so the audit trail stays intact.",
      lastLogin:
        "When the user last successfully signed in. Empty means they've never logged in (newly invited or forgotten); timestamps from months ago plus active status often signal a stale account ripe for deactivation.",
      created: 'When the user record was created.',
      forcePasswordChange:
        "When set, the user is redirected to the password-change form on next login and can't proceed until they pick a new one. Auto-set after admin password reset; cleared when the user successfully changes the password.",
    },
  },
  help: {
    sections: [
      {
        heading: 'The four roles',
        body:
          "dox has a flat four-role model — no per-resource permissions, no role inheritance, no custom roles. " +
          "super_admin: cross-tenant operator. Can manage every tenant, every user (including other super_admins), and every piece of data. Typically only the platform owners. " +
          "org_admin: per-tenant administrator. Can create / edit / delete users in their own tenant — but only at the user and reader role levels. They cannot create more org_admins or super_admins; that requires escalation to a super_admin. They can view audit, manage document types, naming templates, email domain mappings, and configure connectors. " +
          "user: standard editor. Create, upload, edit, and delete documents in their tenant. Cannot manage other users or tenant configuration. " +
          "reader: read-only. Can browse the document library, download files, search, and view orders / customers / suppliers — but cannot create, edit, or delete anything.",
      },
      {
        heading: 'Tenant scope and the Global super_admin',
        body:
          "Every non-super_admin user has a tenant_id. They see only data inside that tenant. super_admins can either belong to a specific tenant (then they default to that tenant's data but can pivot to others) or be Global / tenant-less, in which case they have to specify a tenant context for tenant-scoped operations. " +
          "Moving a user between tenants. There's no UI for it — edit the user, change the tenant_id, save. The user's documents, audit entries, etc. stay attached to their old tenant; the user just loses visibility on them. If you need data to migrate, export it from the source tenant and re-import into the destination.",
      },
      {
        heading: 'Password lifecycle',
        body:
          "Three flavors of password change: " +
          "(1) Self-service — the user signs in, hits Profile, enters their current password and a new one. Standard 8-128 char + mixed case + digit policy. " +
          "(2) Forgot password — the user hits Forgot password on the login screen, enters their email, gets a one-time reset link via Resend. The link is good for 60 minutes. The reset form has the same password requirements as self-service. " +
          "(3) Admin reset — an admin (org_admin in their own tenant, or super_admin anywhere) clicks Reset Password on a user row. dox generates a temporary password, optionally emails it to the user, and sets force_password_change. The user logs in with the temp password and is bounced to the change-password screen until they pick a new one. All existing sessions are revoked, so the user gets kicked out everywhere immediately. " +
          "Where do I configure password policy? It's not configurable — the rules are baked into the validation layer (8 chars min, 128 chars max, must contain upper / lower / digit). If you need stricter, edit functions/lib/validation.ts.",
      },
      {
        heading: 'Sessions and JWT',
        body:
          "Logged-in sessions use a 24-hour JWT. The token is issued on login, signed with HMAC-SHA256 using JWT_SECRET, and sent on every request via the Authorization: Bearer header. Tokens cannot be revoked individually — the only way to invalidate a session before its 24-hour expiry is via admin password reset (which kills all of the target user's sessions) or by changing JWT_SECRET (which kills every session for every user — nuclear option). " +
          "API keys are the long-lived alternative. They authenticate as the creating user, inherit that user's role + tenant, and can be revoked individually — see /help/api_keys for the full lifecycle.",
      },
      {
        heading: 'Common gotchas',
        body:
          "Org_admin can't create another org_admin? Correct — by design. Only super_admin can create org_admins or super_admins. " +
          "User says login fails right after admin reset? Make sure they're entering the temp password (the one shown in the reset dialog or sent via email), not their old password. The old password is dead the moment the reset fires. " +
          "User keeps getting bounced to the change-password screen? force_password_change is set. They have to actually pick a new password (meeting the policy) and submit; clearing the flag manually in the DB without changing the password is fragile and not recommended. " +
          "Deactivated user still showing up in audit / on documents they uploaded? Right — deactivation is a soft delete. Their record stays so historical references still resolve. To actually purge, you'd have to scrub the DB by hand (and you shouldn't, because audit integrity).",
      },
    ],
  },
};

const profile: ModuleHelpExpanded = {
  headline: 'Profile',
  well:
    "Your account: who you are to dox, what tenant + role you carry, when you last logged in, and a self-service password change form. The role and tenant are locked here — only an admin can change them.",
  detail: {
    headline: 'Profile',
    well:
      "Read-only summary of your account information plus the password-change form. To update your name or email, ask an org_admin. To change your role or move between tenants, ask a super_admin.",
  },
  fields: {
    name: 'Your display name as shown in the navbar, on documents you upload, and in audit entries. Edited by an admin if it ever needs to change.',
    email: 'Your login email and the destination for password-reset notifications. Editable by an admin if you change addresses.',
    role: "Your permission level. super_admin / org_admin / user / reader — see /help/users for what each one can do. Changing roles requires an admin.",
    organization: "Which tenant you belong to. Determines which documents, suppliers, etc. you can see. Set by an admin; you cannot move yourself between tenants.",
    memberSince: 'When your account was created.',
    currentPassword: "Your existing password — confirms it's really you before we accept the change.",
    newPassword: 'Your new password. Must be 8-128 characters, with at least one uppercase letter, one lowercase letter, and one digit.',
    confirmPassword: 'Re-enter your new password to make sure you typed what you meant.',
  },
  help: {
    sections: [
      {
        heading: "What's on this page",
        body:
          "Two cards: Account information (read-only summary of your name, email, role, organization, and member-since date) and Change password (self-service form). Anything you can't edit here — name, email, role, tenant — is admin-managed; ping your org_admin or super_admin if it needs to change.",
      },
      {
        heading: 'Changing your password',
        body:
          "Enter your current password (to confirm identity), then a new one twice. The policy is 8-128 characters, with at least one uppercase letter, one lowercase letter, and one digit. The form previews each requirement live so you know what's still missing. " +
          "After a successful change, your other sessions stay alive (only admin reset kills all sessions). If you want to log other browsers out — say, a shared computer — log in there once and explicitly log out. " +
          "If you've forgotten your current password, log out and use the Forgot password link on the sign-in page; you don't need to know the current one to reset via email.",
      },
      {
        heading: 'force_password_change',
        body:
          "If you logged in with a temporary password your admin issued, dox sets a force_password_change flag on your account. You'll see a yellow warning banner on the profile page and you won't be able to navigate elsewhere until you pick a new password. Once you submit a valid new password the flag clears and you're sent to the dashboard. " +
          "Why this exists: it makes sure admin-issued temp passwords don't linger as long-term credentials. The temp password is meant to be a one-time bridge to your real password.",
      },
      {
        heading: 'Common questions',
        body:
          "How do I change my email? You can't here — ask an admin. " +
          "How do I delete my account? Same — ask an admin. They'll deactivate it (soft delete) so the audit history stays intact. " +
          "Where's two-factor auth? Not built in. SSO and 2FA are on the roadmap; for now password + JWT is the auth model. " +
          "Why can't I see my API keys here? Visit /admin/api-keys (admin-only) — there's no per-user API key listing on the profile page by design.",
      },
    ],
  },
};

const settings: ModuleHelpExpanded = {
  headline: 'Settings',
  well:
    "Tenant-level configuration is split across several dedicated pages rather than a single settings dashboard. The pages below all live under the admin nav and tweak how your tenant ingests, names, and routes documents.",
  help: {
    sections: [
      {
        heading: 'Where settings live',
        body:
          "dox doesn't have a single Settings page; instead, each configuration surface gets its own page so the audit trail and permission gating are clean. The relevant ones, all admin-only: " +
          "Document types (/admin/document-types) — define COA, Spec Sheet, SDS, etc. for your tenant; per-type extraction rules and naming format. " +
          "Naming templates (/admin/naming-templates if surfaced, or via document_types) — file naming patterns applied at ingest. " +
          "Email domain mappings — route inbound emails to the right tenant + connector by sender domain. " +
          "Connectors (/admin/connectors) — ingestion channels per upstream system. " +
          "Users (/admin/users) and API keys (/admin/api-keys) — auth surfaces.",
      },
      {
        heading: 'Per-tenant vs platform-level',
        body:
          "Per-tenant settings (everything in this page) are owned by org_admins (and super_admins). Changes apply to every user in the tenant immediately and are recorded in the audit log. " +
          "Platform-level settings — JWT_SECRET, RESEND_API_KEY, R2 bucket bindings, the Cloudflare D1 database — live in wrangler.toml + Cloudflare's project secrets, not the in-app UI. Only the platform operators (super_admins running the deployment) touch those.",
      },
      {
        heading: 'Audit and rollback',
        body:
          "Most settings changes appear in the audit log: document_type_created, naming_template_updated, email_domain_mapping_deleted, etc. There is no built-in undo / version history for settings — the audit log tells you what changed, but reverting a bad change is a manual re-edit. " +
          "Connectors are the exception: their wizard lets you re-test and remap before save, and the field-mappings card on the connector detail page is editable inline so most tweaks don't need a full revert.",
      },
      {
        heading: 'Common questions',
        body:
          "Where do I change branding (logo, colors)? Tenant-level branding for the in-app UI isn't editable yet — it's on the roadmap. Public-facing forms (records sheet forms, public-link drops) carry per-form branding (logo + accent color). " +
          "Where do I configure expiration alert recipients? They go to all org_admins of the tenant by default. There's no per-user opt-in/out yet. " +
          "Why can't I see other tenants' settings? Tenant isolation — even super_admin has to switch tenant context (via the tenant switcher in the navbar) to view another tenant's settings.",
      },
    ],
  },
};

const auth: ModuleHelpExpanded & {
  notes: Readonly<{
    login: string;
    forgot: string;
    reset: string;
    passwordPolicy: string;
  }>;
} = {
  headline: 'Authentication',
  well:
    "dox uses email + password for human logins and API keys for programmatic access. JWT sessions last 24 hours, password resets go via Resend email, and admin-issued temp passwords force a change on next login.",
  notes: {
    login:
      "Trouble signing in? Use 'Forgot password' below to reset, or contact your tenant admin if your account hasn't been created yet. Sessions last 24 hours before you need to sign in again.",
    forgot:
      "Enter the email tied to your account. If a matching account exists, we'll email a one-time reset link that's valid for 60 minutes. If you don't see the email after a couple of minutes, check spam or ask your admin to issue a temporary password instead.",
    reset:
      "Choose a password that's at least 8 characters, with at least one uppercase letter, one lowercase letter, and one digit. Once you submit, your old password is dead and you can sign in with the new one.",
    passwordPolicy:
      "Passwords must be 8-128 characters and include at least one uppercase letter, one lowercase letter, and one digit.",
  },
  help: {
    sections: [
      {
        heading: 'Sign-in flow',
        body:
          "Hit /login, enter email + password, get back a JWT signed with HMAC-SHA256 (algorithm HS256, secret JWT_SECRET). The token is stashed in localStorage and sent on every subsequent request as Authorization: Bearer <token>. Tokens expire 24 hours after issue — no sliding refresh, just a hard expiry, so users re-authenticate once a day in active use. " +
          "Failed logins return a generic 'Invalid credentials' message regardless of whether the email exists or the password was wrong; this is intentional to avoid email enumeration.",
      },
      {
        heading: 'Forgot password',
        body:
          "On the /forgot-password page, enter your email. dox always returns the same success message ('if an account exists, we sent a link') regardless of whether the email matches a real user, again to avoid enumeration. If a real account exists, dox generates a one-time token, stores it in the password_resets table with a 60-minute expiry, and emails the user a /reset-password?token=<token> link via Resend. " +
          "Clicking the link drops the user on the reset page; submitting a new password (meeting the 8-128 char + mixed-case + digit policy) clears the password_resets row and updates the user's password hash. The token is single-use — re-using it returns 'invalid or expired'.",
      },
      {
        heading: 'Admin-issued temp passwords',
        body:
          "When an admin clicks Reset Password on a user row, dox generates a 12-character random password, hashes it as the user's new password, sets force_password_change = 1, and revokes all of that user's existing sessions. The temp password is shown to the admin once (and optionally emailed to the user) — it isn't stored in clear and can't be recovered. " +
          "On the user's next login, the JWT is issued normally but the auth context flags force_password_change. Until they post a new password to /api/auth/change-password (which clears the flag), every protected route bounces them back to /profile.",
      },
      {
        heading: 'Sessions and 24-hour expiry',
        body:
          "JWTs are stateless — there's no server-side session table. To 'log out' a single browser, the client just deletes the token from localStorage. To kill every session for a user (e.g. credential leak), an admin issues a password reset, which rotates the password hash; existing JWTs remain technically valid until their 24-hour expiry but the sessions table is also wiped, and follow-up logins require the new password. " +
          "If you need to invalidate every session across the whole installation, change JWT_SECRET in wrangler.toml and redeploy — every existing token immediately fails verification.",
      },
      {
        heading: 'API keys vs JWT',
        body:
          "JWTs are short-lived (24h) and tied to an interactive browser session. API keys (dox_sk_...) are long-lived programmatic credentials sent via the X-API-Key header; they authenticate as the user who created them and inherit that user's role + tenant scope. There is no role hierarchy for API keys — if you need a key with reduced scope, create a dedicated user and issue the key as that user. See /help/api_keys for the full lifecycle.",
      },
      {
        heading: 'Common questions',
        body:
          "Forgot password and the email never arrived? Most likely Resend isn't configured for this environment (RESEND_API_KEY missing) — dox will silently no-op the email. Have an admin issue a temp password instead. " +
          "JWT expired mid-session? The next API call returns 401; the frontend catches that and bounces you to /login. Just sign in again. " +
          "Where's SSO / 2FA? Not implemented yet. The auth model is intentionally simple for the current customer base; SSO is on the roadmap. " +
          "Why does Login.tsx redirect immediately if I'm already signed in? Saves a click — if a valid JWT is in localStorage, dox skips the login form and routes you to /dashboard.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Other modules — unchanged from D0 scaffold; later D-slices fill these in.
// ---------------------------------------------------------------------------

export const helpContent = {
  connectors,
  orders,
  customers,
  suppliers,
  products,
  documents,
  import: importHelp,
  review_queue: reviewQueue,
  ingest_history: ingestHistory,
  document_types: documentTypes,
  naming_templates: namingTemplates,
  bundles,
  reports,
  activity,
  audit,
  search,
  tenants,
  users,
  api_keys: apiKeys,
  settings,
  profile,
  auth,
  records: {
    headline: 'Records',
    well:
      "Records sheets are flexible tables for anything that doesn't fit the document library — quality issues, approval workflows, item requests. Each sheet defines its own columns and can drive forms, kanbans, calendars, and workflows.",
    help: {
      sections: [
        {
          heading: 'What records sheets are',
          body:
            "A records sheet is a tenant-scoped, schema-on-the-fly table for anything that needs structured tracking but doesn't belong in the document library. Examples: a quality-incident log, a supplier-approval pipeline, an item-request queue. Each sheet defines its own columns (text, number, date, single-select, multi-select, person, doc-link), and rows can carry attachments, comments, and audit trails.",
        },
        {
          heading: 'Forms, kanbans, calendars, workflows',
          body:
            "Each sheet can layer extra surfaces on top of the same data. " +
            "Forms — a public or authenticated URL that drops a new row. Per-form branding (logo + accent), required-field validation, and Turnstile gating for public forms. " +
            "Kanban — group rows by a single-select column and drag between columns to update status. " +
            "Calendar — pin rows to a date column and view them month / week. " +
            "Workflows — multi-step automation that fires on row create / update; steps can send email, set fields, or pause for human approval (see /help/approvals).",
        },
        {
          heading: 'Where records lives',
          body:
            "The Records nav group exposes per-sheet pages: list, detail, sheet builder, form builder, and per-sheet workflow editor. Tenant admins create sheets; users with the right per-sheet role can edit rows. The full feature set still has rough edges in places — surface bugs to the team rather than working around them.",
        },
      ],
    },
  },
  approvals: {
    headline: 'Approvals',
    well:
      'Approvals are workflow steps that pause on a human decision. The decision page is a magic-link URL, so recipients can approve, reject, or comment without logging in.',
    help: {
      sections: [
        {
          heading: 'What an approval is',
          body:
            "An approval is a workflow step that pauses execution and waits on a human's decision before continuing. Approvals are created by a workflow run (Records sheet workflows can include an approval step) and routed to one or more recipients identified by email. Each recipient gets a magic-link URL — the URL itself is the credential, so they can approve, reject, or comment without logging in.",
        },
        {
          heading: 'The decision page',
          body:
            "The magic link drops the recipient on a no-login decision page that shows the row context, the approval question, and three actions: Approve, Reject, Comment. Comments don't resolve the approval; they're optional notes that surface on the workflow run for the next decider. Once approved or rejected, the link is single-use — re-visiting shows the resolved state. " +
            "Tokens are scoped to the specific approval step; revoking a recipient's access means cancelling the approval (and the workflow run with it).",
        },
        {
          heading: 'Common questions',
          body:
            "Magic link expired? Approvals don't have a hard expiry, but cancelling the approval invalidates them. Re-trigger the workflow run to issue fresh links. " +
            "Need everyone's approval (not first-to-decide)? Configure the approval step as 'all' rather than 'any' in the workflow builder. " +
            "Want to track approvals in a sheet? Create a Records sheet with status / decided-by / decided-at columns and configure the workflow to write the resolution back. The plumbing is sheet-driven; approvals don't carry their own list page.",
        },
      ],
    },
  },
} as const;

/** Top-level module keys (handy for /help nav generation, etc.). */
export type HelpModuleKey = keyof typeof helpContent;

/** Read-only handle to the full content library. */
export type HelpContent = typeof helpContent;

/** Re-export the connectors module shape for components that want a stronger contract. */
export type { ConnectorsHelp };
