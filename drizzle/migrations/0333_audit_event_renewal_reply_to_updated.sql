-- 0333 — audit_event_type value `renewal_reply_to_updated` (PR B, #707 follow-up).
--
-- Staff set, change or clear the renewal reminder Reply-To
-- (tenant_renewal_settings.reply_to_email / reply_to_display_name) on
-- /admin/settings/renewals/reply-to. The use case writes the row and this
-- audit event in one transaction. F8 retention: 5 years (the column default).
-- The payload keeps the address's domain only, never the address.
--
-- Safe before the code deploys: an unused enum value. Idempotent. Rollback is
-- a forward-fix (an enum value cannot be dropped).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'renewal_reply_to_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'renewal_reply_to_updated';
  END IF;
END$$;
