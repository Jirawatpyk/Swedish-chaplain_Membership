-- Migration 0078 — F7 US3 Round 4 M3 (code review).
--
-- Drives `MemberRepo.findLastPlanChangedAt(ctx, memberId)` — the
-- benefits-page server component reads the most-recent
-- `member_plan_changed` audit row for the AS2 plan-changed-explainer
-- microcopy. The predicate `(tenant_id, event_type, payload->>'memberId')`
-- ORDER BY `timestamp` DESC currently sequential-scans `audit_log` once
-- the table grows past tens of millions of rows because the JSONB
-- expression isn't index-friendly without help.
--
-- Partial index keyed on the JSONB extraction pinned to the single
-- event type we care about. Other audit consumers don't pay the
-- write-amplification cost — the index only includes
-- `member_plan_changed` rows.
--
-- Idempotent: `IF NOT EXISTS` so re-running the migration on an
-- environment that has the index is a no-op.

CREATE INDEX IF NOT EXISTS audit_log_member_plan_changed_idx
  ON audit_log (
    tenant_id,
    (payload ->> 'memberId'),
    "timestamp" DESC,
    id DESC
  )
  WHERE event_type = 'member_plan_changed';
