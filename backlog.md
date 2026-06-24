# Backlog

Deferred ideas, long-term research, and items not in the daily workflow.

## IDEA: Generalize lot_scheme beyond date_code — configurable WMS canonicalization (2026-06-23)

Floated 2026-06-23 while shipping the Country Morning Farms fix. The new per-supplier
`lot_scheme` field (`auto|date_code|lims_combined|plain`, migration 0075) currently has
`date_code` as the only truncating preset (keeps leading 6-digit `MMDDYY`). But the real job
is **"reproduce whatever the WMS does to the lot"** — and that rule isn't always date-based:
strip a trailing plant/batch token with no date (`A4592-PLANT3` → `A4592`), keep first N
chars, strip a known `LOT-`/`BATCH-` prefix, keep a middle segment, etc.

**Why it's a clean extension, not a rework:** the whole transform is isolated in one pure
function `applyLotScheme` in `functions/lib/entities/lots.ts`. Growth is localized:
- **Presets first** — add `strip_trailing_alpha`, `prefix_n`, etc. as enum values (a few
  lines in `applyLotScheme` + a `MenuItem` in `LotSchemeSelect`).
- **Regex escape-hatch only if needed** — optional `lot_pattern` column where canonical key
  = capture group 1 (`date_code` becomes the preset `^(\d{6})`). Power, but a footgun in
  non-engineer hands — gate behind presets.

**Two principles to carry forward (same lessons as CMF):**
- Every truncation discards info → pulls matching down to the WMS's granularity (correct),
  so a new truncating supplier almost always needs a **product map** too, not just a scheme.
  See [[project_country_morning_lot_and_product_bridge]].
- **Calibration is the safety net:** the surest validation is comparing COA-derived canonical
  keys against the *actual* WMS lot values for the same shipments. Long-term, auto-detect
  could sample both sides and propose the rule that makes them line up.

Revisit when a second truncating supplier appears whose WMS rule isn't date-based.

## IDEA: Industry profiles (dairy / meat / etc.) as selectable tenant bases (2026-06-05)

Floated 2026-06-05. Today the tenant extraction-prompt layer (`tenants.extraction_context`,
migration 0072) defaults to a single baked-in `DEFAULT_DAIRY_CONTEXT` constant
(duplicated in `functions/lib/llm.ts` + `bin/process-worker`) — effectively a hardcoded
"dairy profile." Generalize into a library of **industry profiles** (dairy, meat,
produce, …) that a tenant picks from; the chosen profile seeds/initializes that tenant's
editable `extraction_context`. **Not a rewrite** — additive:
- A small `industry_profiles` table (slug, name, base_context TEXT) — move the dairy
  brain into a row instead of a code constant.
- On tenant create / a "Start from profile" button in the Extraction Context editor,
  copy the profile's `base_context` into `tenants.extraction_context` (then it's
  tenant-owned + editable, same as today's seeded Cush Co).
- Combo layer (`supplier_extraction_instructions`) is unaffected — still per supplier×doctype.

**For now: dairy is the only base.** Cush Co's tenant context was seeded with the dairy
brain on prod 2026-06-05 and is editable in Settings → Extraction Context — refine it
there. See [[project_two_layer_prompts]]. Revisit profiles when a non-dairy tenant appears.

## REDESIGN: Shared format/LIMS profiles — minimize per-supplier config (2026-06-12)

**Goal (user, 2026-06-12):** "as little as possible in supplier instructions" so two
companies on the same dox platform receiving the SAME source format (e.g. a Darigold/LIMS
COA) don't each repeat the same back-and-forth teaching. Deferred — Option B finally works;
don't rip it apart now. Revisit as a redesign.

**The problem:** extraction knowledge today lives in (1) the universal worker prompt (code,
shared), (2) `tenants.extraction_context` (per-tenant), (3) `supplier_extraction_instructions`
(per **tenant×supplier×doctype**). There is NO layer for *format* knowledge that's reusable
across tenants — so the same LIMS-template know-how gets re-taught per tenant in layer 3.

**Reframe:** separate "how to read this FORMAT" (reusable — keyed on the LIMS/template, which
many manufacturers share) from "what this COMPANY wants" (genuinely per-tenant). Format
knowledge is the asset to teach ONCE.

**Proposed 4-layer resolution (merge in order at extraction time):**
1. Universal rules (code prompt) — dairy/COA semantics + structural patterns (sublot split,
   transposed-column matrices, specs-verbatim, the `(NNNN)` distributor-code-in-title
   convention). Default home for anything format-general. (The transposed-column fix landed
   here — the model proved this works with zero per-supplier config.)
2. **Shared format profiles (NEW, cross-tenant library)** — keyed on a **format fingerprint**
   (issuer markers like "Darigold, Inc." text, the `Sub Lot Number` row, header geometry),
   with **global-supplier identity as a fallback key**. Platform-curated; inherited read-only
   by all tenants. A new tenant's first Darigold COA extracts with ZERO local teaching.
3. Per-tenant `supplier_extraction_instructions` — shrinks to a thin DELTA (true company
   overrides only).
4. Tenant preferences (naming/normalization/doctype mapping).

**Key decisions to settle:**
- *Keying:* fingerprint (strongest — one profile covers every manufacturer on that LIMS) →
  fall back to global-supplier → tenant delta. Detection = cheap signature match or
  model-assisted "which known template is this?".
- *Curation:* shared layer is **platform-owned**, never auto-written by a tenant. Tenants
  teach locally (layer 3); a human **promotes** format-general learnings up to layer 2. That
  promotion gate IS the privacy boundary.
- *Privacy:* shared profiles hold FORMAT knowledge only — no tenant data; few-shot examples
  scrubbed/synthetic.
- *Representation:* structured descriptors (field mappings, layout hints, fingerprint
  signature, scrubbed examples) — NOT free prose — so layers compose deterministically.

**Two levers that make "as little as possible" real even before layer 2 exists:**
- Discipline: when teaching, ask "format-general or company-specific?" General → universal
  prompt; specific → thin tenant delta. Keeps layer 3 from bloating.
- A capable model (Q8) + universal rules absorb most layout handling (transposed-columns is
  the proof). Reserve teaching for the residual the model can't infer.

Precedent for global-vs-tenant layering already exists: `document_types` hybrid (NULL
supplier = shared) and products went global→tenant in 0017. This is the same idea applied to
extraction profiles, sitting above [[project_two_layer_prompts]] and the owned-review
(supplier,doctype) profiles. Related: the "Industry profiles" idea above (that's the tenant
BASE layer; this is the shared FORMAT/supplier layer). See [[feedback_never_auto_confirm]] —
shared profiles change extraction config, NOT the human-confirm match/ingest gates.

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

### FOLLOW-UP: Legacy corpus supplier reconciliation (surfaced 2026-06-02)
Building the teach interface revealed the legacy COA corpus is poorly tagged: **every legacy
processing_queue COA item has `supplier_id = NULL`** — matched only by an inconsistent `supplier`
NAME string ("Medosweet Farms, Inc." vs the supplier record "Medosweet Farms"; "ANDERSEN DAIRY INC."
vs "Andersen Dairy Inc."), and some docs are mis-extracted entirely (a Medosweet file extracted as
"Willamette Egg Farms"). The teach uncertainty detector now works around this with normalized fuzzy
name matching, but the real fix benefits the WHOLE system: a **backfill job** that resolves each
legacy queue item's supplier name → a canonical `supplier_id` (dedupe name variants, ties into the
existing supplier-dedupe/merge tooling). Until then, anything supplier-scoped over legacy data leans
on fuzzy name matching. New docs (post connectors→sources unification) ARE tagged with supplier_id, so
this is a legacy-data cleanup, not a forward problem.

### Phase B0 — Learning Interface (SME knowledge elicitation, Qwen-driven)
STATUS 2026-06-02: BUILT + DEPLOYED to prod (commits up to 0ac487f) + PROVEN LIVE — a real Medosweet
teach session on supdox.com matched 21 real docs, surfaced real issues (grade/product_code often-empty,
plant_number/product_name/supplier_name inconsistent), and Qwen asked a specific grounded question
quoting real extracted values, even on the 7B. Synthesize→confirm→write-profile wired + unit-tested
(not yet exercised by a real SME end-to-end). Detail below.
The user is NOT the SME; the partner is, and **can't learn a config UI** — so the SYSTEM interviews
him. Decisions: **Qwen** drives question-gen + answer-synthesis (on-prem, no new dep); **open
interview** style (conceptual prose Q&A); **batch "go-go-go, surface questions as a group"** for the
onboarding sprint (dedup the SME's effort — ask each distinct ambiguity ONCE across the corpus, not
per doc); inline-in-review is the steady-state variant of the same thing.
**Shape = a CONVERSATIONAL teaching session that converges, then is SELF-SERVICE:** the AI interprets
the docs and chats with the SME about them until it knows enough (parity loop = the "enough?" meter),
THEN presents the synthesized rules for the SME to CONFIRM — confirmation is what writes the profile.
It's a permanent, repeatable feature: going forward the SME himself kicks off a teach-chat for each new
supplier. He never configures; he talks about docs he understands + confirms. This is the NEW→TUNED
on-ramp of the maturity ladder; once confirmed, the combo drops to the partner's 1-click queue.
Loop: (1) Qwen extracts across a batch of one supplier's real docs, flagging per-field uncertainty
(low confidence / run-to-run disagreement — the parity signal); (2) CLUSTER uncertainties into a small
set of distinct questions; (3) surface the GROUP as one consolidated questionnaire, grounded with
example snippets; (4) SME answers in prose; (5) Qwen synthesizes → `supplier_extraction_instructions`
(+ `extraction_examples`) on the (supplier, doctype) profile; (6) re-run the batch via `bin/parity-coa`,
measure, surface residual group, repeat → profile reaches TUNED. Reuses existing infra
(supplier_extraction_instructions w/ field_mappings, extraction_examples, the parity harness as the
measurement loop). This IS the NEW-state collection step of Phase B / the maturity ladder.

### Phase B — One guided review flow ("does it all")
- Progressive, confidence-gated tile instead of disjoint gates: **confirm supplier**
  (only when uncertain) → **confirm doctype** (only when uncertain; this is the
  "missed doc type" path — make it smooth, supplier-scoped per the 0069 reparenting)
  → **review parse**. Corrections write back to the profile (mappings + instructions
  + examples) in the same action — the teaching loop (partly exists today; unify it).
- NEW combo → the flow collects everything once. TUNED combo → all-green, one-click
  approve, nothing to fix.

### Notifications bell = the unified "waiting on you" tray (started 2026-06-02)
Built: a top-bar bell (`src/components/NotificationsBell.tsx`, generic `Notification[]` tray) fed by
workflow approvals (`recordsApi.workflowApprovals.inbox()`). Approvals moved OUT of Settings into the
bell. Designed to take more feeds additively. **NEXT feed (user-requested): "your assigned review
items"** — when a doc of a `(supplier, doctype)` the current user OWNS gets ingested/queued, it shows
on the bell → click → review. This is gated on Phase C (owner_user_id on the profile + assign UI);
once ownership exists the feed is just "pending review items whose (supplier,doctype) is owned by me."

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
