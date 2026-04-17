-- ---------------------------------------------------------------------------
-- F3 — audit_event_type enum extension (23 new values)
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block that also
-- uses the newly-added value. Each ADD is wrapped in an idempotent DO block
-- with a pg_enum existence check so re-running the migration is a no-op —
-- same pattern as F2 migration 0007.
--
-- The TypeScript enum literal list lives in
-- `src/modules/auth/infrastructure/db/schema.ts` (auditEventTypeEnum).
-- This file is the authoritative source for the 23 F3 additions.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_created'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_created';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_updated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_plan_changed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_plan_changed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_primary_contact_changed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_primary_contact_changed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_status_changed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_status_changed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_archived'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_archived';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_undeleted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_undeleted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'contact_created'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'contact_created';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'contact_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'contact_updated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'contact_removed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'contact_removed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_self_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_self_updated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_self_update_forbidden'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_self_update_forbidden';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_cross_tenant_probe'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_cross_tenant_probe';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_bundle_changed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_bundle_changed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_contact_email_changed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_contact_email_changed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'user_sessions_revoked'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'user_sessions_revoked';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'email_verification_sent'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'email_verification_sent';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'email_change_notification_sent_to_old_address'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'email_change_notification_sent_to_old_address';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_email_change_reverted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_email_change_reverted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'email_verification_resent'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'email_verification_resent';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'email_dispatch_failed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'email_dispatch_failed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'invitation_bounced'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'invitation_bounced';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'bulk_action_rate_limit_exceeded'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'bulk_action_rate_limit_exceeded';
  END IF;
END$$;
