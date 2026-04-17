-- ---------------------------------------------------------------------------
-- R001 (staff-review-20260417-us7) — tighten the 0016 grant scope.
--
-- Migration 0016 granted full-table `SELECT ON invitations` to chamber_app
-- so the F3 archive cascade could soft-consume pending invitations. This
-- widened chamber_app's visibility to `invitations.id`, which IS the raw
-- 7-day invite token (F1 design — the token IS the primary key, not a
-- hash of it). Any SQL injection in chamber_app-scoped code would then
-- let an attacker enumerate live invitation tokens.
--
-- This migration narrows the SELECT grant to the three columns actually
-- needed by the archive cascade's UPDATE predicate + RETURNING column:
--
--   - `user_id`        — WHERE user_id IN (...) + RETURNING { userId }
--   - `consumed_at`    — WHERE consumed_at IS NULL
--   - `expires_at`     — WHERE expires_at > NOW()
--
-- `UPDATE (consumed_at)` from 0016 remains sufficient for the SET clause.
-- `invitations.id` (the token) is NO LONGER visible to chamber_app — it's
-- owner-role only, matching F1's token-repo pattern.
--
-- SS-4 convention note: no schema shape change; snapshot-less migration.
-- ---------------------------------------------------------------------------

REVOKE SELECT ON TABLE invitations FROM chamber_app;

GRANT SELECT (user_id, consumed_at, expires_at) ON TABLE invitations TO chamber_app;
