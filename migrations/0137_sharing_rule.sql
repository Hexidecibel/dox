-- THE SHARING RULE: may this document leave the organization, and on whose say.
--
-- Decision C-003 (and C-038..C-042): every document carries one of three
-- answers, and the answer holds on EVERY way a file leaves -- a ZIP, an emailed
-- link, a public link read, a bundle ZIP, an order send or resend, and any read
-- made with an API key.
--
--   free    send freely
--   qa      needs QA approval before it leaves
--   locked  never leaves
--
-- WHERE THE ANSWER LIVES
--
--   document_types.sharing_rule         the rule for every document of the type.
--                                       NULL = not stored: resolved at read time
--                                       from the type's name (shared/sharingRule.ts),
--                                       and a name nobody recognises reads 'qa'.
--   documents.sharing_rule_override     one document's own answer, which wins
--                                       over its type. NULL on every existing row.
--   documents.sharing_rule_override_by / _at / _reason
--                                       who set it, when, and why. The reason is
--                                       required by the API; it is the record of
--                                       a person deciding against the type.
--
-- A document with NO type reads 'locked' (C-038: anything unclassified).
--
-- NO CHECK ON THE VALUES, deliberately, as with requirements.scope (0123): the
-- reader (parseSharingRule) treats anything that is not one of the three words
-- as "not stored" and falls through to the stricter default, so a bad value can
-- only ever make a document harder to send, never easier.
--
-- ADDITIVE AND NULLABLE. No default, no backfill here: read-time resolution
-- answers for a NULL, so there is no window in which a document has no rule.
-- bin/backfill-sharing-rules writes the explicit value onto existing types so
-- the Document Types screen shows a stored setting instead of a derived one.
--
-- Plain-ASCII header (the 0110 D1 import finding).

ALTER TABLE document_types ADD COLUMN sharing_rule TEXT;

ALTER TABLE documents ADD COLUMN sharing_rule_override TEXT;
ALTER TABLE documents ADD COLUMN sharing_rule_override_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN sharing_rule_override_at TEXT;
ALTER TABLE documents ADD COLUMN sharing_rule_override_reason TEXT;
