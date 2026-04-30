-- Migration 0047: connector_intake_credentials
--
-- Adds nullable credential columns to `connectors` for the three new
-- Phase B intake paths:
--
--   B2 HTTP POST    : api_token (bearer token for the per-connector
--                     `/drop` endpoint).
--   B3 S3 drop      : r2_bucket_name, r2_access_key_id,
--                     r2_secret_access_key_encrypted (vendor-facing R2
--                     credentials; secret is encrypted with
--                     INTAKE_ENCRYPTION_KEY via
--                     functions/lib/intakeEncryption.ts).
--   B4 Public link  : public_link_token + optional
--                     public_link_expires_at (unix seconds, NULL = no
--                     expiry).
--
-- Plaintext storage of api_token / r2_access_key_id / public_link_token
-- is deliberate: these are connector-scoped credentials the user can
-- rotate from the UI, not user passwords. Only the R2 secret access
-- key is encrypted at rest.
--
-- Purely additive — no defaults, no backfill, no ALTER on existing
-- data. Existing connectors continue to round-trip with these columns
-- NULL.

ALTER TABLE connectors ADD COLUMN api_token TEXT;
ALTER TABLE connectors ADD COLUMN r2_bucket_name TEXT;
ALTER TABLE connectors ADD COLUMN r2_access_key_id TEXT;
ALTER TABLE connectors ADD COLUMN r2_secret_access_key_encrypted TEXT;
ALTER TABLE connectors ADD COLUMN public_link_token TEXT;
ALTER TABLE connectors ADD COLUMN public_link_expires_at INTEGER;
