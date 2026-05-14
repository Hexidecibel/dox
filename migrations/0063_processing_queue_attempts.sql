-- Track how many times a queue item has been reset from `processing` back
-- to `queued` after going stale. The worker bumps this via the results
-- endpoint; once it crosses MAX_ATTEMPTS the API forces the item to `error`
-- instead of looping forever.

ALTER TABLE processing_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
