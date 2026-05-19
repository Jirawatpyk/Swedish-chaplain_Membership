-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T008 — tenant_webhook_configs table.
--
-- Per-tenant, per-source webhook credentials. One row per (tenant, source).
-- Holds the active HMAC-SHA256 secret + an optional grace secret retained
-- for 24h post-rotation per FR-008 + R7. The webhook signature verifier
-- (T043+T101 in later phases) tries the active secret first, then the
-- grace secret if (grace_rotated_at > NOW() - INTERVAL '24 hours').
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.3.
--
-- One-time-reveal flow (FR-024): the active secret is shown ONCE on
-- generation via the admin wizard (T076 Phase 5), then never again. Admin
-- copies to a password manager + ticks "I've saved this" checkbox before
-- proceeding to Zapier walkthrough. Rotation emits a new active secret +
-- moves the old to grace + clears 24h later by daily cron OR by manual
-- re-rotation (whichever first).
--
-- RLS+FORCE for this table lives in migration 0133.
--
-- enabled=FALSE → webhook handler returns 503 + Retry-After per FR-033
-- (super-admin or tenant-admin can disable ingest without rotating
-- secrets — useful for incident response without breaking Zapier replay).
-- ---------------------------------------------------------------------------

CREATE TABLE "tenant_webhook_configs" (
  "tenant_id"              text NOT NULL,
  "source"                 text NOT NULL,

  -- HMAC-SHA256 secrets — 32-byte random, base64url encoded.
  -- The active secret is the current Zapier-signed key; grace is the
  -- previous active retained for 24h post-rotation. Both fields are
  -- pino-redacted (src/lib/logger.ts T002).
  "webhook_secret_active"  text NOT NULL,
  "webhook_secret_grace"   text,
  "grace_rotated_at"       timestamptz,

  -- Operational toggle. enabled=FALSE returns 503 from the receiver
  -- without disturbing the stored secrets (FR-033).
  "enabled"                boolean NOT NULL DEFAULT true,

  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "last_received_at"       timestamptz,
  "last_rotated_at"        timestamptz,

  CONSTRAINT "tenant_webhook_configs_pk"
    PRIMARY KEY ("tenant_id", "source"),

  CONSTRAINT "tenant_webhook_configs_source_check"
    CHECK ("source" IN ('eventcreate')),

  -- Grace invariants: grace_rotated_at non-NULL iff webhook_secret_grace
  -- non-NULL. Enforced at DB level so a partial rotation cannot persist
  -- a half-state.
  CONSTRAINT "tenant_webhook_configs_grace_invariant"
    CHECK (
      ("webhook_secret_grace" IS NULL AND "grace_rotated_at" IS NULL)
      OR ("webhook_secret_grace" IS NOT NULL AND "grace_rotated_at" IS NOT NULL)
    )
);--> statement-breakpoint

-- Partial index for the daily grace-expiry sweep (Phase 10 + R7).
-- Keeps the scan small (only rows with active grace secret).
CREATE INDEX "tenant_webhook_configs_grace_idx"
  ON "tenant_webhook_configs" ("tenant_id", "source")
  WHERE "webhook_secret_grace" IS NOT NULL;--> statement-breakpoint

-- --- Grants for chamber_app role --------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tenant_webhook_configs"
  TO chamber_app;--> statement-breakpoint
