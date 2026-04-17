-- Tinder-style A/B evaluation of text vs VLM extraction results.
-- One row per (queue_item, evaluator) capturing which blind-labeled side
-- they preferred, plus an optional free-text comment for prompt tuning.
--
-- The `a_side` column unblinds the "Method A" / "Method B" label after the
-- fact: the UI randomizes which method is presented as A, then records the
-- mapping here so the aggregate report can attribute wins back to 'text' or
-- 'vlm'. Evaluations belong to the queue item's tenant transitively — we
-- enforce tenant isolation at the API layer, not via a dedicated column, to
-- keep the model small.
CREATE TABLE IF NOT EXISTS extraction_evaluations (
  id TEXT PRIMARY KEY,
  queue_item_id TEXT NOT NULL,
  evaluator_user_id TEXT NOT NULL,
  winner TEXT NOT NULL CHECK (winner IN ('a','b','tie')),
  a_side TEXT NOT NULL CHECK (a_side IN ('text','vlm')),
  comment TEXT,
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (queue_item_id) REFERENCES processing_queue(id) ON DELETE CASCADE,
  UNIQUE (queue_item_id, evaluator_user_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_queue_item ON extraction_evaluations(queue_item_id);
CREATE INDEX IF NOT EXISTS idx_eval_evaluator ON extraction_evaluations(evaluator_user_id);
