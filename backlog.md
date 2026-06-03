# Backlog

Deferred ideas, long-term research, and items not in the daily workflow.

## DIRECTION: Owned Review Flow + Profile Lifecycle (multi-user maintenance)

Confirmed direction 2026-06-02. The long-term shape for running dox with multiple
maintainers as content volume grows. Builds directly on the (supplier, document_type)
extraction profile shipped this session. **Locked decisions:** steady-state =
one-click-confirm (NOT auto-ingest — keeps the human gate, just trivial); maturity =
hybrid (system *suggests* promotion, owner confirms); assignment unit = **(supplier,
doctype) combo** (unassigned → shared pool).

**Core model:** the `(supplier, doctype)` profile becomes a *stateful, owned* entity.
The Review Queue is the ONE guided flow that both onboards a new combo and teaches the
profile; reviewing IS teaching. As a profile matures, review gets lighter. Work is
partitioned by owner, each with a focused full-screen approval surface.

### Phase A — Profile as a first-class stateful entity
- Extend the profile (today: `supplier_extraction_instructions`, keyed (supplier_id,
  document_type_id), with `field_mappings`) with lifecycle fields: `maturity_state`
  (new|learning|tuned), `clean_streak`, `last_confidence`, `sample_count`,
  `owner_user_id`, `trusted_at`. (Decide: extend that table vs a dedicated
  `extraction_profiles` table — the instructions table is getting overloaded.)
- Lazily upsert a profile row on first doc of a combo (it's the NEW state).
- On each approve: update streak/confidence/sample_count; demote tuned→learning if a
  tuned profile starts drawing corrections (regression safety).

### Phase B — One guided review flow ("does it all")
- Progressive, confidence-gated tile instead of disjoint gates: **confirm supplier**
  (only when uncertain) → **confirm doctype** (only when uncertain; this is the
  "missed doc type" path — make it smooth, supplier-scoped per the 0069 reparenting)
  → **review parse**. Corrections write back to the profile (mappings + instructions
  + examples) in the same action — the teaching loop (partly exists today; unify it).
- NEW combo → the flow collects everything once. TUNED combo → all-green, one-click
  approve, nothing to fix.

### Phase C — Ownership + assignment
- Assign (supplier, doctype) → user (`owner_user_id` on the profile; or an
  `assignments` table if many-owners/escalation needed later). Unassigned → shared pool.
- Admin assignment UI. Queue items resolve their owner via their profile.

### Phase D — Per-user full-screen approval queue
- A focused, keyboard-driven, full-screen "My Queue" = items for combos I own,
  prioritized. NEW combos show the full onboarding flow; TUNED show 1-click. This is
  the daily work surface for maintainers (distinct from the admin grid).

### Phase E — Promotion / trust mechanics (hybrid)
- System detects a profile looks stable (clean_streak ≥ N & confidence ≥ X) and
  SUGGESTS promotion in the owner's queue ("Willamette COA looks stable — trust it?").
  Owner confirms → tuned → review lightens. Tie into the deferred drift-detection +
  golden-set safety nets below.

Smallest first slice: Phase A (lifecycle fields + streak tracking) → unlocks B and E.
Assignment (C/D) is independently shippable once profiles are stateful.

## Smarter Extraction — Deferred Items

- **Auto-suggest reviewer instructions from comment clustering** — TF-IDF
  over `extraction_evaluations.comment` per supplier; auto-draft
  `supplier_extraction_instructions` rows for reviewer approval. Reviewer
  literally asked for this in Darigold comments.
- **Field schema discovery** — when a reviewer adds the same custom field
  via "extended metadata" 3+ times for one supplier, propose adding it to
  canonical schema. Same for "this column always appears in this table."
- **Drift detection + alerts** — cron watches per-supplier override rate
  week-over-week; alerts on jumps. Catches "supplier changed PDF format"
  silently breaking auto-ingest.
- **Regression eval / golden set** — auto-build frozen test set from
  approved items; re-run on prompt/model changes; compare. Critical safety
  net once auto-ingest runs without humans.
- **Per-tenant tunables admin UI** — confidence thresholds, trust-ladder
  pace, "always require human review for fields X/Y/Z," per-tenant model
  selection. Customer IT teams self-serve.
- **Multi-reviewer disagreement signal** — when two reviewers pick
  different sources for the same doc-class, flag for instruction
  clarification.
- **Auto-routing per (supplier, doctype)** — skip text or VLM extraction
  when one side has won decisively. Saves time/VRAM but kills comparison
  data needed for ongoing learning.
- **`bin/dedupe-suppliers` admin tool** — one-shot script that finds
  existing supplier dupes (e.g. `Medosweet` x3) and merges them. Prints
  proposed merge plan first, never auto-runs.
- **Multi-product workflow improvements** — Pacific Cheese / ALOUETTE
  multi-product disambiguation needs its own UX design ("this PDF has 3
  products, which row matches the order?").
- **Make queue-approve transactional** — Today, approve performs sequential
  D1 writes (documents → document_versions → document_products →
  extraction_examples → audit_log). If any step fails mid-way, earlier
  writes commit and leave zombie rows. Wrap the whole flow in a D1 batch
  or single transaction so any failure rolls back cleanly. Surfaced during
  Phase 1 staging verification when the extraction_examples doctype-NULL
  constraint half-committed a document.

## Native Mobile App — Deferred

- **Native mobile app for dox (iOS + Android)** — The Records module's
  killer use case is field data capture: QC photos in a warehouse,
  supplier intake on the floor, approvals on the go. PWA gets us most of
  the way, but native unlocks real camera integration
  (auto-capture/burst), push notifications for Update Requests and
  approval requests, offline-first record creation that syncs when back
  online, biometric auth, and deep links from email/SMS into specific
  records.

  Stack candidates TBD — leaning React Native (code reuse with the
  existing React app) or Expo (faster dev loop); native iOS/Android out
  of scope unless we have a specific reason. Prerequisite: dox API
  surface needs to be 100% functional for mobile clients before native
  makes sense — Records' REST + WebSocket + auth surface is most of it,
  so write a "mobile-friendly API audit" task before kickoff. **Status:**
  Backlog — revisit after Records Phase 4 ships.
