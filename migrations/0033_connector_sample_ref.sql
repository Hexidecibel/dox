-- Migration 0033: store R2 key of the sample file uploaded during wizard setup
--
-- Wave 1 of the open-ended field-mapping refactor. When the file-first wizard
-- drops a sample file into R2 during discover-schema, the key is persisted on
-- the connector so the Review step can re-run preview-extraction against the
-- same sample without re-uploading. Nullable — legacy connectors have no sample.

ALTER TABLE connectors ADD COLUMN sample_r2_key TEXT;
