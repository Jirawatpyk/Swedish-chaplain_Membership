-- ---------------------------------------------------------------------------
-- F5 Group F Review-Gate — audit_event_type enum extension (Threat F-09)
--
-- Adds 2 rate-limit audit event types so that 429 responses on
-- /api/payments/initiate + /api/payments/[id]/cancel leave a forensic
-- trail in the append-only `audit_log` table (previously only a
-- `logger.warn` line — insufficient for incident response).
--
-- Pattern: one idempotent `DO $$ ALTER TYPE ... ADD VALUE ...` per enum
-- value so re-running is a no-op (matches migration 0040 precedent).
-- Forward-only: enum values cannot be removed.
--
-- Retention: both values carry 5-year retention (Ops event, not tax
-- document) per data-model.md § 7.1 mapping.
--
-- Keep synced with `auditEventTypeEnum` in
-- `src/modules/auth/infrastructure/db/schema.ts` and the F1
-- `AUDIT_EVENT_TYPES` union in `src/modules/auth/domain/audit-event.ts`.
-- ---------------------------------------------------------------------------

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_initiate_rate_limited'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_cancel_rate_limited'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
