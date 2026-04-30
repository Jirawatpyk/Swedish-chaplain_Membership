-- F7 audit_event_type enum extension (37 new values).
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block that also
-- uses the newly-added value. Each ADD is wrapped in an idempotent DO block
-- with a pg_enum existence check so re-running the migration is a no-op —
-- same pattern as F2 migration 0007 + F3 migration 0010 + F4 migration 0014.
--
-- The TypeScript enum literal list lives in
-- `src/modules/broadcasts/application/ports/audit-port.ts` (F7_AUDIT_EVENT_TYPES).
-- This file is the authoritative DB source for the 37 F7 additions.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_drafted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_drafted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_submitted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_submitted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_quota_blocked'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_quota_blocked';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_empty_segment_blocked'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_empty_segment_blocked';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_rate_limit_exceeded'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_rate_limit_exceeded';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_not_in_plan'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_not_in_plan';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_immutable_after_submit'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_immutable_after_submit';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_subject_too_long'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_subject_too_long';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_body_too_large'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_body_too_large';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_body_unsafe_html'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_body_unsafe_html';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_audience_too_large'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_audience_too_large';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_custom_recipient_unknown'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_custom_recipient_unknown';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_member_missing_primary_contact_email'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_member_missing_primary_contact_email';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_missing_primary_contact'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_missing_primary_contact';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_member_halted_pending_review'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_member_halted_pending_review';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_approved'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_approved';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_rejected'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_rejected';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_cancelled'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_cancelled';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_cancel_too_late'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_cancel_too_late';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_send_started'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_send_started';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_send_timeout_completed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_send_timeout_completed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_sent'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_sent';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_quota_consumed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_quota_consumed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_failed_to_dispatch'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_failed_to_dispatch';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_resend_resource_missing'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_resend_resource_missing';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_concurrent_action_blocked'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_concurrent_action_blocked';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_cross_member_probe'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_cross_member_probe';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_cross_tenant_probe'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_cross_tenant_probe';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_unsubscribed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_unsubscribed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_unsubscribe_token_invalid'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_unsubscribe_token_invalid';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_suppression_applied'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_suppression_applied';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_complaint_received'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_complaint_received';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_webhook_signature_rejected'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_webhook_signature_rejected';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_sent_with_expired_member_plan'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_sent_with_expired_member_plan';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_complaint_rate_per_broadcast_breach'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_complaint_rate_per_broadcast_breach';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_member_dispatch_resumed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_member_dispatch_resumed';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_acknowledged_broadcasts_terms'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_acknowledged_broadcasts_terms';
  END IF;
END$$;
