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
-- The values are the TENANT's renewal reply-to, not member data, so the
-- member erasure cascade does not touch them. They MAY name a staff member
-- (jane@chamber…), and they are not bound to a user id, so the user erasure
-- cascade cannot find them either. A staff erasure request is handled by the
-- tenant changing tenant_renewal_settings.reply_to_* and clearing the
-- snapshots by hand (docs/runbooks/member-erasure.md § Staff reply-to). The
-- snapshot keeps the row's retention (docs/compliance/processing-records.md,
-- F8): it is the record of the Reply-To a reminder actually carried.
--
-- Safe before the code that uses it deploys: two nullable columns, unused by
-- the old code; no default, so a catalog-only change. Its brief ACCESS
-- EXCLUSIVE lock is capped at 5 s so a long reminder transaction cannot queue
-- the table behind it: on a timeout the deploy fails and the old one serves.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "renewal_reminder_events"
  ADD COLUMN IF NOT EXISTS "reply_to_email" text,
  ADD COLUMN IF NOT EXISTS "reply_to_display_name" text;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
COMMENT ON COLUMN "renewal_reminder_events"."reply_to_email" IS
  '#707: the Reply-To address the first attempt sent (tenant_renewal_settings.reply_to_email at insert); the retry sends it. NULL = none.';--> statement-breakpoint
COMMENT ON COLUMN "renewal_reminder_events"."reply_to_display_name" IS
  '#707: the Reply-To display name the first attempt sent; the retry sends it. NULL = none.';
