# Plan

## In Progress

### Smarter Extraction (Phases 1–3)

**Status:** in-progress

**Summary:** The learning loop is broken end-to-end. `extraction_examples`
sits empty in staging despite 27 A/B evals; the text extractor is bleeding
filename tokens (e.g. Pacific Cheese's stale `25071R`) into structured
fields like `lot_number` / `code_date`; supplier names aren't deduped so
`Medosweet` exists three times; document type never gets canonicalized
(all evaluated rows have `document_type_id = NULL`); and we capture no
per-field signal — reviewer picks, dismissals, value edits, and table
edits all evaporate at approve time. Plan: ship three coherent phases —
foundation fixes, signal capture, then pre-fill + trust ladder + learning
dashboard — so the system progressively learns from every reviewer
decision and graduates suppliers from manual review through pre-fill,
silent-apply, and eventually full auto-ingest.

**Full plan:** `/home/hexi/.claude/plans/breezy-hatching-moonbeam.md`

#### Phase 1 — Foundation Fixes ships when:
- Filename no longer appears in extracted lot/code/date fields for
  Pacific Cheese
- Compare panel shows compacted (no-null) field counts
- New ingests populate `document_type_id` from guess
- Three Medosweet variants collapse to one supplier row on next ingest
- Approving with "Use these results" produces an `extraction_examples` row

#### Phase 2 — Capture All Four Signals ships when:
- Approving any reviewed item populates `reviewer_field_picks`,
  `reviewer_field_dismissals`, `reviewer_table_edits` as appropriate
- Per-field picker buttons in the compare panel work
- Single-side items default to the correct source

#### Phase 3 — Pre-Fill from Learned Preferences ships when:
- A queue item with learned preferences renders pre-filled with badges
- Reviewer can confirm with one click; overrides update preferences
- `extraction_examples` accumulates synthetic rows from preference rollups
- Uncertain fields surface at the top of the review UI with badges
- Trust ladder state visible per (supplier, doctype); promotion/demotion
  rules fire correctly on approve/override
- Learning dashboard renders override-rate trend + trust-level distribution

## Planned

### Records — Collaborative sheets, forms, and workflows

**Status:** planned

**Goal / motivation:** Build a Smartsheet-class collaborative module
inside dox so the same tenants who already trust us with their COAs,
suppliers, and products can run the *operational work around* those
documents — quality intake, new-item approval, audits, recalls, supplier
onboarding, customer requirements tracking — without bouncing to a
generic spreadsheet tool that can't talk to their dox data. The wedge
isn't "another grid"; it's that every cell can natively reference a
real dox entity (supplier, product, document, user) with hover-preview,
inline doc rendering, and live link-back. We are not trying to beat
Smartsheet at being a spreadsheet. We are betting that when the
spreadsheet *is* the document portal, the operations workflows our
users already pay for collapse into a single tool.

**Design philosophy — records-with-many-views (the inversion):**

In Smartsheet, the grid *is* the truth: a row is a row in a table, and
"views" are reskins of that table. We invert that. The truth is a
**Record** — a typed object with its own URL, page, audit history,
relationships, comments, and attachments. A grid is just one view onto
a collection of Records. Board, Timeline, Gallery, and Calendar are
equal first-class views, not bolt-ons. This shows up in five concrete
UX/visual bets that the implementation must hold the line on:

1. **Multi-view per sheet, switchable in one click.** Grid / Kanban /
   Timeline / Gallery / Calendar all render the same record set; the
   toggle lives in the sheet header. Switching views is a viewport
   change, not a query change — the same filter/sort/group state
   carries across views.
2. **Rich row drawer.** Clicking any row anywhere (including a Kanban
   card or Calendar event) opens a side drawer (Linear/Notion-style)
   with: inline document preview (we already render PDFs, images,
   text/CSV), photo carousel for attachments, supplier/product cards,
   activity feed, comments, and the column values themselves. The
   drawer is the Record page; double-clicking opens it as a full route
   for permalinks. Editing a value updates the underlying record, not
   "the grid cell."
3. **Native entity chips.** A column whose type is `supplier_ref` does
   not store a string — it stores a `supplier_id` and renders as a
   chip. Hover surfaces a mini-card pulled from the live Supplier
   record (recent docs, alias list, last activity). Same for
   `product_ref`, `document_ref`, `user_ref`. This is the dox-only
   superpower — generic competitors literally cannot do this without
   integration work the customer has to build.
4. **Forms feel like Typeform, not Google Forms.** One question per
   screen on mobile, large tap targets, conditional logic
   (show/skip/branch), progress bar, autosave, photo capture as a
   native step. The QC-from-warehouse use case demands phone-first.
   The canonical use case is a QC tech standing on a warehouse floor
   with a phone, snapping a photo of a pallet and attaching it to a
   record in seconds — the form must be a one-tap-from-home experience
   on mobile, not a desktop form that happens to render small.
   Desktop forms collapse the same flow into a single column with
   anchor scroll.
5. **Workflow as visualization.** Approval routing is not a checklist
   of checkboxes; it renders as a flowing graph (nodes = steps, edges
   = transitions, avatars on nodes for assignees, color-coded live
   status). The same engine drives cross-sheet automations, just with
   different node types.
6. **Mobile-first throughout.** Every view (Grid, Board, Timeline,
   Gallery, Calendar) must have a deliberate mobile design, not a
   degraded-desktop layout. Grid in particular collapses to a stacked
   card list on phones; the side drawer becomes a full-screen modal.
   Touch targets are >=44px, action buttons sit in the thumb zone,
   lists support pull-to-refresh, and cards support swipe gestures
   (archive, comment, etc.) where they fit. The mobile experience is
   **the** competitive wedge against Smartsheet (whose mobile is bad)
   — it is treated as a primary surface, not a derivative.

The aesthetic mandate from the user: "beautiful and unique, not
cookie-cutter Smartsheet." The visual identity should lean Linear /
Notion / Airtable Pro rather than enterprise grid — generous
whitespace, soft shadows on the drawer, micro-interactions on view
switches, and entity chips that feel like rich content, not text.

#### Data model

All tables are tenant-scoped (`tenant_id` FK), use the existing
`lower(hex(randomblob(8)))` ID convention, and write to the existing
`audit_log` for row-level history. Naming uses the `records_*` prefix
to avoid collision with `documents`, `bundles`, etc.

- **`records_sheets`** — the container. `id`, `tenant_id`, `name`,
  `slug`, `description`, `icon`, `color`, `template_key` (nullable;
  e.g. `quality_intake`, `new_item_approval` — identifies sheets
  spawned from a built-in template so we can ship updates), `archived`,
  `created_by`, timestamps.
- **`records_columns`** — the schema for a sheet. `id`, `sheet_id`,
  `key` (slug, immutable, used in formulas/automations), `label`,
  `type` (see below), `config` (JSON — type-specific: dropdown options,
  number format, formula expression, ref entity type, etc.),
  `required`, `display_order`, `width`, `archived`. Column types:
  `text`, `long_text`, `number`, `currency`, `percent`, `date`,
  `datetime`, `duration`, `checkbox`, `dropdown_single`,
  `dropdown_multi`, `contact` (internal user picker), `email`, `url`,
  `phone`, `attachment`, `formula`, `rollup`, and the entity refs
  `supplier_ref`, `product_ref`, `document_ref`, `record_ref` (link to
  another Record in any sheet — enables cross-sheet relationships).
  `formula` columns evaluate via our own small expression evaluator
  (no HyperFormula / FormulaJS dependency); the supported function
  set is fixed: `SUM`, `IF`, `CONCAT`, `AND`, `OR`, `NOT`, basic date
  math, and basic arithmetic. No user-defined functions. `rollup`
  columns reuse the same evaluator over a `record_ref` traversal.
- **`records_rows`** — the Record itself. `id`, `sheet_id`,
  `tenant_id`, `display_title` (computed from a designated title
  column, denormalized for fast list rendering), `data` (JSON, keyed
  by column `key` — single source of truth for cell values; D1 has no
  JSON ops, so we live with whole-row reads/writes and rely on
  per-sheet pagination), `position` (REAL, fractional indexing for
  drag reorder without renumbering), `parent_row_id` (nullable,
  enables hierarchy / sub-rows), `archived`, `created_by`,
  `updated_by`, timestamps. We deliberately do **not** explode columns
  into a wide table — the JSON-blob approach lets us evolve schema
  without ALTER TABLE per sheet.
- **`records_row_attachments`** — `id`, `row_id`, `column_key`
  (nullable; null = drawer-level attachment, set = bound to a specific
  attachment column), `r2_key`, `file_name`, `file_size`, `mime_type`,
  `checksum`, `uploaded_by`, `created_at`. Reuses the existing R2
  bucket and upload pathway.
- **`records_views`** — saved views. `id`, `sheet_id`, `name`,
  `view_type` (`grid` | `kanban` | `timeline` | `gallery` |
  `calendar`), `config` (JSON: filters, sort, group-by column for
  Kanban, start/end column for Timeline, cover-image column for
  Gallery, date column for Calendar, visible columns + order),
  `is_default`, `shared` (0 = personal, 1 = shared with sheet),
  `created_by`, timestamps.
- **`records_comments`** — `id`, `row_id`, `parent_comment_id`
  (threading), `author_id`, `body` (markdown), `mentions` (JSON array
  of user_ids — drives notifications), `created_at`, `edited_at`.
- **`records_activity`** — per-row activity feed for the drawer.
  `id`, `row_id`, `actor_id`, `kind` (`created`, `updated`,
  `comment_added`, `attachment_added`, `workflow_advanced`,
  `automation_fired`, …), `details` (JSON — for `updated`: `{column,
  from, to}`), `created_at`. We mirror critical events to `audit_log`
  too, but `records_activity` is denormalized for the drawer feed
  (cheap read, no joins).
- **`records_forms`** — `id`, `sheet_id`, `name`, `slug` (unique
  per-tenant, used in public URL `/r/<slug>`), `config` (JSON: ordered
  question list, conditional logic rules, theme, completion message,
  redirect URL), `auth_mode` (`public` | `link_token` | `tenant_user`
  | `email_verified`), `submit_action` (default `create_row`; future:
  `update_row` for Update Requests), `active`, `created_by`,
  timestamps.
- **`records_form_submissions`** — `id`, `form_id`, `row_id` (the
  resulting row), `submitted_by_user_id` (nullable for public),
  `submitted_email` (nullable, captured for public/link_token forms),
  `payload` (JSON of raw answers — preserved even if columns change
  later), `ip_address`, `user_agent`, `created_at`.
- **`records_update_requests`** — the killer feature. `id`,
  `row_id`, `target_column_keys` (JSON array — fields to fill),
  `recipient_email`, `recipient_user_id` (nullable), `token` (random,
  used in URL), `expires_at`, `status` (`pending` | `submitted` |
  `expired` | `cancelled`), `submitted_at`, `created_by`, `created_at`.
  A submitted Update Request triggers a row update with the partial
  payload and a row-activity entry tagged `update_request_submitted`.
- **`records_workflows`** — `id`, `sheet_id`, `name`, `definition`
  (JSON — node graph: steps, transitions, conditions, assignments;
  see Workflow engine below), `active`, `created_by`, timestamps.
  One workflow per "kind of routing" on a sheet (e.g. "Approval", "QC
  Triage"); a sheet can host multiple.
- **`records_workflow_runs`** — `id`, `workflow_id`, `row_id`,
  `current_step_id`, `state` (`active` | `completed` | `cancelled` |
  `error`), `context` (JSON — accumulated decisions, who approved
  what), `started_at`, `completed_at`. Drives the workflow
  visualization.
- **`records_workflow_actions`** — per-step action log. `id`,
  `run_id`, `step_id`, `actor_id`, `action` (`approve` | `reject` |
  `delegate` | `comment` | `auto_advance` | `cross_sheet_push` | …),
  `payload` (JSON), `created_at`.
- **`records_automations`** — sheet-scoped rules using the same
  engine as workflows but triggered by row events (create/update/cron).
  `id`, `sheet_id`, `name`, `trigger` (JSON: type + config),
  `condition` (JSON: filter expression), `actions` (JSON array:
  `update_row` | `push_to_sheet` | `send_email_report` |
  `start_workflow` | `notify_users`), `active`, `last_run_at`, audit
  fields. Cross-sheet automations (Quality → Accounting) are just an
  automation whose action is `push_to_sheet`.

Notes:
- We deliberately keep cell values inside a JSON `data` blob on
  `records_rows` rather than a per-cell EAV table. EAV explodes write
  cost and kills D1 pagination; JSON is fine because D1/SQLite reads
  whole rows anyway and we never need cross-sheet cell-level queries
  (entity references are real FKs we extract on save).
- Entity-ref columns extract a parallel index on save:
  **`records_row_refs`** (`row_id`, `column_key`, `ref_type`,
  `ref_id`) so we can answer "show all records that reference
  supplier X" without scanning every JSON blob. Maintained by the API
  layer on row write.

#### API surface

REST under `/api/records/...`, mirroring the per-feature directory
pattern in `functions/api/`:

```
functions/api/records/
  sheets/
    index.ts                        GET list, POST create
    [id].ts                         GET, PATCH, DELETE
    [id]/columns/index.ts           GET, POST (add column), PATCH (reorder)
    [id]/columns/[colId].ts         PATCH (rename/retype), DELETE (archive)
    [id]/rows/index.ts              GET (paginated, with view filters), POST
    [id]/rows/[rowId].ts            GET, PATCH, DELETE
    [id]/rows/[rowId]/attachments   POST, GET (R2-backed)
    [id]/rows/[rowId]/comments      GET, POST
    [id]/rows/[rowId]/activity      GET
    [id]/rows/[rowId]/send-report   POST (email row + attachments via Resend)
    [id]/views/index.ts             GET, POST
    [id]/views/[viewId].ts          PATCH, DELETE
    [id]/forms/index.ts             GET, POST
    [id]/forms/[formId].ts          GET, PATCH, DELETE
    [id]/workflows/index.ts         GET, POST
    [id]/automations/index.ts       GET, POST
  forms/
    public/[slug].ts                GET (form schema for public render),
                                    POST (submit) — bypasses JWT, rate-limited
  update-requests/
    index.ts                        POST (create + send email)
    [token].ts                      GET (load by token), POST (submit)
  workflow-runs/
    [id]/advance.ts                 POST (approve/reject/delegate)
    [id].ts                         GET (state + visualization data)
```

Auth: all `/api/records/*` routes go through the existing
`_middleware.ts` JWT/API-key path. Public form and Update Request
routes are explicitly carved out with their own token check; we add
those exemptions to the middleware allowlist alongside the existing
`/api/auth/*` and `/api/webhooks/*` exceptions. Public form submit
endpoints validate a Cloudflare Turnstile token server-side as the
primary abuse gate; per-IP per-form rate limits via
`functions/lib/ratelimit.ts` are layered on top.

GraphQL additions (parallel to REST, in
`functions/lib/graphql/`): types for `Sheet`, `RecordRow`,
`RecordColumn`, `RecordView`, `RecordForm`, `WorkflowRun`. Resolvers
delegate to the same service-layer functions the REST handlers call —
no logic in handler files. This is a good time to make the
service-layer pattern explicit; today most of `functions/api/*` is
direct D1 in handlers, which doesn't scale to a module this size.

Shared types in `shared/types.ts`: `RecordSheetRow`, `RecordColumnRow`,
`RecordRow`, `RecordViewRow`, `RecordFormRow`, `RecordCommentRow`,
`RecordActivityRow`, `WorkflowDefinition`, `WorkflowRunRow`, plus
`ApiRecordSheet`, `ApiRecordRow` (with joined `creator_name`,
`updated_by_name`, ref-resolution caches), and request/response
wrappers. Discriminated union `ColumnType` gates `column.config` shape.

#### Frontend surface

New top-level nav entry "Records" (between "Documents" and "Bundles"
in the sidebar). Routes:

```
src/pages/records/
  RecordsHome.tsx              /records              (sheet list, recent, templates)
  SheetDetail.tsx              /records/:sheetId     (the multi-view container)
  RecordDetail.tsx             /records/:sheetId/r/:rowId  (drawer-as-route permalink)
  FormBuilder.tsx              /records/:sheetId/forms/:formId
  PublicForm.tsx               /r/:formSlug          (public route, no auth)
  UpdateRequestForm.tsx        /update/:token        (public, token-gated)
  WorkflowBuilder.tsx          /records/:sheetId/workflows/:workflowId
  AutomationBuilder.tsx        /records/:sheetId/automations/:automationId
```

New components in `src/components/records/`:

- `SheetHeader` — name, view switcher, filter/sort/group controls,
  share, "+ New record" CTA.
- `views/GridView`, `views/KanbanView`, `views/TimelineView`,
  `views/GalleryView`, `views/CalendarView` — all consume a single
  `useSheetRecords({ sheetId, viewConfig })` hook and render the same
  `Record[]`. View-specific UI lives in the view file; row data does
  not.
- `RowDrawer` — the rich drawer. Tabs: **Details** (column values
  rendered with type-aware widgets), **Attachments** (carousel, drop
  zone, inline preview reusing `DocumentDetail.tsx`'s preview
  component), **Activity** (feed), **Comments** (threaded, mention
  support), **Workflow** (current run visualization if applicable).
- `EntityChip` — supplier/product/document/user reference cell.
  Renders avatar/icon + name; hover opens `EntityHoverCard` with
  recent activity from the linked entity. Single component, branched
  on `ref_type`.
- `ColumnTypeWidget` — switch on column type to render the right
  editor (date picker, dropdown, entity picker modal, formula display,
  etc.).
- `FormBuilder` + `FormPlayer` — drag-to-reorder builder; player has
  two layouts (`one_per_screen` mobile, `single_column` desktop)
  driven by viewport.
- `WorkflowGraph` — uses ReactFlow (likely; Open Question) to render
  the node graph; live status from polling/WebSocket subscription.
- `AutomationBuilder` — when-this-then-that form, less visual than
  Workflow.

Where it fits: "Records" lives next to "Documents" in nav; entity
chips throughout dox link back to records (e.g. supplier detail page
gets a "Records referencing this supplier" tab — this is what makes
the integration *feel* native rather than bolted on).

#### View system

All views consume one normalized response: `{ records: ApiRecord[],
columns: ApiRecordColumn[], view_config, total }`. View-specific
config:

- **Grid** — column visibility/order/width, row height, frozen
  columns. Default view if none saved.
- **Kanban** — `group_by_column` (must be a `dropdown_single` or
  `contact` column); columns of the board = options of that column.
  Drag between columns mutates the cell value.
- **Timeline** — `start_column` + `end_column` (date or datetime),
  optional `swimlane_column`. Drag to reschedule.
- **Gallery** — `cover_attachment_column` (renders first image),
  `card_fields` (which columns to show on the card). The QC-photos
  use case lives here.
- **Calendar** — `date_column` (single), color-by-column. Click a day
  to create a row pre-filled with that date.

Saved views (`records_views`) store a complete view spec; switching
views is a route param (`?view=<viewId>`) so views are linkable. Each
view has filter/sort/group state; switching view types preserves the
filter/sort/group portion when possible (Grid → Kanban keeps filters,
adds a default group_by). "Personal" views are only visible to the
creator; "shared" views are visible to anyone with sheet access.

#### Form builder

Forms are derived from the column schema, not authored
free-form. The form spec is a list of "questions," each pointing to a
column key plus optional override of label/help text and a
conditional-show rule (DSL: `{column_key, operator, value}` — same
expression engine the automation/workflow conditions use). This means
columns and forms can't drift; renaming a column updates every form
that references it.

Mobile renderer: one question per screen, full-bleed input, swipe or
tap-to-advance, autosave to `localStorage` by token, photo capture
uses native `<input type="file" capture>`. Desktop renderer:
single-column scrollable. Both share the same component tree, just
different parent layout. Submission writes a row; if `auth_mode =
public`, captures `submitted_email`; if `link_token`, validates the
token first.

Public form URL: `https://<tenant>.dox.app/r/<slug>` — `<slug>` is
unique per tenant. Embed mode (`/r/<slug>?embed=1`) strips chrome for
iframe use.

Abuse protection on every public form: **Cloudflare Turnstile**
(invisible CAPTCHA) is the primary defense, validated server-side on
submit before the row is written. Per-IP per-form rate limits via the
existing D1 `ratelimit.ts` are the secondary layer. The Turnstile
binding is stood up in Phase 1 alongside Durable Objects so Phase 2's
form route plugs in without a fresh infra change.

#### Workflow engine

Workflows and automations share a single primitive: a
**rule-and-action graph**. A workflow is a graph with stateful steps
(approval gates, assignments, branches, completion); an automation is
a stateless single-step trigger→condition→action(s). Sharing the
engine means we maintain one expression evaluator, one assignment
resolver, one notification emitter.

Node types (v1):
- **Trigger** (automation only): `row_created`, `row_updated`
  (with column filter), `field_changed`, `form_submitted`,
  `cron` (e.g. weekly digest).
- **Condition**: filter expression on row + workflow context.
  Branches accordingly.
- **Approval step**: assignees (static user list, role, or
  `contact` column reference), aggregation rule (`any` | `all` |
  `majority`), SLA (optional). Renders in the Workflow tab of the
  drawer with avatars + status.
- **Action**: `update_row`, `push_to_sheet` (the cross-sheet
  mechanism — maps source column keys to target column keys; creates
  a new row in the target sheet, optionally back-linking via a
  `record_ref` column), `send_email_report` (Resend, reuses
  `functions/lib/email.ts`), `notify_users`.
- **Wait** (v2): time-based delay; out of scope for v1.

Workflow runs are the stateful unit. When a triggering row event
fires, we either advance an existing run (matching `(workflow_id,
row_id)`) or start a new one. The graph visualization queries
`records_workflow_runs` + `records_workflow_actions` and hydrates the
UI with `current_step_id` + per-step status.

The Quality → Accounting credit example becomes: an automation on
the Quality sheet with `trigger = row_updated`, `condition =
status == 'credit_owed'`, `action = push_to_sheet({sheet:
accounting_credits, mapping: {...}})`. No special-case code.

#### Integration with existing dox

This is the moat. Concrete touch points:

- **Entity-ref columns** are real FKs to `suppliers`,
  `products`, `documents`, `users`. Hover cards on the chip call
  `/api/suppliers/[id]`, `/api/documents/[id]`, etc. — endpoints
  that already exist.
- **Document attachments inside a row** can either (a) upload a
  fresh file (lives in `records_row_attachments`, R2-backed) or (b)
  link an existing dox `document_id` (no copy; chip renders inline
  preview using the same component as `DocumentDetail.tsx`). This
  collapses "the COA on this row" and "the COA in the doc portal"
  into one artifact.
- **Agent / ingest pipeline can write rows.** A new ingest target —
  `POST /api/records/sheets/[id]/rows` accepted via `X-API-Key` —
  lets the existing email-ingest worker, MindStudio, or the
  in-house extractor drop a structured row into a Records sheet.
  The Quality Intake template's intended ingestion path is
  email-attachment → photo + supplier extracted → row created with
  `supplier_ref`, photo attached, ready for QC review.
- **Audit log**: row-level events mirror to `audit_log` so the
  existing tenant audit page surfaces records activity alongside
  document activity.
- **Permissions**: reuse the existing 4-role model. v1 sheet
  permissions are coarse — sheet-level read/write/admin gated by
  tenant role. Per-column or per-row ACLs are explicitly out of
  scope.
- **Search**: short-term, sheet-scoped search on `data` JSON via a
  `LIKE` scan with column-aware filters. Long-term, integrate with
  the existing natural-language search.

#### Phased rollout

Each phase ships behind a feature flag (`records_enabled` per tenant)
so we can dogfood with our own quality sheet before opening it to
customers.

**Phase 1 — Primitives (the slab).** Sheets, columns (all
non-formula types including the four entity refs), rows with JSON
data, attachments, the row drawer, comments, activity feed,
audit-log integration, permissions, and a working Grid view. No
saved views yet — Grid renders the canonical column order with
client-side filter/sort. No forms, no workflows, no Kanban/Timeline/
Gallery/Calendar.

Phase 1 also stands up the real-time + abuse-protection infrastructure
that later phases depend on:

- **Durable Objects layer for Sheet sessions.** One DO instance per
  Sheet, holding presence (who's viewing), recent edits (ring buffer
  for late-joiners), and optimistic update fan-out to connected
  clients. Cell edits round-trip through the DO so every viewer sees
  them within a frame; this replaces what would otherwise be polling.
- **Cloudflare Turnstile binding setup.** Public forms don't ship
  until Phase 2, but we wire the Turnstile binding (env var, secret,
  client SDK plumbing) in Phase 1 since DOs already make this a new
  infra phase — better to land both new surfaces together than to
  re-open the deploy/config story in Phase 2.

Estimated duration: ~3 weeks (was ~2 weeks; the DO layer plus
Turnstile wiring add roughly a week of infra work). Phase 1 is **not
a developer-only milestone** — it ships to a real user (the author,
running real Quality intake against it) before Phase 2 starts.

**Ships when:** an internal user can create a sheet, add columns
including a supplier_ref, paste in 50 rows, attach a PDF to a row,
comment on it, see entity hover cards work, view audit history
end-to-end, and have a second browser tab show the edit live via the
Sheet's Durable Object.

**Phase 1 → Phase 2 gate.** Phase 2 work does not begin until the
author has dogfooded Phase 1 on real Quality data for at least one
full intake cycle (receive → log → review → close-out), and we have
a written list of friction points and missing primitives surfaced
from that use. The point of the gate is to let real workflow expose
the gaps in our primitives before we pile views, forms, and
workflows on top of them.

**Phase 2 — Views + Forms.** Saved views (`records_views`), Kanban,
Timeline, Gallery, Calendar — each with their config UI. Form
builder + public form route + form submissions writing rows.
Mobile-first form renderer. Update Request flow (token URLs, partial
row updates). **Ships when:** the Quality Intake template can be
used end-to-end on a phone — open public form link, snap photo,
pick supplier from chip picker, submit; the row appears in the
Quality sheet's Gallery view sorted by date.

**Phase 3 — Workflows + Automations.** Workflow engine, the graph
visualization, approval steps with assignees and SLAs, automations
(including the cross-sheet `push_to_sheet` action), `send_email_
report` action, in-app notifications for assignees. **Ships when:**
New Item Approval template can route a row through Sales → Quality
→ Operations → Finance, each approver sees the row in their queue,
the workflow visualization updates live, and final approval pushes
a row to a downstream "Approved Items" sheet.

**Phase 4 — Templates: Quality Intake + New Item Approval.**
Polish, content, and seeding. Both templates ship as canonical
sheet/form/workflow bundles via the `template_key` mechanism: a
tenant clicks "Use template," we provision a sheet with the right
columns (supplier_ref, photo attachment, date, severity dropdown,
…), the form (Typeform-style mobile capture), and any associated
workflow or automation. We also build the trending report —
pivot/group by supplier across the Quality sheet — as the demo
hook. **Ships when:** a new tenant can go from zero to a working
Quality program in under five minutes; New Item Approval is
sales-demoable end-to-end with believable seed data.

#### Decided

These were open architectural forks; they are now locked in. Each
entry: the decision, why we chose it over the alternatives, and any
implication for scope or timeline.

1. **Real-time mechanism: Durable Objects from day 1.** Each Sheet
   becomes a Durable Object instance owning that sheet's session
   state — presence, cursors, recent edits, and optimistic cell-update
   fan-out. We picked DOs over polling and over a third-party
   (Liveblocks/PartyKit) because Phase 1 will be dogfooded with real
   Quality data and a polling-based UI would be unusable under live
   edits, and because we'd rather absorb the DO learning curve once
   than rip out a polling layer later. *Implication:* adds a new
   deploy surface in Phase 1 (DO binding, migrations, observability)
   and is the main reason Phase 1's estimate moved from ~2 weeks to
   ~3 weeks.
2. **Formula engine: custom evaluator with a fixed function list.**
   We roll a small expression evaluator with a curated set: SUM, IF,
   CONCAT, AND, OR, NOT, basic date math, basic arithmetic. No
   user-defined functions, no HyperFormula, no FormulaJS. We picked
   this over embedding a library because Smartsheet-grade formula
   depth is not the differentiator, and a finite hand-written
   evaluator gives us a smaller bundle, no license surface, and no
   sandboxing burden. *Implication:* formulas land in Phase 2 with a
   known-bounded function list; "user wants VLOOKUP" is an explicit
   non-goal we can answer cleanly.
3. **Public form abuse protection: Cloudflare Turnstile + tight rate
   limits.** Every public-link form gets Turnstile (invisible
   CAPTCHA) as the primary defense, plus per-IP per-form rate limits
   layered through the existing D1 `ratelimit.ts`. We picked
   Turnstile-first over rate-limit-only because a determined abuser
   burns through pure rate limits, and over auth-only because we
   still want truly public forms (mobile QC capture from the floor)
   to be one tap away. *Implication:* Turnstile binding lands in
   Phase 1 alongside DOs; Phase 2 form builder consumes it.
4. **Phase 1 dogfooding is a hard gate.** The author migrates real
   Quality intake work into Phase 1 before any Phase 2 work begins.
   We picked this over a "build all phases then evaluate" path
   because the riskiest unknown is whether our row/column/attachment
   primitives match how Quality work actually flows; better to find
   out on real data with one user than to find out after we've built
   forms and workflows on a broken foundation. *Implication:* Phase
   2 has a real-world dependency, not just an engineering one — see
   the Phase 1 → Phase 2 gate above.

#### Open questions

These are real architectural forks we have not decided. Each has
downstream consequences and should be resolved before the relevant
phase, not at coding time.

1. **Column-schema migration.** When a user changes a column's
   `type` (e.g. text → number), what happens to existing values?
   Options: hard-fail if any value can't coerce; soft-coerce with
   a preview; archive-the-old-column-and-create-a-new-one
   (Airtable's approach). The third is least destructive but adds
   cruft. Lean toward soft-coerce + preview.
2. **Row-event ordering and idempotency for automations.** If a
   row update fires an automation that updates the row, do we
   re-fire? Loop detection? Smartsheet draws this line at "no
   re-fire within the same change set." We probably do the same.
   Decide before Phase 3.
3. **Search backend.** D1 `LIKE` scan on `data` JSON works for v1
   at low volume. For tenants with 100k+ rows we'll need either a
   D1-side FTS5 virtual table per sheet (one table per sheet does
   not scale) or push records into the existing content index used
   by document search. Defer until tenant load forces it.
4. **Workflow visualization library.** ReactFlow is the obvious
   pick (MIT, mature, handles auto-layout). It adds ~120kB
   gzipped — non-trivial. Worth it; alternative is hand-rolled SVG
   which we will regret.
5. **Public form auth model.** Pure public is easy but invites spam
   and compliance worries (a manufacturer's QC form gets indexed
   by Google). Email-verified (one-time link) is friction.
   Tenant-user is trivial. Probably ship all four `auth_mode`
   options and let the tenant pick per-form, with per-tenant
   defaults. (Turnstile + rate limits handle the abuse vector
   independent of this choice.)

#### Out of scope (for now)

Calling these out explicitly so v1 stays shippable.

- **External integrations** — no Slack, Jira, MS Teams, Google
  Sheets, Salesforce. Webhooks-out is the v2 path; for v1, the only
  outbound channel is email via Resend.
- **Deep BI / dashboarding** — the trending report in Phase 4 is a
  fixed pivot, not a chart builder. No cross-sheet dashboards, no
  saved chart library.
- **Per-cell or per-row permissions** — sheet-level only.
- **Cell-level real-time CRDT editing** (Google Docs style). We
  ship optimistic single-writer-wins with conflict toasts.
- **Mobile native app** — mobile web only. The form player is
  designed for mobile web; no React Native build.
- **Custom theming per tenant** — single dox brand for v1.
  Tenant logo on public forms, nothing else.
- **Import from Excel / CSV beyond a simple paste-grid feature.**
  No format detection, no formula translation, no Excel-file round
  trip.
- **AI features** (auto-suggest column types, auto-generate
  workflows from prompts). The dox extraction stack is the AI
  story; Records v1 is human-driven.
- **Versioning of rows.** Activity feed shows what changed; you
  cannot "restore row to last week's state." If we need that we
  add it later by replaying activity.
