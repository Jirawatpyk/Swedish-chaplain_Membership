-- 0242 — CRITICAL-1: make credit-note issuance idempotent per refund at the DB layer.
-- Replaces the 0038 non-unique index (redundant once unique). A losing concurrent
-- CN insert unique-violates and rolls back the whole tx → §87 counter-row returns
-- to the pool (no gap). See docs/superpowers/specs/2026-07-11-...#CRITICAL-1.
DROP INDEX IF EXISTS "credit_notes_source_refund_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_source_refund_id_uniq"
  ON "credit_notes" ("tenant_id","source_refund_id")
  WHERE "source_refund_id" IS NOT NULL;--> statement-breakpoint
