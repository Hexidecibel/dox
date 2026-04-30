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
  search,
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
