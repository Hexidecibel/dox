-- Renewal alert lead time: how far ahead of a due date the owner is warned.
--
-- WHY. Client SME ruling 2026-09-14: some clients want three months' warning
-- so they can start chasing suppliers; others want one month so suppliers are
-- not chased about a certificate that cannot be renewed yet. The engine used
-- one code constant (60 days) for every tenant and every document.
--
-- TWO LEVELS, BOTH NULLABLE, NULL MEANS INHERIT:
--   document_types.renewal_alert_lead_days  -> overrides the tenant for that type
--   tenants.renewal_alert_lead_days         -> the organisation's number
--   neither                                 -> the code default (60)
-- A stored value is there because a named admin chose it; stamping 60 onto
-- every row would make "60 because nobody said" indistinguishable from "60
-- because QA decided" (the same reasoning as 0096's renewal_interval_months).
--
-- RANGE 7..365, enforced here AND in shared/renewalLeadTime.ts. Below a week
-- the 7-day re-alert cooldown can leave an owner one mail before the date
-- passes; above a year every annual document is permanently "expiring".
--
-- WHAT THIS DOES NOT CHANGE: whether a type renews (0097 renewal_policy), when
-- a document is due (shared/renewalPeriod.ts), who is mailed (0091
-- owner_routes), or the re-alert ledger (0091 renewal_alert_state). The
-- Renewals dashboard look-ahead stays a view filter and never changes mail.
--
-- WHO / WHEN: *_updated_at / *_updated_by mirror 0093's spec_unit_policy_*
-- stamps; every change also writes an audit_log row.
--
-- Zero rows written: every tenant keeps exactly today's 60-day behaviour until
-- an admin changes it. Comment header is ASCII-only on purpose (see the 0110
-- note about D1's import API and non-ASCII comment headers).

ALTER TABLE tenants ADD COLUMN renewal_alert_lead_days INTEGER
  CHECK (renewal_alert_lead_days IS NULL OR renewal_alert_lead_days BETWEEN 7 AND 365);
ALTER TABLE tenants ADD COLUMN renewal_alert_lead_updated_at TEXT;
ALTER TABLE tenants ADD COLUMN renewal_alert_lead_updated_by TEXT;

ALTER TABLE document_types ADD COLUMN renewal_alert_lead_days INTEGER
  CHECK (renewal_alert_lead_days IS NULL OR renewal_alert_lead_days BETWEEN 7 AND 365);
ALTER TABLE document_types ADD COLUMN renewal_alert_lead_updated_at TEXT;
ALTER TABLE document_types ADD COLUMN renewal_alert_lead_updated_by TEXT;
