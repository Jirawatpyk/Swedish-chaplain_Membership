-- ---------------------------------------------------------------------------
-- 0241 — F5 refund-lifecycle bugfix: audit_event_type extension.
--
-- Adds one genuinely-new F5 audit event type:
--   `auto_refund_failed_needs_manual_reconcile` (retention 10y — money-not-
--   returned forensic, Thai RD §87/3 tax-document-adjacent).
--
-- Emitted by `processRefundUpdated` / the confirm-payment stale-refund tail
-- (CRITICAL-2) when a `charge.refund.updated(failed|canceled)` arrives for a
-- payment auto-refunded on a stale invoice: Stripe reports the refund did NOT
-- reach the customer, yet the payment shows `auto_refunded`. The event pages
-- ops for manual reconciliation via the runbook.
--
-- The webhook-driven SUCCEEDED finalisation does NOT need a new enum value —
-- it reuses `refund_succeeded` with a new TS-only discriminated `path` arm
-- (`webhook_refund_updated`). No pg_enum change for that path.
--
-- Pattern: idempotent `DO $$ ALTER TYPE ... ADD VALUE ...` (matches
-- 0040/0043/0199 precedent) so re-running is a no-op. Forward-only: enum
-- values cannot be removed. PG 12+ permits ADD VALUE inside drizzle's
-- per-migration tx as long as the value is not USED in the same tx.
--
-- Registered in lockstep with:
--   - `auditEventTypeEnum` tuple (src/modules/auth/infrastructure/db/schema.ts)
--   - `F5AuditEventType` union + `F5_AUDIT_RETENTION_YEARS` (= 10) +
--     `F5AuditPayloadByType` (src/modules/payments/application/ports/audit-port.ts)
--   - i18n `audit.eventType.auto_refund_failed_needs_manual_reconcile`
--     (en/th/sv) — `audit-event-label-coverage.test` enforces it
--   - parity test `F5_PREFIXES` extended with `auto_refund_`
--     (tests/integration/payments/audit-event-type-parity.test.ts)
--
-- Scope note: this is a post-009-spec go-live bugfix addition — it is
-- intentionally NOT counted in `scripts/check-audit-event-count.ts`
-- `F5_MIGRATIONS` (which tracks the original "20 F5 spec events" narrative).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'auto_refund_failed_needs_manual_reconcile';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
