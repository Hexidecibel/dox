# Connector intake — staging walkthrough

This doc validates the entire connector intake module on staging. Run each
scenario fresh, mark success/failure as you go in the **Sign-off** section
at the bottom. If any scenario fails, capture the run id, screenshot the
error, and ping the dev team.

## Setup

- **Staging URL:** <https://doc-upload-site-staging.pages.dev>
- **Login:** `a@a.a` / `a` (super_admin in tenant `default`)
- **Sample CSV:** `tests/e2e/fixtures/connector-orders.csv` in the repo
  (8 rows, 5 distinct customers, fields:
  `order_number,po_number,customer_name,customer_number,product_code,product_name,lot_number,quantity`).
  Save it to your desktop before you start.
- **Tools you'll need:**
  - A web browser (Chrome / Firefox / Safari).
  - A terminal with `curl` (Scenarios 2 and 4).

Each scenario takes 3-5 minutes. Total walkthrough: **about 25 minutes**.

If something looks off and you want to bail, the connector you created in
each scenario can be deleted from `/admin/connectors` (gear icon → Delete).
Deleting a connector soft-deletes any orders it owned.

---

## Scenario 1 — Set up a connector + manual upload

This is the happy path: create a connector through the wizard, then drop
a file into the manual upload zone on its detail page.

1. Sign in at <https://doc-upload-site-staging.pages.dev/login> with
   `a@a.a` / `a`.
2. From the left nav, click **Admin → Connectors**.
3. Click the **+ New connector** button (top right).
4. **Wizard step 1 — Name & Type:**
   - Name: `Acme Manual Test`
   - Slug: should auto-fill to `acme-manual-test`.
   - Click **Next**.
5. **Wizard step 2 — Upload Sample:**
   - Drag the sample CSV (`connector-orders.csv`) into the upload zone,
     or click and pick it.
   - The wizard will show "Schema discovered: 8 fields detected".
   - Click **Next**.
6. **Wizard step 3 — Field Mappings:**
   - The wizard pre-fills mappings for `order_number`, `po_number`,
     `customer_name`, `customer_number` (the four core fields).
   - **Verify:** all four show as enabled with the correct source
     column highlighted.
   - Click **Next**.
7. **Wizard step 4 — Live Preview:**
   - The preview pane shows the first 3 rows of the CSV with mappings
     applied.
   - **Verify:** values look right (e.g. `Doorway Foods` under
     `customer_name`).
   - Click **Next**.
8. **Wizard step 5 — Review & Activate:**
   - Toggle **Active** on (default).
   - Click **Save & Activate**.
9. After save, you land on the connector detail page at
   `/admin/connectors/<slug>`. **Verify:**
   - **HelpWell** banner at the top with the "Connectors" headline +
     explanation. (If dismissed previously, it stays dismissed —
     that's fine.)
   - **Manual upload** card visible at the top of the page with the
     dashed drop zone reading "Drop a CSV, TSV, XLSX, or PDF here…".
   - **API drop** card showing a bearer token (64 hex chars) and a
     copyable curl example.
   - **S3 drop** card showing a "Set up S3 drop" button (lazy
     provisioning — the bucket only mints when asked).
   - **Public link** card showing a "Generate link" button.
   - **Email** card with a receive address ending in `@supdox.com`
     and a staging notice ("staging email-worker isn't DNS-bound,
     test by sending to prod").
10. Drag the same CSV into the manual upload zone (top of the page).
11. After 1-3 seconds, **Verify:**
    - A new row appears in the **Runs** table below with
      `status=success`, `source=manual`, `Found=13` (8 orders + 5
      customers), `Errors=0`.
    - The row shows a "View 8 orders" link.
12. Click "View 8 orders". **Verify:**
    - You land on `/admin/orders?connector_id=<id>`.
    - The orders table lists 8 rows with order numbers
      `ORD-DOOR-001` through `ORD-DOOR-008`, customer names from
      the CSV, and the connector name `Acme Manual Test` in the
      **Source** column.

**Success criteria:** the connector wizard completes without errors,
the detail page shows all five intake doors, the manual upload run
succeeds, and 8 orders are visible filtered by this connector.

---

## Scenario 2 — HTTP API door

Confirm a vendor's curl-equivalent script can drop a file via the API
bearer token. Reuses the connector created in Scenario 1.

1. From the connector detail page, find the **API drop** card.
2. Click the **Copy** button next to the bearer token. (You can also
   re-read it any time via `GET /api/connectors/<id>` — it's
   plaintext at rest by design.)
3. Open a terminal and run (replace `<TOKEN>` with the copied token,
   `<SLUG>` with `acme-manual-test`):
   ```bash
   curl -i -X POST \
     "https://doc-upload-site-staging.pages.dev/api/connectors/<SLUG>/drop" \
     -H "Authorization: Bearer <TOKEN>" \
     -F "file=@connector-orders.csv"
   ```
4. **Verify:** the response is `HTTP/2 200` with a JSON body
   containing `run_id`, `status: "success"`, `orders_created`, and
   `customers_created`.
5. **Verify** in the response body that `errors` is an empty array
   (or absent).
6. Refresh the connector detail page in the browser.
7. **Verify** in the **Runs** table that the new run appears with
   `status=success` and `source=api` (a small "API" pill on the
   row).
8. Negative test — try the same curl with a bad token:
   ```bash
   curl -i -X POST \
     "https://doc-upload-site-staging.pages.dev/api/connectors/<SLUG>/drop" \
     -H "Authorization: Bearer not-a-real-token-zzzzzzzzz" \
     -F "file=@connector-orders.csv"
   ```
9. **Verify** the response is `HTTP/2 401` with body
   `{"error":"Invalid bearer token"}`. (The error message is the
   same regardless of why auth failed — the connector existence is
   not probable.)
10. Click the **Rotate API token** button on the API drop card.
11. **Verify** a confirmation dialog appears warning that the old
    token will stop working immediately. Confirm.
12. **Verify** the new token is shown once (copy it), and that
    re-running the curl from step 3 with the OLD token now returns
    `401`, while a curl with the NEW token still returns `200`.

**Success criteria:** valid token → 200 + run row tagged `source=api`,
bad token → 401, rotate works and the old token immediately stops
authenticating.

---

## Scenario 3 — S3 bucket door

Lazy-provision the connector's per-bucket S3 endpoint, then write a file
to it via the AWS S3 protocol.

> **Note:** this scenario provisions a real R2 bucket against the
> staging Cloudflare account. Each run leaves an empty bucket behind;
> if you run the walkthrough back-to-back, ask the dev team to clean
> up the staging buckets named `connector-acme-manual-test` between
> runs. (We may automate this in a future cycle.)

1. From the connector detail page (still using the Scenario 1
   connector), find the **S3 drop** card.
2. Click **Set up S3 drop**.
3. **Verify** a panel appears showing:
   - `bucket_name` (e.g. `connector-acme-manual-test`)
   - `access_key_id`
   - `secret_access_key` (shown ONCE — copy now)
   - `endpoint` (e.g. `https://<account-id>.r2.cloudflarestorage.com`)
   - A copyable AWS CLI snippet.
4. In a terminal, run the snippet (or write your own using the
   shown credentials):
   ```bash
   aws s3 cp connector-orders.csv \
     s3://<BUCKET_NAME>/orders-$(date +%s).csv \
     --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   ```
5. **Verify** the upload completes without error.
6. Wait up to 5 minutes — the staging poller runs every 5 minutes on
   cron from the `dox-connector-poller` Worker. If you don't want
   to wait, ask the dev team to trigger
   `POST /api/connectors/poll` manually with the
   `CONNECTOR_POLL_TOKEN`.
7. Refresh the connector detail page.
8. **Verify** a new row appears in the **Runs** table with
   `status=success` and `source=s3` pill.
9. Click "View N orders" on the new run row to confirm the orders
   landed (should match the row count in your file — 8 if you used
   the canonical fixture).

**Success criteria:** S3 provisioning yields working credentials, S3
PUT succeeds, the next poll cycle picks up the file and produces a
success run with `source=s3`.

---

## Scenario 4 — Public link door

Generate a public drop link the partner can hand to a vendor over
email. The link is a single bearer token with optional expiry. Reuses
the Scenario 1 connector.

1. From the connector detail page, find the **Public link** card.
2. Click **Generate link**.
3. **Verify** a dialog appears asking for an expiry. Accept the
   default (30 days) and click **Generate**.
4. **Verify** the dialog shows:
   - A copyable URL of the form
     `https://doc-upload-site-staging.pages.dev/drop/<slug>/<token>`.
   - The 64-char hex token.
   - An expiry date roughly 30 days from now.
5. Copy the URL.
6. Open the URL in an **incognito browser tab** (so the admin
   session doesn't interfere).
7. **Verify** a public-facing drop form renders with a file picker
   and the connector's name. No login prompt.
8. Pick `connector-orders.csv` and click **Submit**.
9. **Verify** the form shows a success message with a run id.
10. Switch back to the admin tab, refresh the connector detail page.
11. **Verify** a new run appears with `status=success` and a
    `source=public_link` pill.
12. Test expiry: click **Rotate link** on the public-link card.
13. **Verify** the old URL (the one you used in step 7) now returns
    `401 Invalid bearer token`. The new URL works.

**Success criteria:** link generates, public form accepts a file
without login, run lands tagged `source=public_link`, rotation
invalidates the old URL.

---

## Scenario 5 — Self-doc and tooltips

Walk through the documentation surfaces a partner would actually
read.

1. From any connector detail page, hover over the small **(?)** icon
   next to "Manual upload".
   - **Verify:** a tooltip appears explaining what the manual upload
     door is for. Text should be helpful, not stale (no references to
     pre-Phase-B0 connector types like "api_poll" or "webhook_pull").
2. Repeat the hover for the (?) on **API drop**, **S3 drop**,
   **Public link**, and **Email**.
   - **Verify:** each tooltip describes its door specifically and
     is internally consistent with the card's copy.
3. Navigate to <https://doc-upload-site-staging.pages.dev/help/connectors>
   (admin-only, requires login).
   - **Verify:** long-form docs render with sections covering each
     of the five doors and the field-mapping flow.
   - **Verify:** no broken images, no Lorem ipsum, no
     "TODO"/"FIXME" notes leaking through.
4. Open a **new incognito window** (no auth) and visit
   <https://doc-upload-site-staging.pages.dev/docs/connectors>.
   - **Verify:** vendor-facing docs page renders without requiring
     login.
   - **Verify:** all five doors are documented in plain language
     with copy-paste-able curl / aws-cli examples.
   - **Verify:** the "What is a connector?" lead paragraph reads
     well to someone with no prior context.
5. Back in the admin tab, navigate to `/admin/connectors`.
6. If the **HelpWell** banner is visible at the top, click the
   **dismiss** (×) button.
7. Refresh the page (full reload — `Cmd+R` / `Ctrl+R`).
   - **Verify:** the HelpWell stays dismissed across reloads
     (persisted to local storage).
8. Spot-check 3 other modules' help pages:
   - `/help/orders`
   - `/help/customers`
   - `/help/documents`
   - **Verify:** each renders with substantive content (not a
     placeholder), and the headline matches the module.

**Success criteria:** every tooltip is accurate, the long-form
help and public docs both render and read like real docs (not
filler), the HelpWell dismissal persists, and the spot-checked
modules have real content.

---

## Sign-off

Walked through by: ______________________

Date: ______________________

| # | Scenario                                | Result (✓ / ✗) | Notes |
|---|-----------------------------------------|----------------|-------|
| 1 | Manual upload + UI walk                 |                |       |
| 2 | HTTP API door                           |                |       |
| 3 | S3 bucket door                          |                |       |
| 4 | Public link door                        |                |       |
| 5 | Self-doc and tooltips                   |                |       |

**Overall verdict** (circle one): **PASS** / **PASS WITH CAVEATS** / **FAIL**

If FAIL or PASS WITH CAVEATS, list blocking issues:

1. ______________________________________________________________
2. ______________________________________________________________
3. ______________________________________________________________

After sign-off, drop this doc in the team channel as a screenshot or
PDF. Connector intake is cleared for prod once this is signed off.
