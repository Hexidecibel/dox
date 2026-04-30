-- Migration 0051: connector_r2_cf_token_id
--
-- Phase B3 — adds the Cloudflare-side ID of the R2 API token that was
-- minted for this connector's per-bucket S3 drop. The token ID is
-- needed to revoke the token during rotation (DELETE
-- /accounts/<id>/tokens/<id>) — the access_key_id alone isn't
-- sufficient to address the token via the CF API.
--
-- Purely additive — NULL on every existing row. Lazy provisioning
-- (POST /api/connectors/<id>/r2/provision) populates it on first
-- bring-up; legacy connectors stay NULL until the user provisions.
--
-- The plaintext access_key_id and encrypted secret already live in
-- migration 0047's columns. This row is the third leg — without it,
-- rotation can create a new token but can't revoke the old one,
-- leaving stale tokens floating in the CF account.

ALTER TABLE connectors ADD COLUMN r2_cf_token_id TEXT;
