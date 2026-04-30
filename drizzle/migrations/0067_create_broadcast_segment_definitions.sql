-- ---------------------------------------------------------------------------
-- F7 — broadcast_segment_definitions table (T014 per specs/010-email-broadcast/tasks.md).
--
-- Read-model snapshot of segment configurations per tenant. Mostly
-- populated by seed migration 0068 (`all_members`, 6 tier presets,
-- `event_attendees_last_90d`, `custom`). Admins MAY add custom-named
-- segments in F7.1 — out of MVP scope.
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.4.
--
-- No write-side DML in MVP — listByTenant + findByDefinitionId are the
-- only Application port methods. F7.1 will introduce upsert + disable.
-- ---------------------------------------------------------------------------

-- --- 1. broadcast_segment_definitions table ---------------------------------

CREATE TABLE "broadcast_segment_definitions" (
  "tenant_id"               text NOT NULL,
  "definition_id"           uuid NOT NULL DEFAULT gen_random_uuid(),
  "segment_type"            "broadcast_segment_type" NOT NULL,
  "display_label_i18n_key"  text NOT NULL,
  "params"                  jsonb,
  "enabled"                 boolean NOT NULL DEFAULT true,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "broadcast_segment_definitions_pkey"
    PRIMARY KEY ("tenant_id", "definition_id")
);--> statement-breakpoint

-- --- 2. Indexes -------------------------------------------------------------

CREATE INDEX "broadcast_segment_defs_tenant_type_idx"
  ON "broadcast_segment_definitions" ("tenant_id", "segment_type");--> statement-breakpoint

-- --- 3. Row-Level Security --------------------------------------------------

ALTER TABLE "broadcast_segment_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_segment_definitions" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_segment_definitions"
  ON "broadcast_segment_definitions"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 4. Grants --------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "broadcast_segment_definitions" TO chamber_app;--> statement-breakpoint
-- DELETE not granted — segment_definitions are presets; F7.1 admin UI
-- will use UPDATE enabled=false to soft-disable instead of delete.
