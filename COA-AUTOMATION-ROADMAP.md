# COA Automation Roadmap

## The Problem

Today, COA handling is manual: COAs arrive by email, get renamed and filed by hand, orders are cross-referenced across ERP and WMS, lots are matched to COAs manually, customer reports are built one at a time, and a spreadsheet tracks what's been sent. This takes significant daily labor and is error-prone.

## The Solution

An end-to-end system that automates COA intake through customer delivery. Built in phases — each phase is independently useful, and each one unlocks the next.

---

## Phase 1: Smart COA Intake (IN PROGRESS)

**What it does:** COAs arrive (uploaded or emailed) and are automatically parsed, named, filed, and deduplicated.

**What exists today:**
- Upload files → queue → AI extracts fields (supplier, product, lot#, dates, test results) → human reviews → ingested into system
- Duplicate detection via file checksum
- Naming templates (per-tenant configurable patterns)
- OCR fallback for scanned PDFs

**What still needs work:**
- **Extraction quality** — fixing the last 5 of 32 test COAs that aren't parsing correctly (token limits, garbled text detection). Nearly done.
- **Supplier + doc type matching** — when a COA comes in, auto-match it to a known supplier and document type. If the combo is new, route to a "needs configuration" queue.
- **Per-supplier extraction profiles** — save field corrections as templates. Once you correct a Darigold COA once, all future Darigold COAs use those learned rules. The database already stores extraction examples — just needs to be wired into the worker.
- **Email ingest** — receive COAs directly via email (Mailgun webhook). Map sender domain to tenant/supplier automatically. The endpoint stub and email domain mapping table exist but aren't connected yet.

**Why it matters:** This is the foundation. Every downstream step depends on having clean, structured COA data with accurate lot numbers, supplier names, and product info.

---

## Phase 2: Order Intake & Parsing

**What it does:** Automatically receives and parses the daily "customers requiring COAs" report from the ERP system.

**How it works today (manual):** An automated ERP email arrives around 3:30pm daily listing customers that need COAs with their orders. Contains customer number (K##### or P######), business name, and order number.

**What we'd build:**
- **ERP report email parser** — receives the daily email, extracts structured data: customer number, customer name, order numbers
- **Order queue** — each order becomes a work item: "Customer X, Order Y needs COAs"
- **Customer registry** — store customer info (number, name, email, COA requirements) so we know who needs what and where to send it

**Why it matters:** This is the trigger for the whole downstream process. Without knowing which customers need COAs for which orders, nothing else can be automated.

---

## Phase 3: ERP + WMS Integration

**What it does:** Takes order numbers from Phase 2 and automatically looks up PO numbers (ERP) and lot numbers + products (WMS).

**How it works today (manual):** User takes order number → enters it in ERP to get the PO number → enters it in WMS to get the lot numbers and products that make up the order.

**Two integration approaches:**

### Option A: Direct API/Webhook (preferred)
- Connect to ERP and WMS APIs directly
- Query by order number, get structured data back
- Fast, reliable, real-time
- Requires API access or webhook configuration from the ERP/WMS vendors

### Option B: Agent-Driven UI Automation (fallback)
- An AI agent with user credentials logs into ERP/WMS web interfaces
- Navigates the UI, enters order numbers, reads results
- Works with any system that has a web UI
- Slower, more fragile, but doesn't require API access

**What we'd build:**
- **Integration adapters** — pluggable connectors for ERP and WMS (API-first, UI-scraping as fallback)
- **Order enrichment pipeline** — Order comes in → fetch PO from ERP → fetch lots/products from WMS → attach to order record
- **Product catalog sync** — keep our product list in sync with what's in WMS

**Why it matters:** Lot numbers are the join key between orders and COAs. Without them, you can't match COAs to customers.

---

## Phase 4: Automated COA Matching

**What it does:** Matches lot numbers from WMS (Phase 3) to COAs on file (Phase 1), automatically assembling the right COAs for each customer order.

**How it works today (manual):** User looks at the lots for an order, then searches through filed COAs to find the matching ones.

**What we'd build:**
- **Lot-based COA lookup** — given a list of lot numbers from an order, find all matching COAs in the system
- **Match status tracking** — for each order: which lots have COAs, which are missing
- **Missing COA alerts** — if an order needs a COA we don't have yet, flag it and notify the user
- **Multi-product order assembly** — orders often have multiple products/lots, each needing its own COA

**Why it matters:** This is where all the data comes together. Clean COA data (Phase 1) + order info (Phase 2) + lot numbers (Phase 3) = automatic matching.

---

## Phase 5: Customer Report Generation & Delivery

**What it does:** Automatically builds and sends customer COA emails with the right documents attached.

**How it works today (manual):** User creates an email per customer, attaches the matched COAs, writes a brief report, and sends it. Then logs it in a tracking spreadsheet.

**What we'd build:**
- **Report templates** — per-customer or per-tenant email templates for COA delivery
- **Automatic email assembly** — pull matched COAs, attach to email, populate template with order details (PO#, product names, lot numbers)
- **Send tracking** — replace the spreadsheet. Every sent report logged in the system with: customer, order, COAs included, date sent, who sent it
- **Delivery dashboard** — at a glance: which orders are complete, which are waiting on COAs, which have been sent
- **Re-send capability** — customer asks for a COA again? One click.

**Why it matters:** This is the customer-facing output — the reason the whole system exists. Faster, more consistent, with a full audit trail.

---

## Phase 6: Continuous Improvement

**What it does:** The system gets smarter over time.

- **Extraction learning** — every human correction improves future extractions for that supplier/doc type
- **Supplier onboarding** — first time we see a new supplier's COA format, human configures it once, then it's automatic forever
- **Analytics** — which suppliers are slow to send COAs? Which customers get the most reports? Where are the bottlenecks?
- **Multi-tenant** — other companies can use the same system with their own suppliers, customers, and ERP/WMS connections
- **Industry prompts** — the AI extraction is configurable per industry (dairy/food is the default, but the architecture supports any industry)

---

## Infrastructure: Distributed Inference

**The problem:** Running Qwen 35B on a single server is slow — each COA takes 3-10 minutes to process. A batch of 30+ documents can take over an hour.

**The solution:** Distribute inference across multiple machines using llama-swap, which is already running in the current setup.

**Current setup:**
- Single server running llama-swap on port 9600
- Qwen3-5-35B-A3B model (mixture-of-experts, ~3-4GB active parameters)
- Auth proxy on port 9601, tunneled for remote access
- Processing is CPU-bound and slow

**Planned additions:**
- **Gaming PC (RTX 4080, 16GB VRAM):** Run llama-swap + llama.cpp as a second inference node. The 4080 should give 3-5x speedup over CPU inference. Toggle on/off — when gaming, requests fall back to server.
- **Mac Mini (Apple Silicon, on order):** Unified memory architecture is great for LLM inference. Third inference node, always-on.
- **llama-swap load balancing:** The existing llama-swap setup can route requests to multiple backends. Fastest available GPU handles the request, with automatic fallback if a node is offline.

**How it works:**
1. llama-swap on the server acts as the router
2. Gaming PC and Mac Mini each run their own llama-swap instance with the Qwen model
3. Server's llama-swap config lists all backends with priority (GPU nodes preferred)
4. If a node is down (gaming, sleeping, etc.), requests automatically route to the next available
5. No code changes needed in dox — it just talks to the same Qwen endpoint

**Benefits:**
- 30+ COA batch drops from 1-2 hours to ~15-20 minutes
- Resilient — any single machine can handle the load alone
- Scales further by adding more nodes
- Zero-downtime toggling — take a machine offline anytime

---

## Summary

| Phase | What | Depends On | Effort |
|-------|------|-----------|--------|
| 1. Smart COA Intake | Parse, file, deduplicate COAs automatically | — | In progress |
| 2. Order Intake | Parse daily ERP email for customer orders | Phase 1 | Medium |
| 3. ERP + WMS Integration | Look up PO numbers and lot numbers | Phase 2 | Large (API access needed) |
| 4. COA Matching | Match lots to COAs on file | Phase 1 + 3 | Medium |
| 5. Report & Delivery | Build and send customer COA emails | Phase 4 | Medium |
| 6. Continuous Improvement | Learning, analytics, multi-tenant | All phases | Ongoing |

Each phase delivers standalone value. Phase 1 alone eliminates manual COA filing and renaming. Phase 2 alone structures the daily order list. They compound as you stack them.
