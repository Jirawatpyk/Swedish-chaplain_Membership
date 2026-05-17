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

BEGIN;

TRUNCATE TABLE sessions;
TRUNCATE TABLE password_reset_tokens;
DELETE FROM invitations WHERE consumed_at IS NULL;

COMMIT;
