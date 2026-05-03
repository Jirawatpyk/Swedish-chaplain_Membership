-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T024 — consumed_link_tokens table.
--
-- Token-replay primitive for renewal-link tokens (research.md R1
-- HMAC-SHA256 + R16 dual-key rotation). PK is `(tenant_id,
-- token_sha256)` — token cannot be reused even across tenants because
-- the sha256 includes the tenant id in its payload. Pruned weekly by
-- the housekeeping cron (per docs/runbooks/cron-jobs.md F8 token-prune
-- entry); rows >60d old are deleted.
--
-- Source of truth: data-model.md § 2.8.
-- ---------------------------------------------------------------------------

CREATE TABLE "consumed_link_tokens" (
  "tenant_id"             text        NOT NULL,
  -- SHA256 of the full token bytes — bytea exact match makes lookups
  -- O(log n) on the PK index.
  "token_sha256"          bytea       NOT NULL,
  "consumed_at"           timestamptz NOT NULL DEFAULT now(),
  "consumed_by_member_id" uuid        NOT NULL,
  "cycle_id"              uuid        NOT NULL,

  CONSTRAINT "consumed_link_tokens_pk"
    PRIMARY KEY ("tenant_id", "token_sha256"),

  -- token_sha256 MUST be exactly 32 bytes (SHA256 digest length).
  CONSTRAINT "consumed_link_tokens_sha256_length_check"
    CHECK (length("token_sha256") = 32)
);--> statement-breakpoint

-- TTL cleanup cursor — weekly housekeeping prunes rows >60d old via
-- range scan on this index.
CREATE INDEX "consumed_link_tokens_age_idx"
  ON "consumed_link_tokens" ("consumed_at");--> statement-breakpoint

ALTER TABLE "consumed_link_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consumed_link_tokens" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_consumed_link_tokens"
  ON "consumed_link_tokens"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, DELETE
  ON TABLE "consumed_link_tokens"
  TO chamber_app;--> statement-breakpoint
-- No UPDATE — single-use token rows are immutable once written.
