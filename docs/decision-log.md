# Decision log (our side)

Decisions Chris has made that the build follows. AJ Conner keeps his own log (rows `D-0xx`, quoted
where they apply); this file is OURS and uses `C-0xx`. A row here is binding until a later row
says otherwise — add a new row, do not rewrite an old one.

`Status` says what exists in the code, not what was agreed:
`built` (on master) / `live` (deployed) / `to build` / `data change` (a write to a tenant's data
or configuration that needs Chris's go-ahead at the time it is run).

Evidence for the 2026-10-06 rows: `~/drops/aj-2026-10-06/aj-ledger-2026-10-06.md` (every question
and answer between Chris and AJ since mid-September) and the two code audits of the same day,
summarised in `~/drops/aj-2026-10-06/reply-finish-line.md`.

## 2026-10-06 — Phase 1 finish line: every open question closed with the recommended default

Chris, 2026-10-06: "just go with recommended ... I don't think any of those require his SME."
None of these is a question to AJ any more. He is TOLD them (reply-finish-line.md, Part 2) and may
correct any by number.

| ID | Decision | AJ ref | Status | Lands in |
|---|---|---|---|---|
| C-001 | Approval is its own status on the item-and-supplier pair (`product_suppliers`), separate from "currently supplied". Seeded from the supplier list's Approved column; everything on file starts approved. | D-056, open q. 10/06 | built | 0135 |
| C-002 | A facility is a named record under a supplier that a person adds. A printed plant code attaches to it as an identifier. A document with no known facility counts toward the whole supplier (B3). "Line" is not built until a real case needs it. | B3, F7, asked 9/30 | built (thin); step 5 for the full approval record | 0135 |
| C-003 | The sharing rule (send freely / needs QA approval / locked) is set per document type with a per-document override and is enforced on EVERY exit: download of a file out of the portal by link, ZIP, emailed link, bundles, order sends, API keys. A logged-in read-only user downloading inside the portal is not "leaving". Starting table — free: COA, spec sheet, allergen statement, kosher / halal / organic certificates, SDS; needs QA: audit certificate, HACCP / food safety plan, letter of guarantee, insurance; locked: audit report, W-9, anything unclassified. | D-053, D-054 | built | 0137 (step 1d) |
| C-004 | Customer COA requirements: one row per customer and item — COA required (yes / no / on request), what it must show (free text), timing, delivery contact. Widened when AJ's column set arrives. | plan 1.2, item 9 | built | 0135 |
| C-005 | A hold is a portal-only status on a lot's certificate. It stops that COA leaving on an order. QA or an admin releases it with a written reason. Nothing is pushed to a WMS in Phase 1. | B1, B3, E2, asked 9/30 | to build | after step 1 |
| C-006 | Complaint intake Tier 1 is scoped at about 5-7 weeks with four changes: scanned-form reading moves to Tier 2; escalation keywords are a plain word match, not AI; one inbound address per tenant for the PDF channel; the tenant brand record ships first. AJ's recommendation stands on the brief's other open decisions. | 9/27 brief, priced 9/29 | to build | step 3 |
| C-007 | An incident is its own entity — not a document type, not a Records sheet. (Answered to AJ 9/29; re-checked 10/06: Records has no tests, no numbering / routing / alerts, and its public form exposes customer and supplier names; a document type would pull incidents into gaps, renewals and exports.) | decision 7, D-061 | to build | step 3 |
| C-008 | While a supplier is on watch, its limit wins over a company-wide limit, including one written for that exact product. CHANGES VERDICTS: today the product-specific limit wins. | B2, asked 9/30 | to build | spec engine |
| C-009 | A product category is the risk level; one product may be excused from a category's required test with a written reason. Required analytes stay per supplier until category names exist. | A2 | to build | product-scope phase 2 |
| C-010 | The supplier renewal send escalates internally at 21 days past due (7 days after the +14 follow-up). | D-051 | built | 0133 |
| C-011 | The claim table sent 9/29 stands: certificate required, scope = product, GFSI = facility; rBST letter of guarantee recommended; gluten-free and Non-GMO need the certificate; a country-of-origin statement suffices for Made in USA; allergen label stays recommended. | F2 | to build (pack) + data change (existing tenants) | starter pack |
| C-012 | The 17 unrecognised document types: four first-class (FDA Facility Registration, Prop 65, Bioengineered Statement, Environmental Monitoring Program); nine under one "Supplier Compliance Statement"; rBST under Letter of Guarantee; Food Defense statement under Food Defense Plan. | sent 9/29 | to build (pack) + data change | starter pack |
| C-013 | The neutral requirement group names shipped 9/29 stand until AJ sends the final eight. | D-031, F5 | live | — |
| C-014 | FDA facility registration renews Oct 1 - Dec 31 of even years, and only ingredient and co-packer suppliers owe it; business license stays universal. CHANGES the F7 baseline (today every approved supplier owes it). | G3, F7 | to build + data change | `shared/requirementDerivation.ts`, pack |
| C-015 | AJ's GFSI ruling (certificate required, report recommended) is applied to the AJ Clean tenant. | q. 21 of 9/29 | data change | prod, AJ Clean |
| C-016 | Listeria and Salmonella limits mean "absent in 25 g". A bare "Negative" with no stated sample size on a zero-tolerance analyte raises a notice (not judged out of spec). | E2 | to build + data change (the two limits) | spec engine |
| C-017 | Judging a per-mL count against a per-g limit stays a per-organisation switch, off by default, named in every verdict it produces. No change. | C2 vs 0093 | live | — |
| C-018 | The whip product keeps its name; the double space is fixed. | 9/29 | data change | prod, AJ Clean |
| C-019 | Per-lot COA checking looks back 90 days. | product-scope phase 3 | to build | lot scope |
| C-020 | A "Certificate of Compliance" from a cheese supplier is treated as a COA. | — | to build (type alias) + data change | classification |
| C-021 | Supplier requests are a fixed template, never AI-drafted. | D-048 | built | 0133 |
| C-022 | A read-only account never approves a supplier send and is never chosen as the approver. | D-050, "anyone but a read-only account" | built | 0133 |
| C-023 | COAs on an order go attached; a split multi-lot certificate goes as the whole original when the trace is unambiguous, else the per-lot page with a visible warning. Originals are kept with no reclaim date. | H2, D-047 | built | 0134 |
| C-024 | Sizes, not week numbers, are given for the finish-line sequence, except complaint intake (5-7 weeks). | plan Part 5 | — | reply |

### Already decided earlier, restated to AJ in the same reply

| ID | Decision | Status |
|---|---|---|
| C-025 | A COA missing a required test stays open, shown as received-incomplete. | live |
| C-026 | Allergen Statement and Allergen Matrix are one requirement. | live |
| C-027 | A certificate that lapsed while in our queue is not "expired on arrival". | live |
| C-028 | Shelf life stays as printed; export file names use the filed date when there is no lot. | live |
| C-029 | An invoice search does not follow a WMS order number. | live |
| C-030 | Micro limits, pack size, shelf life, GTIN and country of origin are per product. | to build (product-scope phase 2) |

## Findings the finish line turned up (work, not decisions)

| Finding | Where | Lands in |
|---|---|---|
| No tenant brand record exists (logo, colours, display name, support line). | external pages, mail | step 2, before step 3 |
| First-tenant values in live behaviour: `functions/lib/llm.ts` BASE_PROMPT names Medosweet; the default extraction context is dairy for every tenant; real lot / PO / item numbers in search fallback examples and help text; "far too long for dairy" reviewer warning; dairy vocabulary in `shared/productVocabulary.ts`. | see audit | screens, help and the default layer done 2026-10-07 with a guard test; the PROMPT lines are held (C-034) |
| ~~Search ignores module toggles.~~ FIXED 2026-10-07. | `functions/lib/search/` | done |
| No whole-tenant export. Registry links, requirements, spec register, orders, notes and config cannot be exported. | — | step 2 |
| Starter packs cannot be updated in place (insert-or-ignore, no version). Renaming a document type re-slugs it; duplicate concepts are unprevented. | `functions/lib/starter-packs.ts`, `functions/api/document-types/[id].ts` | step 2 |
| Two automatic emails reach whoever emailed a document in (possibly a supplier): the ingest summary reply and the "Review Needed" mail. | `functions/api/webhooks/email-ingest.ts`, `functions/api/queue/[id]/results.ts` | done 2026-10-07 (C-035) |
| Records public surfaces (forms, update requests, workflow approvals) have no tests and no allow-list; a public form exposes customer / supplier / product names. | `functions/lib/records/` | step 2 |
| ~~Dead switches still shown.~~ Removed from every screen 2026-10-07; columns kept. | — | done |
| `customer_contacts` is written by the connector and read by nothing; `customers.coa_delivery_method` and `coa_requirements` are read by nothing. | — | contacts + item requirements built in 0135; the two legacy columns are still read by nothing |
| ~~`products.brand_owner` / `producer` / `plant_code` have API but no screen.~~ Editable on the product page since 0135. | — | done |
| A connector re-ingesting an order number a person built tries to delete its lines. | `functions/lib/kinds/order.ts` | done 2026-10-07 (C-036) |
| `spec_limits`, `supplier_required_analytes`, `teach_sessions` still cascade-delete on a supplier merge. | `functions/lib/suppliers.ts` | done 2026-10-07 (C-037) |
| "Template-promotion gate" (AJ's core list) matches nothing built; meaning unknown. | — | ask is in the reply |

## Only AJ can supply (not questions of judgement)

DCN license expiry and who exports from DCN; Andersen's required analytes, tighter limit and
review-by date; Medosweet's two brand colours (else sampled from the logo); D-045..D-047 and the
Manual COA Fulfillment document, D-001..D-039 if they bind the build; the SharePoint / Cloudflare
answers from their IT (asked 8/20); and, when ready, the approved-item-list dependencies, the
customer COA column set, product category names and the final eight group names.

## We owe AJ

The count of split multi-lot COAs whose whole original is still on file
(`bin/retain-split-originals --remote`); the release carrying the renewal send (0133) and manual
COA fulfillment (0134).

## 2026-10-07 — decisions made while building 0135 / 0136

| ID | Decision | Status | Lands in |
|---|---|---|---|
| C-031 | A customer contact that a connector read off an order is NOT a COA recipient until a person ticks it (`customer_contacts.coa_recipient` DEFAULT 0); a contact a person adds starts ticked. | built | 0135 |
| C-032 | A product linked to a supplier only through the legacy `products.supplier_id` gets a real `product_suppliers` row in 0135 (link source left NULL), so "everything on file starts approved" covers it. Gap output pinned identical before/after. | built | 0135 |
| C-033 | A new tenant with no extraction context gets a GENERIC industry block; the dairy text is a named template. Existing tenants keep their behaviour because 0136 writes the former default into their own setting. **0136 must be applied BEFORE the code deploys.** | built | 0136 |
| C-034 | The prompt edits that remove first-tenant names from BASE_PROMPT, rule 11, the worked examples and the few-shot blocks are NOT merged until scored on the real-document corpus and the doctype corpus. They sit on commit `218e26b` (branch `worktree-agent-ad96fb0c22c5d132d`). The guard test's allow-list holds seven prompt lines "held for measurement" until then. | built - merged 2026-10-07 after scoring: real corpus value 94.8% -> 95.7%, doctype corpus 96.8% -> 96.2%, 288 of 300 values both ways, fabrications 6 -> 5; the guard's allow-list is empty. Live once the worker is restarted. | v2.29.1 |
| C-035 | The two automatic intake emails go to the sender only when the address is an active user of that tenant; otherwise org_admins get an internal notice (audited `intake.sender_notice`). | built | — |
| C-036 | A connector re-ingesting an order never deletes or overwrites a line a person decided (picked, accepted or rejected a suggestion); undecided lines reconcile as before. | built | — |
| C-037 | On a supplier merge, spec limits / required analytes / teach sessions move to the winner; on a key collision the winner's row is kept and the loser's whole row goes into the `supplier.merged` audit row. | built | — |

## 2026-10-08 — decided with defaults while building the sharing rule (0137)

Chris approved these with the plan for step 1d (document orders + the sharing rule). They fill in
what C-003 left open. C-043 and C-044 belong to the document-orders release and are added with it.

| ID | Decision | Status | Lands in |
|---|---|---|---|
| C-038 | A document type with no stored rule and a name we do not recognise is `qa`. A document with **no type** is `locked` (C-003's "anything unclassified"). | built | 0137 |
| C-039 | "Leaving" = ZIP, emailed link, public link read, bundle ZIP, order send / resend, any API-key file read. A logged-in person opening or downloading one file in the portal is not leaving (any role, any rule). | built | 0137 |
| C-040 | Who is "QA": a non-reader user on the `QA` owner route, else the tenant's master user, else org admins (the same ladder as `resolveRenewalApprover`). They, and admins, may release a `qa` document; when one of them ZIPs or sends a `qa` document themselves, that act is the approval and is audited as such (`document.qa_release_approved`). Nobody releases `locked`. | built | 0137 |
| C-041 | API keys read `free` documents only, on every exit, whoever the key belongs to. | built | 0137 |
| C-042 | A file that holds several documents (a packet original, a whole multi-lot original) takes the strictest rule of the documents on it. | built | 0137 |
| C-045 | A `qa` document on an already-minted public link is served ONLY while the person who minted the link (`created_by`) can release QA documents, checked at every read. "The mint was the approval" is true only of a releaser's mint: a link minted by a non-releaser while the document was `free`, or before 0137, stops serving that document once it becomes `qa` - including never-expiring order links - and so does a link whose minter has since lost the QA route or been deactivated. `locked` is never served. A withheld document is counted in `unavailable_count`. Supersedes the "a qa document on a live link stays served" reading of C-040 for links. | built | 0137 |
| C-046 | Only an administrator moves a document off `locked` - by override OR by changing its type (a document with no type is locked, so typing it as anything but a locked type is an administrator's act). A QA releaser may lock a document, and may loosen `qa` to `free`, by override or by re-typing. Tightening by a change of type is open to whoever may edit the document. An API key never loosens a rule - a document's or a type's - whoever owns it. Every move of a document's effective rule writes `document.sharing_rule_changed` (from, to, cause, via). | built | 0137 |

## 2026-10-08 — document orders (0138)

C-043 and C-044 were approved by Chris with the plan for step 1d. C-047 onward were decided with
defaults while building it; none is a question to AJ. He is told them and may correct any by number.

| ID | Decision | Status | Lands in |
|---|---|---|---|
| C-043 | A product with several approved suppliers gets one document line per approved pair; nothing is picked. The person removes what they do not want. | built | 0138 |
| C-044 | On a document order, COAs go attached (as on any order); every other document goes as one link that works for 30 days. A `qa` document the sender cannot release is held as a pending release; QA approving it mints the link and mails the order's recipients. Missing / expired lines notify QA and draft nothing to a supplier. | built | 0138 |
| C-047 | "The current document" of a type for a supplier and item: an active document with a file; the item's own (linked through `document_products`) ranks ahead of a supplier-level one (linked to no item) whatever the dates; one linked only to OTHER items is never offered; newest by approval date wins; a tie takes the later-created, then the higher id, and the line says there was a tie. | built | 0138 |
| C-048 | If the newest candidate has expired the line is `expired`. An older document still in date is not used in its place; the line says one exists. "Expired" is the document's own due date (`resolveRenewalExpiry`), strictly before today - never the product's shelf life. | built | 0138 |
| C-049 | A person picks one document type. Documents filed under a type of the same name that is the organization's or that supplier's own answer it; a type that is another supplier's own does not apply to the pair and is refused in words. | built | 0138 |
| C-050 | Any login, a read-only account included, may open an order and add, remove or refresh its document lines - on any order of the organization, the same reach every other role has. A read-only account still may not put COA lines on an order, edit its header, or send. | built | 0138 |
| C-051 | Item approval is checked when a document line is added, not at send. An item that stops being approved afterwards does not silently drop a document somebody ordered; whether the document may leave is the sharing rule's question and is asked live. | built | 0138 |
| C-052 | A line keeps the document it was added with. Nothing re-resolves it on its own: the order says when a different document is now current, and Refresh is how the person takes it. Refreshing to a different document clears what was decided about the old one. The rule stored on the line when it was added is display only; every decision reads the live rule. | built | 0138 |
| C-053 | QA is told when the order is SENT, not when the line is added, once per line per cause (waiting for approval, missing, expired), in one mail per send, through the `QA` owner route with no admin fallback (unrouted = a routing-gap audit row and a notice to administrators and the master user). A send with nothing for the customer but something for QA is allowed and recorded as its own kind (`qa_request`); with nothing new for QA it is refused as "nothing to send". | built | 0138 |
| C-054 | A QA release mails the recipients of the send that asked (stored on that send; a later edit to the customer does not redirect it), with replies going to the person who sent the order. Lines released together for the same recipients share one link and one email. A batch is partial: what can go goes, what cannot is named and waits. The link is minted in the releaser's name (C-045). If the mail fails the link is revoked and the lines wait again; a failed release is released again, not resent. | built | 0138 |
| C-055 | A QA refusal needs a note and is final for that line on that order - even a releaser's own send does not carry it - until the line is removed or refreshed to a different document. A line QA released is not sent again by a sender who cannot release, and does not hold the order back from delivered. | built | 0138 |
| C-056 | An order is delivered only when no document line was left behind (waiting, missing, expired, locked, refused), the same rule as a COA line with no certificate. A release that leaves nothing outstanding marks the order delivered. | built | 0138 |
| C-057 | The plant on a document line is display only and is not stored: it is the pair's facility as recorded at the moment of display. (The plan listed a facility column; a stored copy would go stale and need its own handling in a supplier merge, for a value no decision reads.) | built | 0138 |
| C-058 | "Waiting for QA" is for people who can act on it: a QA releaser or administrator sees every held document of the organization; anybody else gets an empty list and sees their own waiting lines on the order. No mail goes to the person who ordered when QA releases or refuses - they see it on the order. | built | 0138 |

## 2026-10-08 — document orders, after an independent review of the first cut

The review found that a QA release was not pinned to what QA saw, and that resending an old failed
send overrode later decisions. These rows are how each was closed. C-050, C-053, C-054, C-055 and
C-056 stand; the rows below narrow or sharpen them and do not replace them.

| ID | Decision | Status | Lands in |
|---|---|---|---|
| C-059 | A document line already waiting for QA is never re-pointed. Its asking send, and so the addresses a release mails, are fixed until it is released, refused, removed or refreshed. A later send that still goes (other lines) leaves it alone; a later send with nothing to send and nothing NEW to ask QA is refused as "nothing to send" (C-053 meant this; the first cut allowed it and it moved the recipients). The review screen says "already waiting for QA since <date>, for <recipients>". | built | 0138 |
| C-060 | A release or a refusal is of what QA saw, not of a line id. The request names each line with its document, the document's version and the asking send, and the claim checks all three; if any changed since the list was loaded that line is not released (stated, "changed since you opened it") and the list reloads. The waiting list and the release dialog show the document (title, type, version, approved date), the item, supplier, who asked, when, and the exact recipients. | built | 0138 |
| C-061 | Resending an old failed send never overrides a later decision. Each stored file that came from a document line is asked of that LINE as it stands now: if the line was refused, removed, now holds a different document, or its document has expired, is no longer active or has a new version, the file is left out of the retried email and the reason is stored and returned per file; the rest of the email still goes. A line is marked sent only for the document it holds now, and a refused line is never overwritten. An email with nothing left sends nothing and delivers nothing. A file that also stands for a COA line keeps a COA pick's behaviour. | built | 0138 |
| C-062 | One release covers at most 50 documents, what one link carries. More is refused with both numbers and releases nothing - never split silently, never truncated. | built | 0138 |
| C-063 | A release has three states: waiting, `releasing` (claimed), released. A line is `released` only after the mail went AND the record was written. A release that does not finish leaves the line `releasing`, shown everywhere as "release did not finish" and never as sent; after five minutes a releaser may release it again or put it back, and either first withdraws the link the unfinished attempt minted. The release's record is set to "outcome not recorded" immediately before the mail is handed over, so it never reads "failed" while a customer may hold the link. Nobody's send, a releaser's included, carries a document while it is `releasing`. | built | 0138 |
| C-064 | C-050 narrowed: a read-only account may not remove or refresh a line that is waiting for QA, being released, or released (403, stated); anybody who may send still can. A read-only account opens at most 20 orders an hour. A connector file for an order number a read-only account pre-created updates that order (C-036's path): the connector's header and lines land on it, and the document lines, which live in their own table, are untouched. | built | 0138 |
| C-065 | On a supplier merge, when both suppliers have the same document line on the same order, the line that carries a decision or a pending ask is kept; if both do, the winner's is kept. The whole row that was removed goes into the `supplier.merged` audit row with the id of the line that stood in for it (C-037's rule). | built | 0138 |
| C-066 | The rail's "Waiting for QA" number is one COUNT (`?count=1`), asked on load and every three minutes like the notification bell, and again at once when a screen releases, refuses or puts a document back. It is not asked on every navigation. | built | 0138 |
