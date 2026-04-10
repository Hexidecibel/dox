# CogniLogic Systems — Master Vision

> AI-Powered Intelligence for Food Safety & Regulatory Excellence

The CogniLogic vision is built in phases. Each phase delivers standalone value and unlocks the next. The foundation is **dox** (supdox.com) — a multi-tenant document intelligence platform already live in production.

**Status markers:** `COMPLETE` | `IN PROGRESS` | `PLANNED` | `FUTURE`

---

## Phase 1: Smart COA Intake — `COMPLETE`

Automated COA ingestion pipeline. Documents arrive (uploaded or emailed), are parsed by AI, reviewed by humans, and ingested with structured metadata.

### What's live
- Upload → queue → Qwen AI extraction → human review → ingest
- Per-supplier+doctype extraction templates (auto-maps fields after first review)
- Auto-ingest when template exists + confidence gates pass
- Email ingestion at {slug}@supdox.com via Cloudflare Email Worker
- AI natural language search (fuzzy products/suppliers, expiration queries, metadata filters)
- OCR fallback for scanned PDFs and standalone images
- Auto-rotation detection for sideways/upside-down scans
- Few-shot extraction examples — corrections improve future extractions per supplier
- Full table review with editable cells, add/delete rows and columns
- Supplier management pages with products, templates, documents
- Expiration dashboard with summary cards and configurable look-ahead
- Document bundles (compliance packages) with ZIP download
- Role-based access control (super_admin, org_admin, user, reader)
- Full audit trail on all operations

### Known remaining items
- FTS5 migration for when document count grows
- Table edits and column excludes not persisted on approve
- Notes field not persisted on approve
- Email ingest log not written to DB (worker lacks D1 bindings)

---

## Phase 2: Order Intake & Parsing — `PLANNED`

Automatically receive and parse the daily "customers requiring COAs" report from the ERP system.

### Scope
- **ERP report email parser** — receive the daily automated email (~3:30pm), extract structured data: customer number (K#####/P######), customer name, order numbers
- **Order queue** — each order becomes a work item: "Customer X, Order Y needs COAs"
- **Customer registry** — store customer info (number, name, email, COA requirements, delivery preferences)

### Why it matters
This is the trigger for the entire downstream process. Without knowing which customers need COAs for which orders, nothing else can be automated.

---

## Phase 3: ERP + WMS Integration — `PLANNED`

Take order numbers from Phase 2 and automatically look up PO numbers (ERP) and lot numbers + products (WMS).

### Scope
- **Integration adapters** — pluggable connectors for ERP and WMS systems
  - Option A: Direct API/webhook (preferred — fast, reliable, real-time)
  - Option B: Agent-driven UI automation (fallback — works with any web UI)
- **Order enrichment pipeline** — order → fetch PO from ERP → fetch lots/products from WMS → attach to order record
- **Product catalog sync** — keep product list in sync with WMS

### Why it matters
Lot numbers are the join key between orders and COAs. Without them, you can't match COAs to customers.

---

## Phase 4: Automated COA Matching — `PLANNED`

Match lot numbers from WMS to COAs on file, automatically assembling the right documents for each customer order.

### Scope
- **Lot-based COA lookup** — given lot numbers from an order, find all matching COAs in the system
- **Match status tracking** — per order: which lots have COAs, which are missing
- **Missing COA alerts** — flag orders with missing COAs, notify relevant users
- **Multi-product order assembly** — orders with multiple products/lots, each needing its own COA

### Why it matters
This is where all the data converges. Clean COA data (Phase 1) + order info (Phase 2) + lot numbers (Phase 3) = automatic matching.

---

## Phase 5: Report Generation & Delivery — `PLANNED`

Automatically build and send customer COA packages with the right documents attached.

### Scope
- **Report templates** — per-customer or per-tenant email templates for COA delivery
- **Automatic email assembly** — pull matched COAs, attach to email, populate with order details (PO#, products, lot numbers)
- **Send tracking** — replace the manual spreadsheet. Every sent report logged: customer, order, COAs included, date, sender
- **Delivery dashboard** — at a glance: orders complete, waiting on COAs, sent
- **Re-send capability** — customer asks for a COA again? One click.

### Why it matters
This is the customer-facing output — the reason the whole system exists. Faster, more consistent, with a full audit trail.

---

## Phase 6: Intelligence Hub — `FUTURE`

Evolve the document portal into a full compliance intelligence platform.

### Scope
- **Semantic search** — natural-language queries across all documents ("Show me all allergen validations from Q3 for Line 4")
- **Document completeness checker** — do we have all required doc types for all active suppliers/products? Flag gaps proactively
- **Automated document generation** — AI drafts food safety plans, SSOPs, recall protocols based on current regulations and company data
- **Compliance dashboard** — real-time visualizations of document completeness, overdue reviews, regulatory alignment scores
- **Regulatory horizon scanning** — track regulation changes (FSMA, EU updates) and flag affected documents/plans
- **Advanced analytics** — which suppliers are slow to send COAs? Where are the bottlenecks? Turnaround time trends.

### Why it matters
Transforms static document repositories into living, intelligent compliance assets. Eliminates "where is that record?" delays during audits.

---

## Phase 7: Multi-Agent QA System — `FUTURE`

Autonomous AI agents that handle complex quality assurance and food safety workflows without constant human supervision.

### Scope
- **Safety Agent** — monitors production data, triggers hold-and-release protocols on anomalies
- **QA Agent** — flags quality issues, manages deviation workflows, tracks corrective actions
- **Regulatory Agent** — maintains digital food safety plans, auto-updates when regulations change
- **Multi-agent collaboration** — agents coordinate: QA flags issue → Safety triggers hold → Regulatory updates the plan
- **Predictive analytics** — continuous monitoring via IoT sensors, lab results, environmental data to predict food safety risks (microbial contamination, allergen cross-contact) before they happen
- **Audit simulation & gap analysis** — run full mock audits before external audits, flag gaps, auto-generate evidence packages
- **Automated compliance workflows** — generate FSMA preventive controls, perform root-cause analysis, draft corrective action reports

### Deployment
- Human-in-the-loop oversight for high-stakes decisions
- Open-source or fine-tuned LLMs (customer choice)
- On-premise or hybrid deployment

---

## Phase 8: On-Prem & Enterprise Infrastructure — `FUTURE`

Eliminate cloud dependency for clients requiring full data sovereignty. Design, deploy, and manage enterprise-grade hardware for running LLMs and agentic AI on-site.

### Scope
- **Custom server architecture** — GPU/TPU clusters optimized for inference and fine-tuning
- **Air-gapped / private-network configurations** — meets FDA 21 CFR Part 11, GxP standards
- **Full stack deployment** — inference engines, vector databases, orchestration tools, monitoring dashboards
- **Scalability roadmap** — right-sized to client needs and budget, with upgrade paths
- **24/7 remote monitoring** — quarterly health checks, hardware refresh planning
- **Hybrid option** — cloud for non-sensitive workloads, on-prem for regulated data

### Why on-prem matters
Complete control over sensitive data (recipes, supplier info, audit records). No recurring cloud fees. Guaranteed uptime during internet outages. Required by some regulatory frameworks.

---

## Phase 9: Consulting & Audit Services — `FUTURE`

Expert human + AI consulting that bridges regulatory knowledge with technology implementation.

### Scope
- **Food safety plan development** — HACCP, HARPC, PCQI, SQF, BRCGS (new or modernization)
- **Gap assessments & mock audits** — conducted by certified PCQIs and former FDA/USDA inspectors
- **Training programs** — customized workshops for staff on AI tools and the Intelligence Hub
- **Continuous improvement** — quarterly regulatory horizon scanning with automated plan updates
- **Recall & crisis preparedness** — simulation exercises powered by agentic AI
- **Integrated delivery** — every consulting engagement includes deployment of relevant AI agents and portal modules

### Why it matters
Recommendations aren't just documented — they're actively enforced by the AI system. Consulting becomes an onramp to the full platform.

---

## Infrastructure: Distributed Inference

Scaling the AI extraction pipeline across multiple machines.

### Current
- Single server running llama-swap on port 9600
- Qwen3-5-35B-A3B model (mixture-of-experts)
- Auth proxy on port 9601, tunneled for remote access

### Planned
- **Gaming PC (RTX 4080)** — second inference node, 3-5x speedup over CPU. Toggle on/off for gaming.
- **Mac Mini (Apple Silicon)** — third inference node, always-on. Unified memory is ideal for LLM inference.
- **llama-swap load balancing** — route to fastest available GPU, automatic fallback if a node is offline.
- **Target** — 30+ COA batch drops from 1-2 hours to ~15-20 minutes

---

## Business Model

| Package | Includes | Timeline |
|---------|----------|----------|
| **Starter** | Intelligence Hub + Basic QA Agents + Hardware Setup | 6-8 weeks |
| **Enterprise** | Full suite + ongoing consulting & optimization | Annual retainer |
| **Success-Based** | Base implementation fee + performance bonuses tied to audit scores and time savings | Custom |

---

## Regulatory Coverage

FDA, USDA, FSMA, HACCP, SQF, BRCGS, ISO 22000 — with architecture supporting expansion to pharmaceuticals, cosmetics, and agriculture.

---

*CogniLogic Systems turns regulatory burden into competitive advantage. Our clients don't just pass audits — they lead their industries in safety, efficiency, and innovation.*
