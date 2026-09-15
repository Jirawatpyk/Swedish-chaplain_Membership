-- ---------------------------------------------------------------------------
-- Migration 0300 — F114 Member Portal: Approval Workflow for Member Changes
-- (PR-1 foundation). specs/114-member-change-approval/data-model.md § 1, § 2,
-- § 5; research R2 / R3 / R9 / R11.
--
-- Creates:
--   - member_change_requests        (one row per request; one PENDING row per
--                                    submitting person — partial unique index)
--   - member_change_request_fields  (one row per proposed field or address
--                                    group; jsonb seen / proposed values)
--   - tenant_member_settings.member_change_approval_enabled (the per-tenant
--                                    switch, default false — a new tenant
--                                    keeps the immediate F3 path)
--
-- RLS: both new tables get ENABLE + FORCE + the strict FOR ALL TO chamber_app
-- policy (migration 0209 pattern). chamber_app is NOBYPASSRLS, and the TRUE
-- second arg to current_setting() returns NULL when app.current_tenant is
-- unset -> zero rows visible (secure-by-default). Both tables are registered
-- in scripts/check-multi-tenant-ready.ts SCOPED_TABLES.
--
-- FKs: EVERY child FK is composite on tenant_id — the member and contact
-- FKs like every other member-child table, and (review round 1) the field
-- rows' FK + the replaced_by self-FK too, through UNIQUE (tenant_id, id) on
-- the parent: referential-integrity checks BYPASS row security, so a
-- single-column FK would let a row of tenant B reference a request of
-- tenant A; the composite form makes the DB refuse it. ON DELETE CASCADE on
-- the member + contact FKs: production never hard-deletes either — FR-030
-- erasure SCRUBS in place (the values are sentinelised, rows kept). NOTE:
-- that scrub adapter is US4 / T078 (PR-2) and is NOT yet implemented in
-- PR-1; until it merges, `seen_value` / `proposed_value` / `decision_reason`
-- / `decision_note` are outside the erasure path — quickstart § 3 makes T078
-- a precondition of the flag flip. A hard delete only happens for test
-- tenants and dummy rows. The two user FKs carry no ON DELETE clause
-- (NO ACTION — the default; like RESTRICT, but checked at the END OF THE STATEMENT, not at commit — neither FK is DEFERRABLE): staff accounts
-- are disabled, never deleted (FR-026), and the recorded reviewer /
-- submitter must survive.
--
-- The seven enum values this feature needs (audit_event_type +5,
-- notification_type +2) live in the ENUM-ONLY file 0301 — the run-migrations
-- pre-pass replays ADD VALUE in AUTOCOMMIT (scripts/lib/enum-migration-guard.ts,
-- the 0230 incident), and the repo convention since 0292 keeps those files free
-- of other DDL.
--
-- Rollback (quickstart § 3 layer 3): DROP TABLE member_change_request_fields,
-- member_change_requests; ALTER TABLE tenant_member_settings DROP COLUMN
-- member_change_approval_enabled. The enum values (0301) are irreversible.
-- ---------------------------------------------------------------------------

-- --- 1. member_change_requests ---------------------------------------------

CREATE TABLE "member_change_requests" (
  "id"                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                     text        NOT NULL,
  "member_id"                     uuid        NOT NULL,
  "submitted_by_user_id"          uuid        NOT NULL,
  "submitted_by_contact_id"       uuid        NOT NULL,
  "submitter_role_at_submission"  text        NOT NULL
                                    CHECK ("submitter_role_at_submission" IN ('primary', 'secondary')),
  "scope"                         text        NOT NULL
                                    CHECK ("scope" IN ('company', 'own_contact', 'mixed')),
  "state"                         text        NOT NULL
                                    CHECK ("state" IN ('pending', 'decided', 'withdrawn')),
  "outcome"                       text        NULL
                                    CHECK ("outcome" IN ('approved', 'partially_approved', 'rejected')),
  "withdrawn_reason"              text        NULL
                                    CHECK ("withdrawn_reason" IN ('member', 'replaced', 'erasure')),
  "replaced_by_request_id"        uuid        NULL,
  "submitted_at"                  timestamptz NOT NULL DEFAULT now(),
  "staff_notified_at"             timestamptz NULL,
  "decided_at"                    timestamptz NULL,
  "decided_by_user_id"            uuid        NULL,
  "decision_reason"               text        NULL
                                    CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 1 AND 1000),
  "decision_note"                 text        NULL
                                    CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 1000),
  "withdrawn_at"                  timestamptz NULL,
  "outcome_acknowledged_at"       timestamptz NULL,
  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "member_change_requests_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id") ON DELETE CASCADE,
  CONSTRAINT "member_change_requests_submitter_contact_fk"
    FOREIGN KEY ("tenant_id", "submitted_by_contact_id")
    REFERENCES "contacts" ("tenant_id", "contact_id") ON DELETE CASCADE,
  CONSTRAINT "member_change_requests_submitter_user_fk"
    FOREIGN KEY ("submitted_by_user_id") REFERENCES "users" ("id"),
  CONSTRAINT "member_change_requests_decided_by_user_fk"
    FOREIGN KEY ("decided_by_user_id") REFERENCES "users" ("id"),
  -- the composite target for the two child FKs (see header)
  CONSTRAINT "member_change_requests_tenant_id_uniq"
    UNIQUE ("tenant_id", "id"),
  -- DEFERRABLE: the replace path (R3) must (1) close the old pending row with
  -- reason 'replaced' + the pointer to the new id — the CHECK below demands
  -- the pointer at that instant — and (2) insert the new pending row; the
  -- partial unique index forbids doing (2) first, and an immediate FK forbids
  -- doing (1) first. Checked at COMMIT, both orders are consistent.
  CONSTRAINT "member_change_requests_replaced_by_fk"
    FOREIGN KEY ("tenant_id", "replaced_by_request_id")
    REFERENCES "member_change_requests" ("tenant_id", "id")
    DEFERRABLE INITIALLY DEFERRED,
  -- state machine (data-model § 4): the decision columns exist iff decided,
  -- the withdrawn reason iff withdrawn, the replacement pointer iff replaced.
  CONSTRAINT "member_change_requests_outcome_iff_decided_ck"
    CHECK (("state" = 'decided') = ("outcome" IS NOT NULL)),
  CONSTRAINT "member_change_requests_decision_iff_decided_ck"
    CHECK (("state" = 'decided') = ("decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL)),
  CONSTRAINT "member_change_requests_reason_iff_withdrawn_ck"
    CHECK (("state" = 'withdrawn') = ("withdrawn_reason" IS NOT NULL)),
  CONSTRAINT "member_change_requests_withdrawn_at_iff_withdrawn_ck"
    CHECK (("state" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)),
  CONSTRAINT "member_change_requests_replaced_iff_reason_ck"
    CHECK (("withdrawn_reason" IS NOT DISTINCT FROM 'replaced') = ("replaced_by_request_id" IS NOT NULL)),
  -- FR-014: a rejection carries a reason; FR-010: only a decision can be
  -- dismissed (both enforced in the use cases — the DB is the last line).
  CONSTRAINT "member_change_requests_reason_iff_rejected_ck"
    CHECK ("outcome" IS DISTINCT FROM 'rejected' OR "decision_reason" IS NOT NULL),
  CONSTRAINT "member_change_requests_ack_iff_decided_ck"
    CHECK ("outcome_acknowledged_at" IS NULL OR "state" = 'decided')
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "member_change_requests" TO chamber_app;--> statement-breakpoint

-- R3 — one PENDING request per submitting person; the submit use case takes
-- the existing pending row FOR UPDATE first, so this index is the DB-layer
-- guarantee for the race that slips past it.
CREATE UNIQUE INDEX "member_change_requests_one_pending_per_submitter"
  ON "member_change_requests" ("tenant_id", "submitted_by_user_id")
  WHERE "state" = 'pending';--> statement-breakpoint

-- queue (pending oldest-first — the query orders ASC, ASC and walks this
-- index backwards), pending count, oldest age (FR-027 / FR-033); `id` is the
-- keyset tiebreak the query orders by
CREATE INDEX "member_change_requests_tenant_state_submitted_idx"
  ON "member_change_requests" ("tenant_id", "state", "submitted_at" DESC, "id" DESC);--> statement-breakpoint

-- per-member history (FR-026)
CREATE INDEX "member_change_requests_tenant_member_idx"
  ON "member_change_requests" ("tenant_id", "member_id", "submitted_at" DESC);--> statement-breakpoint

-- R9 — the durable 24 h cap count per submitter (`countSubmittedSince` in the
-- repo, called by `submitChangeRequest` since T087 / PR-2; PR-1's interim
-- Upstash cap is gone — comment-only edit, the DDL below is unchanged)
CREATE INDEX "member_change_requests_rate_window_idx"
  ON "member_change_requests" ("tenant_id", "submitted_by_user_id", "submitted_at");--> statement-breakpoint

ALTER TABLE "member_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_change_requests" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_member_change_requests"
  ON "member_change_requests"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 2. member_change_request_fields ---------------------------------------
-- One row per proposed field OR address group (`registered_address` /
-- `billing_address` are single keys carrying the whole object). Only fields
-- that differ from the record at submission are stored (FR-005 / FR-007).
-- `field_key` is the Group B constant `PROPOSABLE_FIELD_KEYS` in
-- src/modules/members/domain/change-request/proposable-fields.ts — parity is
-- asserted by tests/unit/members/change-requests/domain-policies.test.ts.

CREATE TABLE "member_change_request_fields" (
  "id"                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             text        NOT NULL,
  "request_id"            uuid        NOT NULL,
  "field_key"             text        NOT NULL
                            CHECK ("field_key" IN ('first_name', 'last_name', 'phone', 'role_title', 'company_name', 'website', 'description', 'registered_address', 'billing_address')),
  "target"                text        NOT NULL
                            CHECK ("target" IN ('member', 'contact')),
  "seen_value"            jsonb       NULL,
  "proposed_value"        jsonb       NULL,
  "outcome"               text        NULL
                            CHECK ("outcome" IN ('approved', 'rejected')),
  "applied_at"            timestamptz NULL,
  "affects_tax_documents" boolean     NOT NULL,
  CONSTRAINT "member_change_request_fields_request_fk"
    FOREIGN KEY ("tenant_id", "request_id")
    REFERENCES "member_change_requests" ("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "member_change_request_fields_request_key_uniq"
    UNIQUE ("request_id", "field_key"),
  CONSTRAINT "member_change_request_fields_applied_iff_approved_ck"
    CHECK (("outcome" IS NOT DISTINCT FROM 'approved') = ("applied_at" IS NOT NULL))
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "member_change_request_fields" TO chamber_app;--> statement-breakpoint

CREATE INDEX "member_change_request_fields_tenant_request_idx"
  ON "member_change_request_fields" ("tenant_id", "request_id");--> statement-breakpoint

ALTER TABLE "member_change_request_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_change_request_fields" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_member_change_request_fields"
  ON "member_change_request_fields"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 3. tenant_member_settings.member_change_approval_enabled --------------
-- R11 — the per-tenant switch (FR-031). Single-shot ADD COLUMN (no IF NOT
-- EXISTS — a second pass fails loudly, the 0209 idempotency posture). Default
-- false: a newly onboarded tenant keeps the immediate self-service path until
-- an admin switches approval on (audited). SweCham is flipped ON by the
-- operator after PR-3 (tasks T114), never by a migration.

ALTER TABLE "tenant_member_settings"
  ADD COLUMN "member_change_approval_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
