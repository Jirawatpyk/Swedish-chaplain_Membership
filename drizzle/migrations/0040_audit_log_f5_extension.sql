-- ---------------------------------------------------------------------------
-- F5 — audit_event_type enum extension (16 new values)
--
-- Per Main-agent Gate Decision #2 (specs/009-online-payment/tasks.md §
-- Implementation Decisions). Postgres forbids `ALTER TYPE … ADD VALUE`
-- inside a transaction block that also USES the newly-added value —
-- separating into its own migration keeps each atomic.
--
-- Idempotent: `DO $$ ... EXCEPTION WHEN duplicate_object $$` wraps
-- each ADD, so re-running is a no-op. Forward-only: enum values
-- cannot be removed.
--
-- Keep synced with `auditEventTypeEnum` in
-- `src/modules/auth/infrastructure/db/schema.ts` (sub-batch D T035).
--
-- The 16 values are also listed in tasks.md § Implementation Decisions
-- #5 and specs/009-online-payment/spec.md FR-020.
-- ---------------------------------------------------------------------------

-- Payment lifecycle (4)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_initiated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_succeeded'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_canceled'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Payment auto-refund (2 — edge cases per FR-011a + spec § Edge Cases)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_auto_refunded_stale_invoice'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_auto_refunded_concurrent_manual_mark'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Payment environment + tenant isolation (2)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_environment_mismatch'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_cross_tenant_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Refund lifecycle (3)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'refund_initiated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'refund_succeeded'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'refund_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Out-of-band refund detection (FR-011a, 1)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'out_of_band_refund_detected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Webhook security + version (2)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_signature_rejected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_api_version_mismatch'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Tenant configuration (2)
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'tenant_payment_settings_updated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'online_payment_toggled'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
