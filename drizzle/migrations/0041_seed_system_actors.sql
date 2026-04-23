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
-- Rollback notes (review-fix):
--   - SAFE pre-Phase-3: `DELETE FROM users WHERE id='00000000-0000-0000-0000-0000000f5001'`
--     succeeds because no rows reference it yet.
--   - UNSAFE post-Phase-3: once the webhook handler writes any
--     `payments.actor_user_id = '…f5001'` or `audit_log.target_user_id
--     = '…f5001'` row, the FK RESTRICT on payments + the append-only
--     invariant on audit_log block DELETE. Rolling back then requires
--     either (a) a targeted backfill that rewrites existing refs to a
--     replacement sentinel, or (b) accepting the row as permanent
--     system state (the audit trail it anchors is forensically useful
--     either way).
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

-- Audit trail — every auth-surface state transition emits one event
-- per Constitution Principle I audit discipline. Self-attested actor
-- (the same id is both source and target) is the canonical pattern for
-- bootstrap / migration-origin provisioning — no human operator was
-- involved, and using any other id would incorrectly attribute the
-- seed to a real admin. request_id/source_ip reflect the migration
-- runner origin.
INSERT INTO "audit_log" (
  "event_type", "actor_user_id", "target_user_id", "source_ip",
  "summary", "request_id"
)
SELECT
  'account_created', '00000000-0000-0000-0000-0000000f5001',
  '00000000-0000-0000-0000-0000000f5001', NULL,
  'System actor provisioned via migration 0041 (F5 Stripe-webhook sentinel; status=disabled, password_hash=NULL; sign-in impossible)',
  'migration-0041'
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_log"
  WHERE "event_type" = 'account_created'
    AND "target_user_id" = '00000000-0000-0000-0000-0000000f5001'
);--> statement-breakpoint
