-- Migration 0181 — seed the Resend-webhook system actor.
--
-- The `invitation_bounced` audit event (spec § Edge Cases) is emitted from the
-- tenant-agnostic Resend webhook, which has NO human actor. `audit_log
-- .actor_user_id` is `uuid REFERENCES users(id)`, so we need a stable seeded
-- system user to attribute these rows to. Mirrors migration 0041's
-- SYSTEM_ACTOR_STRIPE_WEBHOOK (...f5001) using the next id in the reserved
-- `00000000-0000-0000-0000-0000000f50xx` namespace.
--
-- `status = 'disabled'` so the account can never sign in; `password_hash` NULL.
-- Idempotent via ON CONFLICT.

INSERT INTO "users" (
  "id", "email", "role", "status", "password_hash", "display_name",
  "created_at", "failed_signin_count"
) VALUES (
  '00000000-0000-0000-0000-0000000f5002',
  'system-resend-webhook@chamber-os.internal',
  'admin',
  'disabled',
  NULL,
  'System (Resend Webhook)',
  now(),
  0
)
ON CONFLICT ("id") DO NOTHING;
