# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

---

## AI Import Pipeline — shipped but needs iteration (2026-04-01)

The in-house AI processing pipeline is live (replaced MindStudio). Drop files → Qwen extracts fields → review → ingest. Works end-to-end but needs refinement:

### Prompt tuning
- Qwen extraction quality is inconsistent — needs prompt engineering work
- Test with real COAs and iterate on the system prompt in `functions/lib/llm.ts`
- Consider structured output / JSON mode if Qwen supports it better
- Try few-shot examples in the prompt

### PDF text extraction
- Current `unpdf` extraction may struggle with scanned PDFs
- Consider adding OCR (tesseract or similar) for image-based PDFs
- Test with real-world documents to identify gaps

### Import page improvements
- [x] Document preview (show the PDF inline while reviewing extracted fields)
- [x] Let users select which extracted fields to include in metadata vs just search (primary/extended tiers)
- [x] Better field mapping — all AI fields default to primary, user can demote to extended or dismiss
- [ ] Product name autocomplete against existing products during review

### Extraction fields philosophy
Full-text search already captures everything. Extraction fields are for:
- Structured metadata (primary_metadata JSON) for filtering/dashboards
- Product resolution (matching to catalog)
- Supplier resolution (lookup-or-create)
- Clean, normalized values

### Email webhook (Phase 4)
Still needs to be built — `functions/api/webhooks/email-ingest.ts`. Plan is in the plan file. Needs:
- Migration 0019 (default_document_type_id on email_domain_mappings)
- Mailgun webhook parsing + signature verification
- Auto-ingest flow (no human review)
- Summary email back to sender

### Qwen proxy
- Auth proxy runs on port 9601, tunneled to qwen.tunnel.cush.rocks
- Secret stored in `.qwen-proxy-secret` (gitignored)
- Cloudflare Pages secrets: QWEN_URL + QWEN_SECRET
- Tunnel auto-expires after 1 hour — needs `bin/status extend qwen`
- Consider making the proxy auto-start or adding to a systemd service

### Non-critical bugs from previous testing (still open)
- [ ] `sku` field silently ignored on product create (column not in schema)
- [ ] Soft-deleted items (products, doc types) still appear in list endpoints — no default `active=1` filter
- [ ] `active: false` (boolean) rejected on product update — API requires integer 0/1
- [ ] `bin/seed` sets invalid password hash — causes 500 on login
- [ ] Query param inconsistency: `tenantId` (camelCase) vs `tenant_id` (snake_case) across endpoints
