-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T013 — eventcreate_idempotency_receipts table.
--
-- F6-OWNED idempotency-receipt table. One row per (tenant, source,
-- request_id) where:
--   - source = 'eventcreate_webhook'  → request_id = X-Request-ID header
--   - source = 'eventcreate_csv'      → request_id = SHA-256 of the CSV row
--
-- Why F6-owns-its-own (per data-model.md § 1.4 + plan.md Complexity
-- Tracking #2): F5's `processor_events` table is Stripe-specific — its PK
-- is the Stripe event id `evt_…`, columns are shaped for Stripe payloads,
-- and the relation graph assumes a `payments` row exists. Reusing it for
-- EventCreate webhooks would require a generalising schema refactor with
-- non-trivial blast radius across F5. Per Constitution Principle III
-- bounded-context discipline, each integration owns its own idempotency
-- surface. Future generalisation into a shared `webhook_idempotency_receipts`
-- table can be reconsidered if/when a 4th integration arrives.
--
-- RLS+FORCE policy lives INLINE in this migration (rather than 0133)
-- because this table lands after the RLS bundle. Same shape as the other
-- 3 F6 tables: FOR ALL TO chamber_app + USING + WITH CHECK on tenant_id.
--
-- TTL sweep (Phase 10 T115 + T116): daily cron deletes rows where
-- `ttl_expires_at < NOW()`. The partial index keeps cleanup queries
-- bounded to rows nearing expiry (within 1 day of TTL) — at SweCham scale
-- the table holds ~200 rows in flight after sweep.
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.4.
-- ---------------------------------------------------------------------------

CREATE TABLE "eventcreate_idempotency_receipts" (
  "tenant_id"        text NOT NULL,
  "source"           text NOT NULL,
  "request_id"       text NOT NULL,
  "processed_at"     timestamptz NOT NULL DEFAULT now(),
  -- 7-day TTL. Default at the row level so callers don't have to compute
  -- the expiry — the Drizzle adapter can `INSERT ... ON CONFLICT DO NOTHING`
  -- with only the 3 PK fields.
  "ttl_expires_at"   timestamptz NOT NULL DEFAULT now() + INTERVAL '7 days',

  CONSTRAINT "eventcreate_idempotency_receipts_pk"
    PRIMARY KEY ("tenant_id", "source", "request_id"),

  CONSTRAINT "eventcreate_idempotency_receipts_source_check"
    CHECK ("source" IN ('eventcreate_webhook','eventcreate_csv'))
);--> statement-breakpoint

-- Partial index for the daily TTL sweep (Phase 10 T115). Selects only rows
-- about to expire so the cron's DELETE scan stays small.
CREATE INDEX "eventcreate_idempotency_receipts_ttl_idx"
  ON "eventcreate_idempotency_receipts" ("ttl_expires_at")
  WHERE "ttl_expires_at" < now() + INTERVAL '1 day';--> statement-breakpoint

-- --- RLS + FORCE + policy (Constitution Principle I clause 2) --------------
ALTER TABLE "eventcreate_idempotency_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eventcreate_idempotency_receipts" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_eventcreate_idempotency_receipts"
  ON "eventcreate_idempotency_receipts"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- Grants for chamber_app role -------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "eventcreate_idempotency_receipts"
  TO chamber_app;--> statement-breakpoint
