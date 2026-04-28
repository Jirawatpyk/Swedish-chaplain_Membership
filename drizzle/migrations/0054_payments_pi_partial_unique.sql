-- ---------------------------------------------------------------------------
-- F5 R2 review C-2 (2026-04-27) — Convert
-- `payments_processor_payment_intent_id_uniq` from a GLOBAL unique index
-- to a PARTIAL unique index scoped to non-terminal payment rows.
--
-- Rationale: CLAUDE.md + plan.md describe the concurrent-initiate guard
-- as a "partial unique index on processor_payment_intent_id" + tenant-
-- filtered SELECT FOR UPDATE. The original migration 0033 created it
-- globally, which is stricter than needed and diverges from spec.
-- A partial index aligned with the active-attempt window:
--   - rejects two simultaneous non-terminal rows for the same Stripe PI
--     (true contention case the guard is meant to prevent)
--   - allows historical failed/canceled rows to keep their PI id without
--     blocking re-attempts that get a fresh PI from Stripe
--
-- Application-layer concurrent-initiate guard (drizzle-payments-repo.ts
-- `lockForUpdateByPaymentIntentId`) is unchanged — it still scopes by
-- tenantId. Stripe idempotency key `inv-{invoiceId}-attempt-{n}` is
-- unchanged. This migration only narrows the DB index predicate.
--
-- R3 C-1 (2026-04-28): runs INSIDE drizzle-kit's implicit transaction
-- (`pnpm db:migrate` wraps each migration). DROP + CREATE INDEX
-- without CONCURRENTLY acquires a brief AccessExclusiveLock on the
-- `payments` table for the duration of the build. Acceptable for
-- the F5 single-tenant MVP — `payments` is small at deploy time.
-- For larger tables in future modules, use a separate out-of-band
-- migration with CONCURRENTLY (cannot run inside a transaction).
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "payments_processor_payment_intent_id_uniq";

CREATE UNIQUE INDEX "payments_processor_payment_intent_id_uniq"
  ON "payments" USING btree ("processor_payment_intent_id")
  WHERE "status" NOT IN ('failed', 'canceled');
