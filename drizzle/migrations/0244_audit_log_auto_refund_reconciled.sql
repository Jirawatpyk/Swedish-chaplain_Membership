-- ---------------------------------------------------------------------------
-- 0244 — F5 go-live CF-2: audit_event_type extension.
--
-- Adds one genuinely-new F5 audit event type:
--   `auto_refund_reconciled` (retention 10y — mirrors the failure forensic it
--   resolves; money-trail-adjacent, Thai RD §87/3 tax-document-adjacent).
--
-- Emitted by the `resolveFailedAutoRefund` use-case when an admin marks a
-- permanently-failed stale-invoice auto-refund as MANUALLY reconciled (they
-- returned the funds out-of-band via a manual credit note / the Stripe
-- Dashboard, per docs/runbooks/out-of-band-refund.md). It is the append-only
-- "resolved" counterpart to `auto_refund_failed_needs_manual_reconcile`
-- (migration 0241): once it exists for an invoice, the correlated
-- `findStaleInvoiceAutoRefund.failed` read becomes failure-AND-not-reconciled,
-- so the persistent admin `AutoRefundFailedAlert` clears + the member void
-- banner reverts from "being reconciled" to the (now-true) "refunded" copy.
--
-- Pattern: idempotent `DO $$ ALTER TYPE ... ADD VALUE ...` (matches
-- 0040/0043/0199/0241 precedent) so re-running is a no-op. Forward-only: enum
-- values cannot be removed. PG 12+ permits ADD VALUE inside drizzle's
-- per-migration tx as long as the value is not USED in the same tx.
--
-- Registered in lockstep with:
--   - `auditEventTypeEnum` tuple (src/modules/auth/infrastructure/db/schema.ts)
--   - `F5AuditEventType` union + `F5_AUDIT_RETENTION_YEARS` (= 10) +
--     `F5AuditPayloadByType` (src/modules/payments/application/ports/audit-port.ts)
--   - i18n `audit.eventType.auto_refund_reconciled` (en/th/sv) —
--     `audit-event-label-coverage.test` enforces it
--   - the parity test's `auto_refund_` prefix already covers this name
--     (tests/integration/payments/audit-event-type-parity.test.ts)
--
-- Scope note: this is a post-009-spec go-live addition — it is intentionally
-- NOT counted in `scripts/check-audit-event-count.ts` `F5_MIGRATIONS` (which
-- tracks the original "20 F5 spec events" narrative).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'auto_refund_reconciled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
