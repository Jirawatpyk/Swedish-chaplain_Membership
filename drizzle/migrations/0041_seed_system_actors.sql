-- ---------------------------------------------------------------------------
-- F5 C1 fix — seed reserved "system" user rows for non-human actors.
--
-- Why: F5's webhook handler (Phase 3) + other automated processors need
-- a stable, greppable `actor_user_id` when inserting rows into tables
-- with `uuid REFERENCES users(id)` FKs (payments.actor_user_id,
-- invoices.payment_recorded_by_user_id, audit_log.actor_user_id, ...).
-- The previous design proposed a sentinel STRING `'system:stripe-webhook'`,
-- which cannot be stored in a `uuid` column without dropping FK integrity
-- across 4+ tables — a much larger blast radius than seeding one row here.
--
-- Design:
--   - Reserved UUID namespace `00000000-0000-0000-0000-0000000f5000/1/…`
--     so future system actors (cron dispatcher, migration backfills, …)
--     get predictable ids without colliding with `gen_random_uuid()`
--     (which fills the version+variant bits and never produces this shape).
--   - `status = 'disabled'` ⇒ auth flow refuses sign-in regardless of
--     password state (users table CHECK allows NULL password_hash). No
--     new enum value required; the existing state naturally blocks login.
--   - `role = 'admin'` ⇒ audit payloads reading the row's role see
--     'admin' (these actors genuinely have admin-equivalent write power
--     from the system side). RBAC never grants capabilities BASED on this
--     row because sign-in is impossible.
--   - `password_hash = NULL` ⇒ even if status is ever flipped back to
--     'active' by mistake, argon2 verify returns false on null hash.
--   - `email` uses the `.internal` TLD (RFC 6762) so bounce-back from any
--     accidental outbound is silent / filesystem-local rather than
--     escaping the deploy.
--   - `display_name` surfaces as-is in admin UIs so operators recognise
--     these rows as system accounts on sight.
--
-- Rollback: DELETE WHERE id IN (...) — rows are append-only-queried only
-- from the payments/refunds/invoices write paths that started referring
-- to them in this same migration window.
-- ---------------------------------------------------------------------------

INSERT INTO "users" (
  "id", "email", "role", "status", "password_hash", "display_name",
  "created_at", "failed_signin_count"
) VALUES (
  '00000000-0000-0000-0000-0000000f5001',
  'system-stripe-webhook@chamber-os.internal',
  'admin',
  'disabled',
  NULL,
  'System (Stripe Webhook)',
  now(),
  0
)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
