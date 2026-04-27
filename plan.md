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
