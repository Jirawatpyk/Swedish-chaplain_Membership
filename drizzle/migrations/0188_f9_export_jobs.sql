-- ---------------------------------------------------------------------------
-- F9 (T009) — export_jobs table + export_kind / export_status enums
-- (US5 E-Book + US6 GDPR, ships dark in Foundational).
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 4 + research R5.
--
-- Tracks asynchronous artefact generation. Holds NO PII payload — only
-- metadata + the private Blob key + a hash of the short-lived download token.
-- State machine (Domain-enforced):
--   requested → processing → ready → delivered → expired
--                    └──────────── failed ───────────┘
-- Idempotency: a duplicate request with the same idempotency_key returns the
-- existing job rather than generating a second archive (Principle VIII). The
-- worker claims `requested` jobs under a per-(tenant,job) advisory lock and the
-- sweep reclaims stuck `processing` jobs older than a timeout (critique E2).
--
-- NEW enums (CREATE TYPE, not ALTER TYPE ADD VALUE) — safe to create in the
-- same migration as the table since they are brand-new types.
--
-- Tenant isolation: RLS + FORCE + policy + chamber_app GRANT (Principle I).
--
-- Rollback:
--   DROP POLICY "tenant_isolation_on_export_jobs" ON "export_jobs";
--   DROP TABLE "export_jobs";
--   DROP TYPE "export_status"; DROP TYPE "export_kind";
-- ---------------------------------------------------------------------------

CREATE TYPE "export_kind" AS ENUM (
  'gdpr_member_archive',
  'directory_ebook',
  'directory_json',
  'audit_export'
);--> statement-breakpoint

CREATE TYPE "export_status" AS ENUM (
  'requested',
  'processing',
  'ready',
  'delivered',
  'expired',
  'failed'
);--> statement-breakpoint

CREATE TABLE "export_jobs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             text          NOT NULL,
  "kind"                  "export_kind" NOT NULL,
  "subject_member_id"     uuid,
  "requested_by"          uuid          NOT NULL,
  "requested_for_period"  text,
  "status"                "export_status" NOT NULL DEFAULT 'requested',
  "idempotency_key"       text          NOT NULL,
  "blob_key"              text,
  "download_token_hash"   text,
  "expires_at"            timestamptz,
  "error_code"            text,
  "created_at"            timestamptz   NOT NULL DEFAULT now(),
  "updated_at"            timestamptz   NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "export_jobs_tenant_idempotency_uniq"
  ON "export_jobs" ("tenant_id", "idempotency_key");--> statement-breakpoint

-- Worker claim query scans (tenant_id, status) for `requested` / stuck
-- `processing` rows.
CREATE INDEX "export_jobs_tenant_status_idx"
  ON "export_jobs" ("tenant_id", "status");--> statement-breakpoint

ALTER TABLE "export_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_jobs" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_export_jobs"
  ON "export_jobs"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "export_jobs"
  TO chamber_app;
