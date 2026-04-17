-- Migration 0018 — outbox_permanent_updated_idx
--
-- Partial index supporting the `OutboxHealthBadge` Server Component
-- (src/components/shell/outbox-health-badge.tsx) which queries:
--
--   SELECT COUNT(*) FROM notifications_outbox
--   WHERE status = 'permanently_failed'
--     AND updated_at >= NOW() - INTERVAL '24 hours'
--
-- The existing `outbox_dispatch_idx (status, next_retry_at)` covers the
-- stuck-rows query in the same component, but not the permanent-failed
-- lookback. The badge runs on every admin page load; without a backing
-- index Postgres falls back to a partial index scan over the whole
-- permanent-failed subset, which is fine today (< 100 rows) but scales
-- poorly once dispatch failures accumulate.
--
-- Partial index (WHERE status = 'permanently_failed') keeps the index
-- size minimal — only the rows the badge actually queries are indexed.
-- IF NOT EXISTS makes it safe to re-apply.

CREATE INDEX IF NOT EXISTS "outbox_permanent_updated_idx"
  ON "notifications_outbox" ("updated_at")
  WHERE "status" = 'permanently_failed';
