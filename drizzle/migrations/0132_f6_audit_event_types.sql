-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T011 — audit_event_type enum extension.
--
-- 35 new F6 audit event types (canonical taxonomy in data-model.md § 4 +
-- contracts/audit-port.md). The TypeScript `F6AuditEventType` closed-union
-- in `src/modules/events/application/ports/audit-port.ts` provides
-- compile-time enforcement; this migration provides DB-level enforcement.
-- Both layers MUST stay in sync — adding a new F6 event type requires
-- both a TS edit AND a migration.
--
-- Without this migration, every F6 audit emit raises:
--   "ERROR: invalid input value for enum audit_event_type"
-- and the strict-transactional ingest (FR-037) rolls back on every
-- webhook delivery. The integration tests in tests/integration/events/
-- depend on this migration applying cleanly.
--
-- Source of truth: contracts/audit-port.md § 1-6 (35 event canonical list).
--
-- Pattern: `DO $$ BEGIN ALTER TYPE … ADD VALUE 'X'; EXCEPTION WHEN
-- duplicate_object THEN NULL; END $$;` per event (F4 precedent migration
-- 0020 introduced this pattern). Each ADD VALUE MUST be its own
-- statement — Postgres restriction. The DO-block makes it idempotent
-- so re-running is a no-op.
--
-- Forward-only: Postgres does not support DROP VALUE from an enum.
-- Adding-only is fine for F6 (we never remove event types — historical
-- audit rows would lose their event_type FK).
-- ---------------------------------------------------------------------------

-- --- Webhook ingest events (8) ---------------------------------------------
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_receipt_verified'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_signature_rejected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_replay_rejected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_duplicate_rejected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_malformed_rejected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_rolled_back'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_secret_grace_used'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_test_invoked'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- Match resolution events (5) -------------------------------------------
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'attendee_matched_member_contact'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'attendee_matched_member_domain'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'attendee_matched_member_fuzzy'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'attendee_non_member'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'attendee_unmatched'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- Quota events (5) -------------------------------------------------------
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'quota_partnership_decremented'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'quota_cultural_decremented'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'quota_credit_back_refund'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'quota_credit_back_archive'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'quota_over_quota_warning'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- Admin action events (10) ----------------------------------------------
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'registration_relinked'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'event_archived'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'event_partner_benefit_toggled'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'event_cultural_event_toggled'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_secret_generated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_secret_rotated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'ingest_disabled_super_admin'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'ingest_disabled_tenant_admin'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_completed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_row_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- Privacy + compliance events (4) ---------------------------------------
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pii_erasure_requested'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pii_erasure_completed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pii_pseudonymised'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pii_pseudonymisation_sweep_run'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- Security events (3) ----------------------------------------------------
-- NOTE: `cross_tenant_probe` already exists from F3 migration 0010
-- (audit_log_f3_extension.sql) as a generic cross-tenant probe event used
-- across F3/F4/F5/F7/F8. F6 reuses the same name — the DO-block makes the
-- add idempotent so this re-add is a safe no-op. Identical pattern for
-- `role_violation_blocked` if previously introduced by a prior feature.
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'cross_tenant_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'role_violation_blocked'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_rate_limit_exceeded'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
