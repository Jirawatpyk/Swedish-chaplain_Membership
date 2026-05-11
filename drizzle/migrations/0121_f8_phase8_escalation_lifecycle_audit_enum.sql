-- ---------------------------------------------------------------------------
-- F8 Phase 8 T213 — extend audit_event_type pgEnum with the 2 escalation-
-- task lifecycle events that ship with the Phase 8 admin queue (US6).
--
-- `escalation_task_completed` was added in migration 0102 (Phase 4 Wave
-- I2b) when reset-email-unverified.ts emitted it via webhook-driven task
-- closure. Phase 8 finally ships the admin-driven Done/Skip/Reassign
-- surfaces (T209/T210/T211 use-cases + T215/T216/T217 routes), so the
-- remaining 2 enum values graduate from `_F8_ENUM_DEFERRED` to
-- `F8_ENUM_SHIPPED_TUPLE`.
--
-- Emit sites:
--   * `escalation_task_skipped`     — `skipEscalationTask` use-case
--     (T210). Payload `{task_id, task_type, member_id, cycle_id?,
--     skipped_reason, actor_user_id}` per `F8AuditPayloadShapes`.
--   * `escalation_task_reassigned`  — `reassignEscalationTask` use-case
--     (T211). Payload `{task_id, task_type, member_id, cycle_id?,
--     from_user_id, to_user_id, actor_user_id}`.
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction with other DDL — both statements ship in this migration
-- file (sequential after 0120 silent-skip-audits batch).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'escalation_task_skipped';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'escalation_task_reassigned';--> statement-breakpoint
