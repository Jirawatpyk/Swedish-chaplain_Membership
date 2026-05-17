-- E2 + E3 (post-ship 2026-05-17) — hash-at-rest for session ids,
-- password-reset token ids, and invitation ids.
--
-- WHY (defense in depth):
-- Pre-E2/E3 the DB `id` column stored the PLAINTEXT 64-hex bearer
-- value. A DB read alone (SQLi, leaked backup, support engineer with
-- read-only access) yielded usable cookies + reset links + invitation
-- links for every live row. Post-fix the column stores
-- `sha256(plaintext)`; the plaintext lives only in the user's
-- browser cookie / email URL, and a DB row read cannot grant
-- capability.
--
-- F3 (`email_change_tokens`) already follows this pattern; this
-- migration brings the F1 surfaces to parity.
--
-- WHY THIS IS A TRUNCATE, NOT A BACKFILL:
-- We cannot reverse-hash existing plaintext ids stored in the DB
-- column — sha256 is one-way. Backfill would require either:
--   1. Two-phase migration (add hash column, dual-write, dual-read,
--      stop dual-write, drop plaintext) over multiple deploys; OR
--   2. Re-issue every live credential (force log out + invalidate
--      every pending reset link + re-send every pending invitation).
-- At SweCham scale (≤1 admin + ~131 members, F1 the only feature in
-- production), option 2 is operationally trivial:
--   - sessions: every user signs back in (cookie revoked; one sign-in
--     each on next visit).
--   - password_reset_tokens: any user mid-reset must request a new
--     link. Reset link TTL is short (1h) so the live-link blast
--     radius is small.
--   - invitations: any pending invitation must be re-sent by an
--     admin. Pre-deploy the admin should run a quick audit of
--     "invitations where consumed_at IS NULL AND expires_at > now"
--     and email those invitees themselves before flipping.
--
-- OPERATOR CHECKLIST BEFORE DEPLOY:
--   1. Query pending invitations:
--      SELECT id, user_id, expires_at FROM invitations
--        WHERE consumed_at IS NULL AND expires_at > now();
--      For each row, ask an admin to re-invite via the admin UI
--      AFTER this migration ships.
--   2. Query pending resets:
--      SELECT id, user_id, expires_at FROM password_reset_tokens
--        WHERE consumed_at IS NULL AND expires_at > now();
--      For each row, the user must re-request via /forgot-password.
--   3. Forewarn active admins: "you'll be signed out after the
--      next deploy; sign back in." Member sessions are typically
--      idle (≤ a few per week at SweCham scale).
--
-- POST-DEPLOY VERIFICATION:
--   - `SELECT count(*) FROM sessions;` should be 0 immediately after.
--   - `SELECT count(*) FROM password_reset_tokens WHERE consumed_at IS NULL;` should be 0.
--   - `SELECT count(*) FROM invitations WHERE consumed_at IS NULL;` should be 0.
--   - `SELECT * FROM audit_log WHERE request_id = 'migration-0159' ORDER BY timestamp;`
--     should show one `session_forcibly_ended` row per revoked session +
--     two summary rows for the token/invitation invalidations.
--
-- AUDIT TRAIL (F4 Round 2 HIGH2):
-- Per Constitution Principle VIII (Reliability) + Principle X (Append-only
-- audit), every user-facing state change MUST have an audit row. The
-- TRUNCATE below is a bulk state change affecting every live user; we
-- emit one `session_forcibly_ended` row per revoked session BEFORE the
-- TRUNCATE so the audit log retains forensic evidence of the deploy-day
-- rotation. Without these rows, a future "why was I signed out on
-- 2026-05-17?" enquiry has no trail (pino logs roll off in 30 days).

BEGIN;

-- Forensic audit BEFORE bulk invalidation. Six months from now, an
-- admin querying "what happened on the deploy day?" sees a clean trail.
INSERT INTO audit_log (event_type, actor_user_id, target_user_id, summary, request_id)
  SELECT
    'session_forcibly_ended'::audit_event_type,
    'system:bootstrap',
    user_id,
    'migration 0159 — session revoked for hash-at-rest rotation',
    'migration-0159'
  FROM sessions;

-- One summary row per bulk-invalidation surface, for cases where
-- per-row enumeration would be expensive or noisy. `target_user_id`
-- NULL because the row references the bulk action, not a single user.
INSERT INTO audit_log (event_type, actor_user_id, summary, request_id)
  VALUES
    (
      'password_reset_failed'::audit_event_type,
      'system:bootstrap',
      'migration 0159 — all pending reset tokens invalidated (hash-at-rest rotation)',
      'migration-0159'
    ),
    (
      'invitation_redemption_failed'::audit_event_type,
      'system:bootstrap',
      'migration 0159 — all unconsumed invitations deleted (hash-at-rest rotation)',
      'migration-0159'
    );

TRUNCATE TABLE sessions;
TRUNCATE TABLE password_reset_tokens;
DELETE FROM invitations WHERE consumed_at IS NULL;

COMMIT;
