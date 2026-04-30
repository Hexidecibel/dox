# Connector intake walkthrough audit — 2026-04-29

Phase A1 punch list. Hybrid audit — `curl` against
`https://doc-upload-site-staging.pages.dev` for every API path, source review
for every UI path. Every issue notes the file/component where the fix lands.

Scope: **manual upload (file_watch)** and **email** connectors.
Out of scope per Phase B plan: the new R2-prefix poller, HTTP POST API,
S3 bucket drop, public drop link.

Test data used: 5-row `orders.csv` with columns
`order_number,customer_number,customer_name,po_number,product_code,product_name,quantity,lot_number`.
Verified two real runs on staging (one `file_watch` manual upload, one
`connector-email-ingest` webhook simulation). Both produced
`status=success` and persisted orders + customers in the staging D1.

---

## Manual upload (file_watch)

### Connector creation

- [ ] (severity: medium) Wizard's `StepConnectionConfig` shows an "R2 prefix"
  text field and a Schedule picker for `file_watch` even though the manual
  upload + the new poller (Phase 2 / migration 0046) are the only two
  delivery mechanisms — there is no per-connector cron and the prefix is
  optional. Either drop these fields entirely or relabel them
  ("Where unattended uploads should land — optional"). — `src/components/connectors/StepConnectionConfig.tsx:470-515`
- [ ] (severity: medium) The wizard's final step "Review & Activate" copy for
  file_watch (`FileWatchTestSection`) tells the user to "run POST
  /api/connectors/:id/run (or use the Run button on the detail page) to
  push a fresh file" — but there is no Run button on the detail page for
  `file_watch` (header omits it intentionally; the drop zone is the only
  affordance). Update the copy to point at the drop zone instead. — `src/components/connectors/StepTestAndActivate.tsx:266-280`
- [ ] (severity: medium) After Save & Activate the user is dropped onto the
  detail page with no celebratory "wizard finished — drop a file here"
  callout. Plan A3's exact ask. The drop zone exists but is the same card
  that shows on every visit, so a first-timer scrolling past field
  mappings can miss it. — `src/pages/admin/ConnectorWizard.tsx:425` (post-save nav) + `src/pages/admin/ConnectorDetail.tsx:674-771` (where the callout would sit)
- [ ] (severity: low) Wizard "System type" (ERP/WMS/Other) is a required radio
  but never explained — the partner has to guess what difference it makes.
  Add a one-line caption ("Used for filtering connectors and reports
  later"). — `src/pages/admin/ConnectorWizard.tsx:599-610`
- [ ] (severity: low) `Connectors.tsx` (list view) ignores the wizard route
  for the legacy `Edit` icon — clicking the pencil opens the old "raw JSON
  config" `Dialog` instead of the wizard or the new ConnectorDetail page.
  Either remove the old dialog or wire the icon to navigate to
  `/admin/connectors/:id`. The dialog also lets a user paste arbitrary JSON
  config that bypasses the wizard's email + field-mapping validation. — `src/pages/admin/Connectors.tsx:162-214,422-503`
- [ ] (severity: low) Wizard `StepNameAndType` shows just `file_watch` and
  `email` as cards — `api_poll` and `webhook` are intentionally hidden.
  Existing `webhook` connectors persist (one is in staging right now —
  `smoke-webhook`) but cannot be re-edited via the wizard since the type
  card is missing. Add a code path that surfaces an "edit unsupported
  legacy type" notice instead of silently restricting the choice. — `src/pages/admin/ConnectorWizard.tsx:90-112,612-672`

### Sending a file

- [ ] (severity: high) The drop zone validates against a HARD-CODED list of
  extensions (`.csv .tsv .txt .xlsx .xls .pdf`) inside `ConnectorDetail.tsx`,
  duplicating the server-side `classifyFile()` in `run.ts`. The two are in
  sync today by hand — but if either drifts, the UI silently rejects (or
  silently sends and 400s) without a clear message. Centralize the list in
  `shared/types.ts` (or a new `shared/connectors.ts`) so both ends import
  it. — `src/pages/admin/ConnectorDetail.tsx:342-355` + `functions/api/connectors/[id]/run.ts:27-54`
- [ ] (severity: high) On run failure the runs table shows
  `status=error` and `errors=1` in red, but the per-run `error_message`
  (which the API returns and is the actual reason it failed — e.g.
  `"CSV has no data rows"` or `"Missing order number"`) is **never
  displayed in the UI**. The user has to crack open the network panel.
  Add a row-expander, a tooltip on the Errors cell, or a popover. — `src/pages/admin/ConnectorDetail.tsx:937-994` (interface + render around 110)
- [ ] (severity: medium) `records_found` reports `orders + customers` (8 for
  my 5-row CSV with 3 distinct customers), not "rows in your file" — the
  partner's mental model is rows. The runs table column heading is
  `Found`, which compounds the confusion. Either rename the column to
  `Records` (matches DB) or add a tooltip that explains the math. — `src/pages/admin/ConnectorDetail.tsx:949-960` + `functions/lib/connectors/orchestrator.ts:262`
- [ ] (severity: medium) When the user uploads a CSV whose headers don't
  match any configured mapping, the run errors out per-row with
  `"Missing order number"` — the actual root cause is "your CSV columns
  don't match what this connector expects to see." Surface a clearer
  "headers detected: X, Y, Z; expected at least: order_number" diagnostic
  on the run row, or do a pre-flight check in the file_watch executor. — `functions/lib/connectors/email.ts:567-573` (parseCSVAttachment used by file_watch too)
- [ ] (severity: medium) The drop zone's "expected fields" preview lists
  ENABLED core mappings (`Order Number, Customer Number...`) but does NOT
  list which CSV column-headers it'll match on (the actual `source_labels`).
  A user who configures the connector by typing a header alias of "ORD #"
  and then uploads a CSV with "Order Number" gets a silent miss until they
  open the field mapping editor. Show the source labels too, or a small
  "expected headers: ..." summary. — `src/pages/admin/ConnectorDetail.tsx:684-709`
- [ ] (severity: low) The drop zone doesn't show progress for slow uploads —
  on a 10MB XLSX over flaky wifi the only feedback is "Running…" with an
  indeterminate spinner. Could read the file in a stream + show bytes
  uploaded. Low-priority — current upload limits are conservative enough
  that this is rare. — `src/pages/admin/ConnectorDetail.tsx:357-381`
- [ ] (severity: low) After a successful run the page scrolls smoothly to
  the runs panel (line 373-375), but the new run row isn't visually
  highlighted — the user has to look at timestamps to identify it. Could
  flash a row background or add a "Just now" pseudo-chip. — `src/pages/admin/ConnectorDetail.tsx:357-381`

### Result visibility

- [ ] (severity: high) Run rows do NOT link to the orders/customers they
  created. The user has to remember to navigate to `/orders` and
  filter by `connector_id` (or `connector_name`) manually. Add a
  drill-down (e.g. clicking a run row goes to
  `/orders?connector_run_id=...` filter). — `src/pages/admin/ConnectorDetail.tsx:937-994` + `src/pages/Orders.tsx`
- [ ] (severity: medium) Orders list page shows `connector_name` chip
  (good) but no filter to show only orders from a particular run.
  `connector_run_id` is stored on the orders table and returned by
  the API — wire a `?connector_run_id=X` filter. — `src/pages/Orders.tsx:65,262-263,309-310` + `functions/api/orders/index.ts`
- [ ] (severity: medium) "Last run: just now" on the header card is the
  ONLY indication a run happened — the user is expected to scroll to
  the bottom for the runs table. A "Recent activity" mini-widget at
  the top would solve this. — `src/pages/admin/ConnectorDetail.tsx:574-577,937-994`
- [ ] (severity: low) The `ProbeDetails` block (from clicking Test) has
  great per-type details but doesn't persist — refresh the page and
  it's gone. Either store last-probe-result on the connector or
  surface it as a small chip ("last test: 2m ago, OK"). — `src/pages/admin/ConnectorDetail.tsx:1441-1471`

---

## Email

### Connector creation

- [ ] (severity: high) `email-worker/wrangler.toml` hardcodes
  `EMAIL_DOMAIN = "supdox.com"` and `DOX_API_BASE = "https://supdox.com"`,
  meaning **staging cannot receive real inbound email at all**. The
  staging connector wizard happily generates `slug@supdox.com` as the
  receive address (which would be misrouted to prod). For Phase A audit
  this means the email path is **only verifiable on staging via
  `/api/webhooks/connector-email-ingest` curls** — not an actual email
  send. Plan should call out either standing up a `staging-email-worker`
  on a `staging.supdox.com` subdomain OR documenting that staging tests
  always use the webhook simulator. — `email-worker/wrangler.toml`
- [ ] (severity: high) The email-connector probe message is **misleading**.
  When `email_domain_mappings` is empty for the tenant the probe says
  *"Emails to {slug}@supdox.com will be rejected until a sender-domain
  row is added"* — but the actual connector email path
  (`/api/webhooks/connector-email-ingest` -> orchestrator) NEVER reads
  `email_domain_mappings`. Only the legacy smart-upload
  `/api/webhooks/email-ingest` does. Verified by curling the connector
  webhook on staging with no mappings — it ran fine and parsed orders.
  Either fix the probe to drop the email_domain_mappings check, or fix
  the dispatch path to honor it (preferred). — `functions/api/connectors/[id]/test.ts:153-232` + `functions/api/webhooks/connector-email-ingest.ts:31-77`
- [ ] (severity: high) There is **no UI to manage `email_domain_mappings`**.
  Migrations 0015/0017/0020 have wrestled this table back and forth, and
  the probe's recommended remediation (add a row) has no admin surface.
  This compounds the misleading-probe issue above. — `functions/api/email-domain-mappings/` (does not exist)
- [ ] (severity: medium) Email connector wizard requires uploading a
  CSV/PDF/XLSX **sample** to seed field mappings. Reasonable for the
  CSV-attachment case, but emails routinely contain ONLY a body or HTML
  table (no attachment), and there's no way to tell the wizard "this
  connector parses bodies, not attachments." Surface a "skip sample,
  parse body via AI" path, or default to a body-AI mapping. — `src/pages/admin/ConnectorWizard.tsx:486-491` + `functions/lib/connectors/email.ts:60-70`
- [ ] (severity: medium) Wizard `StepConnectionConfig.EmailConfig` calls the
  field "Subject keywords" with helper "Enter words that appear in the
  email subject," but the actual server-side matcher
  (`subjectMatches`) treats each entry as a **case-insensitive regex**.
  Users who paste subjects with regex meta-chars (`.`, `?`, `(`, `)`)
  get unexpected matching. ConnectorDetail's edit panel correctly says
  "Each chip is a regex" — keep them in sync. — `src/components/connectors/StepConnectionConfig.tsx:188-247` vs `src/pages/admin/ConnectorDetail.tsx:1217-1225`
- [ ] (severity: low) `EmailConfig`'s "Subject keywords" `ChipInput` only
  commits on Enter. Pasting a comma-separated list (which the
  `ConnectorDetail` page handles via `addPatternsFromInput`) does not
  work in the wizard. Reuse the same logic. — `src/components/connectors/StepConnectionConfig.tsx:57-104`
- [ ] (severity: low) The wizard's "Receive address" is not surfaced in
  the email Connection step at all — it shows only on `ConnectorDetail`
  after save. New users never see the address until they finish the
  whole wizard. Move it (or copy it) into `EmailConfig`. — `src/components/connectors/StepConnectionConfig.tsx:188-247`

### Sending a file

- [ ] (severity: high) The "How to send a test email via webhook"
  accordion on `ConnectorDetail` has a `curl` example that posts to
  `https://dox.supdox.com/api/webhooks/connector-email-ingest` — but
  staging is `doc-upload-site-staging.pages.dev` and the prod custom
  domain is `https://supdox.com` (not `dox.supdox.com`, which used to
  be the legacy alias). Derive the URL from `window.location.origin`
  or pull from `tenant`/env config. — `src/pages/admin/ConnectorDetail.tsx:1132-1146`
- [ ] (severity: high) The webhook `curl` example tells the user to
  set `X-API-Key: $EMAIL_INGEST_API_KEY` — but that secret is the
  `email-worker`'s service token, NOT something the user owns or can
  generate. A partner copy-pasting the curl will get a 401. The accordion
  needs to either: (a) gate visibility to super_admins with a
  rotate-secret button, OR (b) be replaced by the Phase B `/drop`
  endpoint with per-connector bearer tokens (which is the plan). — `src/pages/admin/ConnectorDetail.tsx:1286-1320`
- [ ] (severity: medium) Email-connector "send a test email" affordance
  on ConnectorDetail has the `curl` accordion but NO "send me a test
  email" button — partners are expected to fire up Mailgun/Resend
  themselves. Plan A2 explicitly calls for "test by emailing yourself"
  hint. Could add a `Send test email` button that uses Resend to push a
  pre-canned email through the worker -> webhook chain. — `src/pages/admin/ConnectorDetail.tsx:1286-1320`
- [ ] (severity: medium) Empty-attachment emails are silently dropped by
  `email-worker` (sends a "no documents found" reply). For connector
  routes that should accept body-only emails, this means the partner
  sends the email, gets a "no documents found" bounce, and assumes
  the connector is broken — when actually the body parser would have
  worked. The worker filters attachments BEFORE the connector match
  in some paths and AFTER in others — audit the order. — `email-worker/src/index.ts:181-200` (no-attachment branch runs after connector match logic at 92-179, looks ok, but worth verifying)
- [ ] (severity: low) `connector-email-ingest` webhook returns
  `{success: true, run_id, status, orders_created, customers_created}` —
  if you pass an unknown connector_id you get 404, but if you pass a
  VALID connector_id with `connector_type != 'email'` you get a 400
  "Connector is not an email type" — the Mailgun webhook caller (the
  email-worker) treats any non-2xx as "ingest failed" and emails the
  sender that processing failed, even though the email was actually
  routed to the wrong connector via match-email. Tighten the worker
  logic. — `functions/api/webhooks/connector-email-ingest.ts:64-66` + `email-worker/src/index.ts:152-171`

### Result visibility

- [ ] (severity: medium) Same drill-down gaps as file_watch — runs
  panel doesn't link to created orders, no filter by run_id on the
  orders page. (See the file_watch "Result visibility" items —
  identical here.)
- [ ] (severity: medium) The summary email `email-worker` sends back
  to the sender ("Report Processed — {tenant}: N orders / N customers
  created") is plain-text and lacks a link to the connector's runs
  panel. Partners can't click through to see what happened. Add a
  link like `https://supdox.com/admin/connectors/{id}` (super_admin
  link, not for vendor delivery). — `email-worker/src/index.ts:159-163`
- [ ] (severity: medium) `connector-email-ingest` writes
  `'connector.email_ingest'` to the audit log on success but does NOT
  write a failure audit row when the connector is not found / not
  active / wrong type — those return 4xx without any DB trace. Hard to
  triage "where did my email go?" later. — `functions/api/webhooks/connector-email-ingest.ts:56-77,131-148`

---

## Cross-cutting observations

- [ ] (severity: high) **The legacy `Connectors.tsx` Add/Edit JSON dialog
  is a footgun.** The wizard has all the validations (email scoping,
  field-mapping shape, type coercion) but the legacy edit Dialog accepts
  arbitrary JSON `config` and writes it directly. A user who hits the
  pencil icon on the list view gets the legacy dialog, NOT the wizard.
  Either remove the dialog entirely or wire the icon to
  `navigate('/admin/connectors/:id/edit')`. — `src/pages/admin/Connectors.tsx:162-214,392-401,422-503`
- [ ] (severity: medium) **No "Recent runs across all connectors"
  view.** The owner has to drill into each connector to see recent
  activity. A `/admin/connectors/runs` global feed (or even a dashboard
  card with last 24h totals) would close the "did anything happen
  today" feedback loop. — would land at `src/pages/admin/Connectors.tsx` + new endpoint
- [ ] (severity: medium) **Audit log coverage is uneven.** `connector.run`
  is written by the orchestrator on every dispatch; `connector.email_ingest`
  by the webhook on success; manual `/run` writes neither (the
  orchestrator does, but the run.ts handler does not add its own user-driven
  audit row). Plan B5 explicitly calls for `connector.intake` audit
  uniformly — note this gap so it's part of the lift. — `functions/api/connectors/[id]/run.ts:56-185`
- [ ] (severity: medium) **No rate limiting on intake paths.** A vendor
  with a runaway script could fire `connector-email-ingest` hundreds of
  times a minute. Plan B5 covers this — flagging as a known gap so it
  doesn't slip. — `functions/api/webhooks/connector-email-ingest.ts:31-164`, `functions/api/connectors/[id]/run.ts:56-232`
- [ ] (severity: low) Tenant slug + receive-address derivation is done
  in two places (`ReceiveInfoCard` line 1123, probe `probeEmail` line
  186) and in the email-worker. Any future "@vendor.subdox.com"
  multi-domain support needs to touch all three. Consolidate. — `src/pages/admin/ConnectorDetail.tsx:1123` + `functions/api/connectors/[id]/test.ts:179-186` + `email-worker/src/index.ts:53-82,272-278`
- [ ] (severity: low) The `Test` probe button on ConnectorDetail
  succeeds visually (probe block appears) but on tab-away + tab-back
  the result vanishes (in-component state, not persisted). Easy fix:
  store last-probe in connector row or local-storage. — `src/pages/admin/ConnectorDetail.tsx:294-337`
- [ ] (severity: low) `npx wrangler r2 object put` examples in
  `next-time.md` reference `--local`, but the new poller path requires
  staging/prod R2 to test the actual ingest flow. A staging-friendly
  upload helper script (`bin/upload-r2-sample`) would close the gap.
  Out of scope for A1 fixes but worth a `todo.md` line. — would land at `bin/`
- [ ] (severity: low) The connector list page has no "filter by
  connector_type" UI even though the API supports `?connector_type=`.
  With three+ active types and growing, this becomes a usability cost. — `src/pages/admin/Connectors.tsx:108-160`

---

## Severity legend

- **high** — broken or actively misleading; user/partner gets stuck
- **medium** — usable but rough; partner pauses to figure it out
- **low** — polish; not blocking

---

## What I couldn't verify directly

- **Drag-drop UX from a real browser.** Reviewed the React component
  (`ConnectorDetail.tsx:684-769`) — drop styling, focus ring, and
  hidden-file-input click are all present and look correct. Couldn't
  confirm the drag-active styling actually flips, the focus-visible
  outline shows, or the snackbar appears in real time.
- **Real inbound email** (Mailgun/CF Email Routing -> email-worker
  -> connector). Staging email-worker doesn't exist — verified the
  whole CSV-attachment path via direct webhook curl
  (`/api/webhooks/connector-email-ingest`), which IS what the email
  worker eventually calls. PostalMime parsing + connector matching at
  the worker layer was code-reviewed only.
- **The Cloudflare Email Routing** rule that catches `*@supdox.com`
  and forwards to `dox-email-worker`. Pure infra — needs Cloudflare
  dashboard access.
- **PDF / XLSX attachment ingestion** end-to-end. Code path exists in
  `functions/lib/connectors/email.ts` (`parsePDFAttachment`,
  `parseXLSXAttachment`) and gets to `parseWithAI` which calls Qwen.
  Didn't fire a real PDF through. CSV path is the verified happy path.

---

## Live verification artifacts (staging, ALL CLEANED UP)

- Created `Audit Acme Orders 1777518556` (file_watch) -> ran
  `orders.csv` -> 5 orders + 3 customers persisted -> deleted.
- Created `Audit Email Acme` (email) -> simulated webhook with same
  CSV via `/api/webhooks/connector-email-ingest` -> 0 NEW orders
  (correctly upserted onto the existing rows from the file_watch run)
  -> deleted both connector + the 5 orders.
- Both runs returned `status=success` and persisted the expected
  rows. The intake mechanics work; the issues above are all UX,
  discoverability, error-display, and rough-edge gaps — not broken
  ingestion.
