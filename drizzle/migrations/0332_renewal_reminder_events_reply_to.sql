-- 0332 — #707: a renewal reminder's Reply-To, snapshotted on its reminder row.
--
-- The reminder event id is Resend's Idempotency-Key (spec 141), and Resend
-- answers a repeat with a DIFFERENT request with 409
-- invalid_idempotent_request. So the retry must send the Reply-To the first
-- attempt sent, not the tenant's current tenant_renewal_settings.reply_to_*:
-- the dispatcher copies the tenant value onto the row when it inserts it, and
-- both the first attempt and the retry read it from the row.
--
-- No backfill: a row created before this migration sent no Reply-To, and NULL
-- is exactly that, so a retry across the deploy stays identical.
--
-- The values are the TENANT's own reply-to address and display name, not
-- member PII, so the member erasure cascade does not touch them.
--
-- Safe before the code that uses it deploys: two nullable columns, unused by
-- the old code. No lock beyond the brief ACCESS EXCLUSIVE of ADD COLUMN
-- without a default (catalog-only).
ALTER TABLE "renewal_reminder_events"
  ADD COLUMN IF NOT EXISTS "reply_to_email" text,
  ADD COLUMN IF NOT EXISTS "reply_to_display_name" text;
