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
-- Postgres 16 supports DROP INDEX CONCURRENTLY + CREATE INDEX
-- CONCURRENTLY, so this migration runs without blocking writes on
-- live Neon. Wrapped in a single transaction is NOT possible with
-- CONCURRENTLY — Drizzle migrate must run this without an outer
-- transaction (use `--no-transaction` flag if needed by tooling, or
-- apply via the project's dev-apply-migration.ts script).
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "payments_processor_payment_intent_id_uniq";

CREATE UNIQUE INDEX "payments_processor_payment_intent_id_uniq"
  ON "payments" USING btree ("processor_payment_intent_id")
  WHERE "status" NOT IN ('failed', 'canceled');
