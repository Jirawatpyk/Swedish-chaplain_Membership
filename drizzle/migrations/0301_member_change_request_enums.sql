-- 0301 — F114 Member Portal: Approval Workflow for Member Changes — the seven
-- enum values the feature's use cases INSERT across its three PRs
-- (data-model.md § 6). PR-1 emits `…_submitted`, `…_decided`, `…_withdrawn`
-- (replace) and both notification types; `…_rate_limited` (T087, PR-2) and
-- `…_setting_changed` (US6, PR-3) are declared here so ONE enum migration
-- carries the feature (ADD VALUE is irreversible and cannot run in a tx).
--
-- audit_event_type (+5), all emitted via the members `AuditPort` on the SAME
-- tx as the state change (contracts/notifications-and-audit.md § 2). Payloads
-- carry ids, field keys and outcomes — NEVER a proposed or seen value. Member
-- key rule: `member_id` (the 0009 `last_activity_at` trigger key) on submit
-- and withdraw-by-member because that IS member activity; `related_member_id`
-- on decide / replaced / erasure closure so a staff or system act does not
-- refresh the member's recency (#337 rule). `actor_role` = the session role.
-- Retention 5 years (F3 default — not tax-document events).
--
--   member_change_request_submitted        member user   { member_id, request_id, contact_id, scope, field_keys[], replaced_request_id, coalesced }
--   member_change_request_decided          reviewer      { related_member_id, request_id, contact_id, scope, outcome, fields: [{key, outcome}], reason_length, member_notified, member_notification_skipped? }
--   member_change_request_withdrawn        member/system { member_id | related_member_id, request_id, contact_id, scope, withdrawn_reason, replaced_by_request_id? }
--   member_change_request_rate_limited     member user   { member_id, window_count, retry_after_seconds }
--   member_change_approval_setting_changed staff         { previous, next }
--
-- notification_type (+2): one `…_submitted_staff` outbox row PER REVIEWER on
-- submit (FR-011; the 1 h coalescing is T087, PR-2 — PR-1 always fans out),
-- one `…_decided_member` row for the
-- submitter on decide (FR-023). `context_data` carries ids + field keys ONLY;
-- the dispatcher renders the diff at send time under the tenant tx (R8).
--
-- ENUM-ONLY FILE: `scripts/run-migrations.ts` extracts every
-- `ALTER TYPE … ADD VALUE` and replays it in AUTOCOMMIT before the
-- transactional migrate pass (scripts/lib/enum-migration-guard.ts, the 0230
-- incident). Keep this file free of any other DDL, one statement per line,
-- each ending in `;`, none on a `--` line. The tables live in 0300.

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_change_request_submitted';
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_change_request_decided';
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_change_request_withdrawn';
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_change_request_rate_limited';
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_change_approval_setting_changed';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'member_change_request_submitted_staff';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'member_change_request_decided_member';
