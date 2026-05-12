# Demo prep — tonight (2026-04-30)

## Setup (do once before the demo)

- [ ] Sign in at https://doc-upload-site-staging.pages.dev as `a@a.a` / `a`
- [ ] Have `tests/e2e/fixtures/connector-orders.csv` on the desktop
- [ ] Terminal open with `curl`
- [ ] **Pre-configure Kanban on Quality Intake** — group by Status (Open / Investigating / Awaiting supplier / Resolved / Closed). ~5 min, pays for itself.
- [ ] **Verify Incoming Orders Kanban** column order is Pending → Matched → Blocked → Shipped. If wrong, drag once — it persists.
- [ ] **Test the cross-sheet click** on ORD-0430 → `source_incident` → Quality Intake mold row. Confirm it jumps before going live.
- [ ] Phone silenced, second monitor / tabs ready

## Demo arc — Connectors

1. **Create a connector via the wizard.** Admin → Connectors → +New connector. Walk through the 5 wizard steps. Pause on **step 4 (Live Preview)** so they see schema auto-discovery + field mappings working on real data.
2. **Drop the same CSV into the manual zone** on the connector detail page. Within ~2s a Run row appears. Click "View N orders" — orders show up tagged with the connector as Source. *This is the "it just works" moment.*
3. **Show the five doors.** Point at each card briefly:
   - Manual upload (just used)
   - API drop (bearer token + curl snippet)
   - S3 drop (lazy-provisioned bucket)
   - Public link (token URL for vendors)
   - Email (`@supdox.com` address)
4. **Live curl against the API door.** Copy the bearer, run the curl from the card, refresh the page, new run appears tagged `source=api`. Vendor-script story in 30 seconds.
5. **Generate a public link.** Click Generate, copy URL, open in incognito, drop a file, switch back, new run tagged `source=public_link`. The "email this to a vendor" story.
6. **Field mapping flexibility.** If a real customer file has odd column names, re-run the wizard or edit mappings to show how the system adapts without code changes.

**Skip live unless asked:**
- **S3 door** — works but the poller cron is 5min. Only show if you can pre-stage a file or trigger the poller manually.
- **Email door** — staging worker isn't DNS-bound; the card itself says "test by sending to prod."
- **Token rotation / 401 negative tests** — sign-off material, not demo material.

**Closing flourishes if there's time:**
- `/help/connectors` (admin) and `/docs/connectors` (public, no login) — vendor-facing docs already shipped.
- HelpWell banner at the top of the connectors page — in-app guidance for new users.

## Demo arc — Records (90s)

> Setup line: "Our partners are food manufacturers tracking supplier quality. Today they live in Smartsheet — we built the same thing tied to the document library."

1. **Open Quality Intake (Grid).** Scroll, point at the **Critical mold incident at Met Market** (the open one). "This came in from a retail customer."
2. **Switch to Kanban.** "Same data, different angle. Here's what's in flight, what's waiting on the supplier, what's resolved." Drag a card to show real-time persistence.
3. **Click into a card → row drawer.** Show the activity feed: "Status changed from Open to Investigating by partner on Apr 11."
4. **Jump to Quality Credit Tracker.** "When an incident leads to a chargeback, we track the dollar amount and link straight back to the source incident." Click the linked record → cross-sheet jump.
5. **Switch to Supplier Audit Schedule → Timeline.** "And the audit team schedules quarterly visits off the same primitives. Timeline view because audits are date-anchored."
6. **CLOSER — Incoming Orders → Kanban.** Point at the Blocked column with one card (**ORD-0430**). Click the card → row drawer → click the `source_incident` link → it jumps cross-sheet to the Met Market mold incident. *"Orders flow in via connectors. Records shows what's blocked. The link shows why."*

## Tying the two halves together

The closer on Incoming Orders is the bridge: connectors flow orders in, Records shows which ones are blocked, the cross-sheet link shows *why*. That's the "everything connects" moment.

One sentence to land it if asked: "Connectors handle the file. Records handles everything else around the file — the order it came against, the customer it's going to, the follow-up needed."

## Heads-up / rough edges

- **S3 connector door:** 5min cron lag — pre-stage or skip live.
- **Email connector door:** staging worker isn't DNS-bound — mention, don't demo.
- **Records views:** only Grid is curated for Quality Intake / Credits / Audit. Kanban/Timeline on those will fall back to defaults unless you pre-configure (see setup checklist). **Incoming Orders has Grid + Kanban seeded.**
- The connector walkthrough sign-off doc is at `docs/connectors-walkthrough.md` if you want the formal version.
- Seed script change for Incoming Orders is uncommitted in the working tree (`bin/seed-records-staging`).
