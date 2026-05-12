-- Doc-R1: per-item LLM-self-rated confidence + per-tenant auto-approve threshold.
--
-- `processing_queue.confidence` is the worker-posted numeric confidence
-- (0.0-1.0) extracted from the LLM's `_confidence` field. This is the LLM's
-- own calibrated guess at how sure it is about the extraction — distinct from
-- the existing `confidence_score` heuristic which is a deterministic post-hoc
-- score derived from field counts.
--
-- `tenants.auto_approve_threshold` opts a tenant into auto-approving queue
-- items whose `confidence` >= the threshold. NULL (default) = disabled, every
-- item still routes through the review queue.

ALTER TABLE processing_queue ADD COLUMN confidence REAL;

ALTER TABLE tenants ADD COLUMN auto_approve_threshold REAL;
