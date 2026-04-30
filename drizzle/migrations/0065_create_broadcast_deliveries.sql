-- ---------------------------------------------------------------------------
-- F7 — broadcast_deliveries table (T012 per specs/010-email-broadcast/tasks.md).
--
-- One row per Resend webhook delivery event (per recipient × per broadcast).
-- Insert-only; never updated. Idempotency primitive: UNIQUE
-- (tenant_id, resend_event_id) — FR-025 webhook replay safety.
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.2 + § 4.4.
--
-- Append-only invariant enforced via `broadcast_deliveries_no_update` +
-- `broadcast_deliveries_no_delete` triggers (data-model § 4.4). On
-- member-erasure (Art. 17), `recipient_member_id` is set NULL but the row
-- is RETAINED for record-of-processing per PDPA §39 + GDPR Art. 30.
-- ---------------------------------------------------------------------------

-- --- 1. Enum: broadcast_delivery_status -------------------------------------

CREATE TYPE "broadcast_delivery_status" AS ENUM (
  'sent',
  'delivered',
  'bounced',
  'soft_bounced',
  'complained'
);--> statement-breakpoint

-- --- 2. broadcast_deliveries table ------------------------------------------

CREATE TABLE "broadcast_deliveries" (
  "tenant_id"                              text NOT NULL,
  "delivery_id"                            uuid NOT NULL DEFAULT gen_random_uuid(),

  "broadcast_id"                           uuid NOT NULL,                    -- logical FK only (composite PK on broadcasts)
  "resend_event_id"                        text NOT NULL,
  "resend_message_id"                      text NOT NULL,

  "recipient_email_lower"                  text NOT NULL,
  "recipient_member_id"                    uuid,                              -- nullable; SET NULL on Art. 17 erasure
  "recipient_member_lookup_attempted_at"   timestamp with time zone,

  "status"                                 "broadcast_delivery_status" NOT NULL,
  "event_timestamp"                        timestamp with time zone NOT NULL,
  "error_message"                          text,
  "bounce_type"                            text,                              -- 'hard' | 'soft' (split for FR-027 routing)

  "created_at"                             timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "broadcast_deliveries_pkey" PRIMARY KEY ("tenant_id", "delivery_id")
);--> statement-breakpoint

-- --- 3. Indexes -------------------------------------------------------------

-- FR-025: webhook idempotency primitive
CREATE UNIQUE INDEX "broadcast_deliveries_resend_event_id_uniq"
  ON "broadcast_deliveries" ("tenant_id", "resend_event_id");--> statement-breakpoint

-- Per-broadcast aggregation (admin queue + detail page delivery summary)
CREATE INDEX "broadcast_deliveries_broadcast_status_idx"
  ON "broadcast_deliveries" ("tenant_id", "broadcast_id", "status");--> statement-breakpoint

-- Recipient lookup for member detail timeline
CREATE INDEX "broadcast_deliveries_recipient_lookup_idx"
  ON "broadcast_deliveries" ("tenant_id", "recipient_email_lower");--> statement-breakpoint

-- --- 4. Row-Level Security --------------------------------------------------

ALTER TABLE "broadcast_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_deliveries"
  ON "broadcast_deliveries"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 5. Append-only triggers (data-model.md § 4.4) --------------------------
-- `broadcast_deliveries` is an audit trail of Resend webhook events. Rows
-- are inserted by the webhook handler (idempotent via UNIQUE
-- (tenant_id, resend_event_id) ON CONFLICT DO NOTHING) and NEVER updated
-- or deleted. Cascade hooks for Art. 17 erasure update `recipient_member_id`
-- via a DEDICATED `setMemberIdNull` use-case which uses
-- `ALTER TRIGGER ... DISABLE`/`ENABLE` to bypass these triggers — the same
-- pattern as F1's audit_log_no_update + F4's invoices_immutable triggers.

CREATE OR REPLACE FUNCTION broadcast_deliveries_append_only_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'broadcast_deliveries_append_only'
    USING ERRCODE = 'check_violation',
          HINT    = 'broadcast_deliveries rows are insert-only (audit trail).';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER broadcast_deliveries_no_update
  BEFORE UPDATE ON broadcast_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_deliveries_append_only_fn();--> statement-breakpoint

CREATE TRIGGER broadcast_deliveries_no_delete
  BEFORE DELETE ON broadcast_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_deliveries_append_only_fn();--> statement-breakpoint

-- --- 6. Grants for chamber_app role -----------------------------------------

GRANT SELECT, INSERT ON TABLE "broadcast_deliveries" TO chamber_app;--> statement-breakpoint
-- NOTE: no UPDATE/DELETE grants — append-only triggers would block them
-- anyway, but the absent grants make the intent explicit at role level.
