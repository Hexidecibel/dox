-- Migration 0090: document requests — the composer.
--
-- WHY
-- ---
-- Everything the registry has built so far describes state. `requirements`
-- (0080) is the vocabulary of what a document can SATISFY. `supplier_requirements`
-- (0087) says which of those a given supplier owes. `shared/requirementGap.ts`
-- subtracts one from the other and produces a list of open items. What none of
-- it can do is ASK. The gap report ends at "this supplier owes you four things"
-- and the buyer's next move is an email nobody in the portal can see, chase or
-- audit.
--
-- These tables are the ask. One row per packet issued to one supplier, one row
-- per thing being asked for, and an internal routing record proving who issued
-- what, when.
--
-- The client's framing, which drove every decision below: "The composer is the
-- primitive. Every checklist source is a feeder into it." Gap detection, a
-- saved template, a future draft generator — all of them fill the SAME draft
-- and go out through the SAME issue path. Nothing here is a second pipeline.
--
--
-- A LINE SHOULD RESOLVE TO A REQUIREMENT. THIS IS THE LOAD-BEARING DECISION.
-- --------------------------------------------------------------------------
-- The client, verbatim: "A line that resolves to a document type can be
-- satisfied, can drive expiry, and can be counted by gap detection. A line that
-- is only free text produces a document the registry cannot reason about, which
-- quietly turns the portal back into a filing cabinet."
--
-- So `request_lines.requirement_id` is the point of the table. A typed line
-- joins to `document_requirements` and the arriving document is a registry
-- object; an untyped line produces an attachment and a shrug.
--
-- Free text is still supported, because a taxonomy always lags reality and the
-- alternative is a buyer going back to email for the one thing the vocabulary
-- has not caught up to yet. But it is EXCEPTIONAL, and the schema says so
-- rather than leaving it to a convention someone will forget:
--
--   * `line_kind` is an explicit column, not something inferred from
--     requirement_id being NULL. A caller who simply forgets to resolve a line
--     gets a CHECK violation (and a 400 from the API), not a silently untyped
--     line. Free text has to be ASKED for by name.
--   * The paired CHECK makes the two states mutually exclusive, so no row can
--     claim to be typed while carrying no type, or claim to be free text while
--     carrying one.
--   * The default is 'requirement'. The exceptional case is never the default.
--
-- The API surfaces a per-request count of free-text lines for the same reason,
-- so "how much of this packet is unreasonable-about" is a number on the screen
-- rather than something you have to scan for.
--
--
-- AMENDMENT IS A NEW VERSION, NEVER AN OVERWRITE
-- ---------------------------------------------
-- A client requirement, and a general rule in their programme: once a packet is
-- committed, both the original and the amended one survive. This is the same
-- instinct behind append-only `audit_log` and 0088's append-only
-- `entity_notes` — a compliance record you can quietly rewrite is worth less
-- than no record, because a reader cannot tell what they are looking at.
--
-- The mechanism: EACH ROW IN document_requests IS ONE VERSION.
--
--   root_request_id  the identity of the ask across all its versions. For v1
--                    it is the row's own id. NOT NULL, always.
--   version          1, 2, 3 ... within a root.
--   supersedes_id    the version this one replaces. NULL for v1.
--   superseded_at    stamped on the OLD row when it is replaced.
--
-- Amending an issued request INSERTs a new row (version N+1, same root) with a
-- fresh copy of every line, applies the changes there, and stamps
-- `superseded_at` on the old row. The old row's title, due date, status,
-- issued_at and lines are never touched again — its `status` deliberately
-- stays 'issued' rather than being rewritten to some 'superseded' value,
-- because what that row records is that it WAS issued, and that remains true.
-- Supersession is chain metadata, tracked in its own column, not a restatement
-- of the ask.
--
-- Amending a DRAFT is a plain update. Versioning begins at issue, because
-- before issue nothing has been committed and nobody outside has seen it;
-- versioning an unsent draft would produce a chain of rows nobody asked for.
--
-- AMENDMENT IS NOT RE-ISSUE, and conflating them is the easy mistake here:
--
--   amend    the SAME ask, corrected. Same root, version + 1. "The due date
--            moved" / "we also need the allergen matrix".
--   re-issue a NEW ask modelled on an old one. NEW root, version back to 1,
--            `reissue_of_request_id` kept as provenance. "Same packet, this
--            year's renewal" / "new item under an approved vendor".
--
-- A renewal that reused the original root would rewrite last year's record as
-- though it had always been about this year. The two columns are separate so
-- the chain and the lineage cannot be confused.
--
--
-- WHY TEMPLATES ARE THEIR OWN TABLE PAIR AND NOT A FLAG
-- ----------------------------------------------------
-- The cheap option is `document_requests.is_template INTEGER`. It is wrong for
-- the same reason 0087 refused a nullable supplier_id and 0088 refused to
-- widen `records_comments`: it smuggles a second, different question into rows
-- that answer the first one.
--
-- Concretely, a template has no supplier, no due date, no assigned buyer, no
-- issued_at, no version chain, and its lines have no status. Under a flag:
--
--   * `supplier_id` would have to become nullable — losing the single most
--     valuable constraint on the table. A request with no supplier is not an
--     incomplete request, it is not a request.
--   * `status`, `due_date`, `issued_at`, `version`, `root_request_id` and
--     every per-line status column become conditionally meaningless — present,
--     typed, and lying.
--   * EVERY query in the feature would have to carry `AND is_template = 0`
--     forever. The first one that forgets issues a template to a supplier, or
--     counts template lines in "what is still outstanding".
--
-- So: `request_templates` + `request_template_lines`. The template line table
-- is deliberately the composable SUBSET of a request line's columns — same
-- names, same types, minus status/status_changed_*/request_id — so
-- instantiating a template is a column-for-column copy rather than a
-- translation, and adding a field to one is an obvious prompt to add it to the
-- other.
--
-- The honest cost is a second, smaller CRUD surface. That is a real cost and it
-- is smaller than the cost of five permanently-conditional columns and a filter
-- that must never be forgotten.
--
--
-- THE ROUTING RECORD IS A SEPARATE TABLE BECAUSE IT MUST NEVER LEAK
-- ----------------------------------------------------------------
-- Client requirement: the internal routing record is created at issue and is
-- NEVER visible externally.
--
-- The guarantee is the allow-list projection in code
-- (`buildSupplierRequestView` in functions/lib/document-requests.ts, built
-- field-by-field exactly like `buildAlertLandingView` in
-- functions/lib/alert-links.ts). This table split is a SECOND layer under it:
-- an external projection reads `document_requests` + `request_lines`, and the
-- routing facts are not columns on either, so even a careless `SELECT *`
-- cannot reach them. Defence in depth, not a substitute for the allow-list.
--
-- It is also the right shape on its own terms. Routing exists only from the
-- moment of issue, so as columns on `document_requests` every one of them
-- would be NULL on every draft — the same conditionally-meaningless-column
-- smell rejected for templates one section up. One row per ISSUE EVENT: a
-- re-issued amendment gets its own routing row, linked to the previous one, so
-- "how many times did we actually send this, and who sent it" is a count.
--
-- `issued_at` lives on the request and `issued_by` lives on routing. The DATE
-- an ask was issued is part of the ask and a supplier may legitimately see it;
-- WHICH of our people pressed the button is internal and never goes out.
--
--
-- ONE ISSUE PATH REGARDLESS OF WHAT FILLED THE FORM
-- ------------------------------------------------
-- `origin` records what composed the draft — a person, a saved template, a gap
-- report, or a future generator. It is provenance ONLY. It does not select a
-- code path: `issueRequest()` is the single funnel, it writes one routing row
-- and one audit row, and it requires a human actor. A draft with
-- origin = 'generated' is exactly as unissued as any other draft until a person
-- reviews it and issues it. Nothing in this schema or the API lets a generator
-- issue on its own.
--
--
-- THE SQLite NULL-IN-UNIQUE TRAP — a THIRD answer, chosen on purpose
-- -----------------------------------------------------------------
-- SQLite treats NULLs as DISTINCT in a UNIQUE index, so a nullable key column
-- silently exempts exactly the rows you meant to constrain. The codebase has
-- two prior answers: 0086 folded NULL to '' in a COALESCE EXPRESSION index
-- (because NULL was load-bearing in the read path and a '' sentinel would have
-- been an unmatchable foreign key); 0087 sidestepped it entirely with all-NOT-
-- NULL columns and a plain UNIQUE.
--
-- This migration needs a third answer, in two places, and neither prior one
-- fits:
--
--  1. "a typed line appears at most once per request".
--     `request_lines.requirement_id` is NULLABLE — that is the free-text
--     escape hatch, not an oversight. A plain
--       UNIQUE (request_id, requirement_id)
--     would constrain typed lines correctly and exempt every free-text line by
--     accident. The accident happens to be the behaviour we want (a packet may
--     legitimately carry several distinct free-text asks) and relying on an
--     accident is how the next person removes it.
--     0086's COALESCE form would be actively WRONG here: folding NULL to ''
--     would make all free-text lines on one request collide with each other.
--     In 0086 all-NULL named one specific scope; here NULL means "this
--     constraint does not apply to this row".
--     So: a PARTIAL unique index with `WHERE requirement_id IS NOT NULL`. The
--     exemption is a stated predicate an index definition can be read for,
--     rather than an emergent property of NULL comparison.
--
--  2. "at most one live version per root".
--     Same form, opposite column: `WHERE superseded_at IS NULL`. The key
--     column (root_request_id) is NOT NULL, so nothing is exempt within the
--     predicate. This is the constraint that makes "the current version of this
--     ask" a single indexed lookup instead of an ORDER BY version DESC LIMIT 1
--     that quietly returns the wrong row if two amendments ever race.
--
-- `UNIQUE(root_request_id, version)` alongside it is a plain UNIQUE, both
-- columns NOT NULL, no trap, 0087's case exactly.
--
--
-- TENANT_ID IS DENORMALIZED ON EVERY TABLE, including the child ones. The
-- parents carry it, but a request line's tenant is otherwise reachable only
-- through a join, and every read in this feature filters on it directly — the
-- same arrangement supplier_requirements and claim_type_requirements use.


-- ---------------------------------------------------------------------------
-- document_requests — one VERSION of one ask, issued to one supplier
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- NOT NULL on purpose: an ask with no supplier is not a draft request, it is
  -- a template, and templates live in their own table. See the header.
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  -- Version chain. root_request_id == id for a first version.
  root_request_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  -- The version this row replaces. Set at INSERT of the amendment; never
  -- updated, so the chain is immutable in the direction it was written.
  supersedes_id TEXT REFERENCES document_requests(id),
  -- Stamped on the OLD row when an amendment replaces it. NULL = this is the
  -- live version. The only column ever written to a superseded row.
  superseded_at TEXT,
  -- Why the amendment happened, captured at amend time so the chain explains
  -- itself without a reader having to diff two packets.
  amendment_reason TEXT,

  -- Lineage for a re-issue: a NEW root modelled on an older ask. Distinct from
  -- supersedes_id, which is the SAME ask corrected.
  reissue_of_request_id TEXT REFERENCES document_requests(id),

  -- What FILLED this draft. Provenance only — it never selects a code path.
  origin TEXT NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'template', 'gap', 'generated')),
  -- Free-form pointer back to whatever the origin was (a template id, a
  -- generator run id). Deliberately not a foreign key: origins outlive the
  -- rows that produced them and a template deleted next year must not take the
  -- history of what it composed with it.
  origin_ref TEXT,

  title TEXT NOT NULL,
  -- The covering sentence a supplier reads above the line items.
  intro TEXT,
  due_date TEXT,
  -- The buyer who owns chasing this. Internal; never in the external view.
  assigned_to TEXT REFERENCES users(id),

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'cancelled', 'closed')),
  -- Set once, at issue, by the one issue path. A superseded row keeps its own.
  issued_at TEXT,
  closed_at TEXT,
  cancelled_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

-- The list view: everything outstanding for one supplier.
CREATE INDEX IF NOT EXISTS idx_document_requests_supplier
  ON document_requests(tenant_id, supplier_id, status);

-- Walk one ask's history in order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_requests_root_version
  ON document_requests(root_request_id, version);

-- AT MOST ONE LIVE VERSION PER ASK. Partial index — see the header's third
-- section. This is what makes "the current version" a lookup rather than a
-- sort, and what stops two concurrent amendments from both landing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_requests_root_live
  ON document_requests(root_request_id) WHERE superseded_at IS NULL;

-- "What is on my desk", the buyer's own queue.
CREATE INDEX IF NOT EXISTS idx_document_requests_assigned
  ON document_requests(tenant_id, assigned_to, status);

-- "What is overdue".
CREATE INDEX IF NOT EXISTS idx_document_requests_due
  ON document_requests(tenant_id, due_date);

-- Reverse-walk the chain: which amendment replaced this row.
CREATE INDEX IF NOT EXISTS idx_document_requests_supersedes
  ON document_requests(supersedes_id) WHERE supersedes_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- request_lines — one thing being asked for
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,

  -- Explicit, defaulted to the typed case, and paired with the CHECK below so
  -- an untyped line can only ever be a deliberate one. See the header.
  line_kind TEXT NOT NULL DEFAULT 'requirement'
    CHECK (line_kind IN ('requirement', 'free_text')),
  -- ON DELETE CASCADE matches document_requirements(0080)'s handling of the
  -- same foreign key. `requirements` soft-deletes (active = 0) precisely so
  -- its ids keep resolving for history, so in practice this fires only on
  -- tenant teardown.
  requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,

  -- The five fields the client named per line. `name` is what the supplier
  -- reads; for a typed line it defaults to the requirement's name but stays
  -- editable, because "Allergen Matrix" is the registry's word for it and the
  -- supplier may need "the allergen statement your QA team signs".
  name TEXT NOT NULL,
  explanation TEXT,
  acceptable_formats TEXT,
  criteria TEXT,
  -- Free text, matching documents.owner (0077): a person or a department, on
  -- either side of the relationship. Not a user FK — the owner of a line is
  -- frequently someone at the supplier who has no portal account.
  owner TEXT,

  -- Same two tiers as supplier_requirements (0087), same meaning: 'required'
  -- counts, 'recommended' is advisory.
  tier TEXT NOT NULL DEFAULT 'required'
    CHECK (tier IN ('required', 'recommended')),

  -- The client's exact five. No transition graph is enforced: they specified
  -- states, not a graph, and every plausible edge is legitimate somewhere —
  -- 'accepted' back to 'needs_attention' is exactly what happens when a
  -- document is later found deficient. Each change is stamped and audited
  -- instead.
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'received', 'under_review', 'accepted', 'needs_attention')),
  status_note TEXT,
  status_changed_at TEXT,
  status_changed_by TEXT REFERENCES users(id),

  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,

  -- The two states are mutually exclusive and neither can be half-declared.
  CHECK (
    (line_kind = 'requirement' AND requirement_id IS NOT NULL) OR
    (line_kind = 'free_text' AND requirement_id IS NULL)
  )
);

-- Render a packet in its composed order.
CREATE INDEX IF NOT EXISTS idx_request_lines_request
  ON request_lines(request_id, sort_order);

-- A TYPED LINE APPEARS AT MOST ONCE PER REQUEST. Partial index: free-text
-- lines are exempted by a stated predicate rather than by NULL comparison, and
-- a request may legitimately carry several distinct free-text asks. See the
-- header's third section for why 0086's COALESCE form would be wrong here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_lines_requirement_unique
  ON request_lines(request_id, requirement_id) WHERE requirement_id IS NOT NULL;

-- The satisfaction join: given a requirement, which open lines are asking for
-- it. This is the access path that lets a request line meet
-- `document_requirements` without a parallel mechanism.
CREATE INDEX IF NOT EXISTS idx_request_lines_requirement
  ON request_lines(tenant_id, requirement_id) WHERE requirement_id IS NOT NULL;

-- "What is still outstanding across every open request."
CREATE INDEX IF NOT EXISTS idx_request_lines_status
  ON request_lines(tenant_id, status);


-- ---------------------------------------------------------------------------
-- request_routing — the internal record of ONE issue event. Never external.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_routing (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- One routing row per issued request VERSION. UNIQUE, so the single issue
  -- path cannot double-fire and produce two records of one event.
  request_id TEXT NOT NULL UNIQUE REFERENCES document_requests(id) ON DELETE CASCADE,

  -- WHO pressed issue. Internal — the counterpart date lives on the request
  -- because a supplier may see when they were asked, never by whom internally.
  -- NOT NULL: the one issue path requires a human actor, and that requirement
  -- is what stops a future generator from issuing on its own.
  issued_by TEXT NOT NULL REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Which version of the ask this event committed. Denormalized off the
  -- request so the issue log reads on its own.
  version INTEGER NOT NULL DEFAULT 1,
  -- The routing row for the version this one amends, so "how many times was
  -- this actually sent, and by whom" is one walk.
  amendment_of_routing_id TEXT REFERENCES request_routing(id),

  channel TEXT NOT NULL DEFAULT 'portal'
    CHECK (channel IN ('portal', 'email', 'manual')),
  -- Who it went to, as recorded by us. Internal: it is our record of our own
  -- dispatch, not a field the recipient gets to read back.
  recipient TEXT,
  internal_notes TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The issue log for one supplier, newest first.
CREATE INDEX IF NOT EXISTS idx_request_routing_tenant
  ON request_routing(tenant_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_routing_issued_by
  ON request_routing(tenant_id, issued_by, issued_at DESC);


-- ---------------------------------------------------------------------------
-- request_templates — a composed set, saved and re-issued
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  -- Instantiation computes due_date = today + this, when set. Stored as a
  -- duration rather than a date because a template outlives any one deadline.
  default_due_in_days INTEGER,

  -- Soft-delete, matching `requirements`: a retired template must stop being
  -- offered without breaking `document_requests.origin_ref` pointers.
  active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,

  -- Both columns NOT NULL, so a plain UNIQUE is correct and no NULL exemption
  -- exists. 0087's case exactly.
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_request_templates_tenant
  ON request_templates(tenant_id, active, name);


-- ---------------------------------------------------------------------------
-- request_template_lines — the composable SUBSET of a request line
-- ---------------------------------------------------------------------------
-- Column-for-column identical to request_lines minus request_id, status,
-- status_note and status_changed_*. Those are the columns a template cannot
-- meaningfully hold, and their absence here is the whole argument against the
-- is_template flag, made concrete.
CREATE TABLE IF NOT EXISTS request_template_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES request_templates(id) ON DELETE CASCADE,

  line_kind TEXT NOT NULL DEFAULT 'requirement'
    CHECK (line_kind IN ('requirement', 'free_text')),
  requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  explanation TEXT,
  acceptable_formats TEXT,
  criteria TEXT,
  owner TEXT,
  tier TEXT NOT NULL DEFAULT 'required'
    CHECK (tier IN ('required', 'recommended')),
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,

  CHECK (
    (line_kind = 'requirement' AND requirement_id IS NOT NULL) OR
    (line_kind = 'free_text' AND requirement_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_request_template_lines_template
  ON request_template_lines(template_id, sort_order);

-- Same partial-index reasoning as request_lines: a typed line once per
-- template, free-text lines exempted by predicate rather than by NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_template_lines_requirement_unique
  ON request_template_lines(template_id, requirement_id) WHERE requirement_id IS NOT NULL;
