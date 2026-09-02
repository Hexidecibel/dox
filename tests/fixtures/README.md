# Test Fixtures for the Extraction Pipeline

These fixtures lock in the reference inputs for the email-connector extraction regression suite. Each one exercises a different path through `functions/lib/connectors/email.ts`:

- **`coa-orders-medosweet-2026-04-09.pdf`** — the real "Summary Order Status" PDF that surfaced the first batch of extraction bugs. Exercises the PDF -> unpdf -> `chunkByRows` -> `parseWithAI` path. The mocked Qwen response returns 11 orders across 9 distinct customers (mix of `K#####` and `P####` numbers).
- **`weekly-master-customer-registry.xlsx`** — the Weekly Master workbook with multiple sheets including `INACTIVE_CUST`. Exercises the XLSX -> SheetJS -> per-sheet `parseWithAI` path and verifies that inactive sheets are skipped, that multi-contact `ParsedContact` wiring works, and that the per-attachment call cap is respected.
- **`orders-simple.csv`** — a tiny three-row CSV used by the hermetic, AI-free CSV path test. Contains 3 orders, 2 unique KP-prefix customers, header-driven column mapping.

All Qwen responses for the PDF and XLSX fixtures are canned in `tests/helpers/qwen-mock.ts`; no outbound HTTP happens during the test run.

## `spec-corpus/` — generated certificates for the spec engine

A separate corpus with its own [README](spec-corpus/README.md). Five realistic
certificates written as readable HTML and rendered to PDF by
`bin/render-spec-corpus`, plus `corpus.json`: the extraction shape each one
produces and the verdicts `shared/specCheck.ts` must reach from it — including
the negative assertions (no verdict from a control row, no regulatory threshold
reported as a measurement, no reagent lot in a product field). Checked by
`bin/check-spec-corpus` and by `tests/unit/specCorpus.test.ts`. The PDFs are
build output and are gitignored; the HTML is the source of truth, so a reviewer
can read exactly what a fixture claims to print.
