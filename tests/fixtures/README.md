# Test Fixtures for the Extraction Pipeline

These fixtures lock in the reference inputs for the email-connector extraction regression suite. Each one exercises a different path through `functions/lib/connectors/email.ts`:

- **`coa-orders-medosweet-2026-04-09.pdf`** — the real "Summary Order Status" PDF that surfaced the first batch of extraction bugs. Exercises the PDF -> unpdf -> `chunkByRows` -> `parseWithAI` path. The mocked Qwen response returns 11 orders across 9 distinct customers (mix of `K#####` and `P####` numbers).
- **`weekly-master-customer-registry.xlsx`** — the Weekly Master workbook with multiple sheets including `INACTIVE_CUST`. Exercises the XLSX -> SheetJS -> per-sheet `parseWithAI` path and verifies that inactive sheets are skipped, that multi-contact `ParsedContact` wiring works, and that the per-attachment call cap is respected.
- **`orders-simple.csv`** — a tiny three-row CSV used by the hermetic, AI-free CSV path test. Contains 3 orders, 2 unique KP-prefix customers, header-driven column mapping.

All Qwen responses for the PDF and XLSX fixtures are canned in `tests/helpers/qwen-mock.ts`; no outbound HTTP happens during the test run.
