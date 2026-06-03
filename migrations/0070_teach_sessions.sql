-- Learning Interface: conversational "teach the model" sessions.
--
-- A domain expert (SME) teaches the system how to read a supplier's documents
-- through a guided conversation. The AI surfaces clustered extraction
-- ambiguities (from the uncertainty analyzer), asks grounded open-interview
-- questions, the SME answers in prose, the AI synthesizes the answers into
-- extraction instructions + few-shot examples, and on confirm the proposal is
-- written to the (supplier_id, document_type_id) extraction profile
-- (supplier_extraction_instructions + extraction_examples).
--
-- teach_sessions holds the lifecycle + the synthesized proposal; teach_messages
-- is the running transcript (ai / sme / system turns).

CREATE TABLE IF NOT EXISTS teach_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  -- open: collecting answers | synthesized: proposal drafted, awaiting confirm
  -- confirmed: written to profile | abandoned: discarded
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'synthesized', 'confirmed', 'abandoned')),
  -- JSON array of UncertaintyIssue captured at session start.
  issues_json TEXT,
  -- Synthesized proposal (set when status -> synthesized).
  proposed_instructions TEXT,
  -- JSON array of { field, value, note } examples.
  proposed_examples_json TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teach_sessions_scope
  ON teach_sessions(tenant_id, supplier_id, document_type_id);

CREATE TABLE IF NOT EXISTS teach_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES teach_sessions(id) ON DELETE CASCADE,
  -- ai: model question/follow-up | sme: expert answer | system: bookkeeping
  role TEXT NOT NULL CHECK (role IN ('ai', 'sme', 'system')),
  content TEXT NOT NULL,
  -- Optional JSON: which issues/example values this message references.
  grounding_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teach_messages_session
  ON teach_messages(session_id, created_at);
