-- ---------------------------------------------------------------------------
-- 107-auto-invoice Task 7 — seed a reserved "system" user row for the daily
-- auto-draft cron.
--
-- Why: `autoDraftDueRenewals` (Task 7) is the FIRST automated/cron path that
-- creates a brand-new F4 invoice DRAFT with no human actor behind it.
-- `invoices.draft_by_user_id` is `uuid NOT NULL REFERENCES users(id)`
-- (migration 0019) — a literal `'system:...'` string sentinel (the pattern
-- used by audit-only actor fields elsewhere, e.g.
-- render-receipt-pdf.ts's SYSTEM_ACTOR_ID) cannot satisfy a `uuid` FK
-- column. Mirrors migration 0041's exact design (F5's
-- SYSTEM_ACTOR_STRIPE_WEBHOOK, '...f5001') — next id in the SAME reserved
-- `00000000-0000-0000-0000-0000000f5xxx` namespace that migration 0041's
-- own header comment already anticipated ("future system actors (cron
-- dispatcher, migration backfills, …)").
--
-- Design (identical rationale to 0041, not re-derived here):
--   - `status = 'disabled'` ⇒ sign-in impossible regardless of password
--     state.
--   - `role = 'admin'` ⇒ audit payloads reading this row's role see
--     'admin' (genuine admin-equivalent write power from the system
--     side); RBAC never grants capabilities BASED on this row because
--     sign-in is impossible.
--   - `password_hash = NULL` ⇒ argon2 verify returns false even if
--     status is ever flipped back to 'active' by mistake.
--   - `.internal` TLD email ⇒ any accidental outbound bounces silently.
--
-- Rollback notes (mirrors 0041):
--   - SAFE pre-Task-7-deploy: `DELETE FROM users WHERE
--     id='00000000-0000-0000-0000-0000000f5002'` succeeds because no
--     rows reference it yet.
--   - UNSAFE once `autoDraftDueRenewals` has drafted at least one
--     invoice: the FK RESTRICT on `invoices.draft_by_user_id` blocks
--     DELETE. Rolling back then requires a targeted backfill rewriting
--     existing refs, or accepting the row as permanent system state.
-- ---------------------------------------------------------------------------

INSERT INTO "users" (
  "id", "email", "role", "status", "password_hash", "display_name",
  "created_at", "failed_signin_count"
) VALUES (
  '00000000-0000-0000-0000-0000000f5002',
  'system-auto-invoice-cron@chamber-os.internal',
  'admin',
  'disabled',
  NULL,
  'System (Auto-Invoice Cron)',
  now(),
  0
)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Audit trail — self-attested actor (source and target are the same id),
-- the canonical pattern for bootstrap / migration-origin provisioning
-- (no human operator was involved).
INSERT INTO "audit_log" (
  "event_type", "actor_user_id", "target_user_id", "source_ip",
  "summary", "request_id"
)
SELECT
  'account_created', '00000000-0000-0000-0000-0000000f5002',
  '00000000-0000-0000-0000-0000000f5002', NULL,
  'System actor provisioned via migration 0261 (107-auto-invoice cron sentinel; status=disabled, password_hash=NULL; sign-in impossible)',
  'migration-0261'
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_log"
  WHERE "event_type" = 'account_created'
    AND "target_user_id" = '00000000-0000-0000-0000-0000000f5002'
);
