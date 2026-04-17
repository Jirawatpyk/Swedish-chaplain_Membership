-- ---------------------------------------------------------------------------
-- F3 US3.b.2 — email_change_tokens + user email_verified flag + grants
--
-- This migration delivers the DB layer for FR-012a (atomic contact-email
-- change). It is the second-half companion to migration 0011 which shipped
-- the notifications_outbox.
--
-- Three concerns land here:
--   1. `email_change_tokens` table — stores the 24h verification token
--      (to NEW address) + 48h revert token (to OLD address). Both are
--      hashed at rest (column = sha256 digest; plaintext lives only in
--      the email body).
--   2. `users.email_verified` — boolean flag (default TRUE). On a contact
--      email change the application layer sets it FALSE so F1 sign-in
--      rejects the user until the verification endpoint consumes the
--      token and flips it back TRUE. The F1 sign-in guard itself is
--      landed in US3.b.3 alongside the verification consumption route —
--      this migration only lays the column.
--   3. chamber_app narrow column grants + sessions DELETE grant. The
--      6-step atomic txn in change-contact-email runs as chamber_app
--      (inside runInTenant) so it needs DML access to users.email,
--      users.email_verified, and sessions. Without these grants the
--      tx would fail on step (ii) or (iii).
--
-- DEFERRED to US3.b.3:
--   - `users.requires_password_reset` column (for FR-012b revert flow)
--   - F1 sign-in `emailVerified` check
--   - The revert / verify consumption endpoints + use cases
-- ---------------------------------------------------------------------------

-- --- 1. email_change_tokens enum + table ----------------------------------

CREATE TYPE "public"."email_change_token_type" AS ENUM (
  'verification',
  'revert'
);--> statement-breakpoint

CREATE TABLE "email_change_tokens" (
  "id"              text PRIMARY KEY,  -- sha256 hex of the plaintext token
  "tenant_id"       text NOT NULL,
  "contact_id"      uuid NOT NULL,
  "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type"            "email_change_token_type" NOT NULL,
  "old_email"       text NOT NULL,
  "new_email"       text NOT NULL,
  -- Verification tokens have a 5-minute activation delay per spec FR-012a.
  -- activated_at = issuance + 5min; endpoint rejects consumption before this.
  -- Revert tokens are usable immediately (activated_at = issuance).
  "activated_at"    timestamp with time zone NOT NULL,
  "expires_at"      timestamp with time zone NOT NULL,
  "consumed_at"     timestamp with time zone,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Token lookup by user for admin UI + outstanding-token invalidation during
-- a new email change issuance.
CREATE INDEX "email_change_tokens_user_idx"
  ON "email_change_tokens" ("user_id");--> statement-breakpoint

-- Active-token scan (unconsumed + not yet expired)
CREATE INDEX "email_change_tokens_active_idx"
  ON "email_change_tokens" ("user_id", "type")
  WHERE "consumed_at" IS NULL;--> statement-breakpoint

-- --- 2. users.email_verified column ---------------------------------------
--
-- Default TRUE so existing F1 rows (pre-US3.b.2) remain sign-in-able.
-- The column is nullable=NOT NULL with a non-null default to keep the
-- migration backfill-free — the column reads as TRUE on every row until
-- the first contact-email change flips it to FALSE for a specific user.

ALTER TABLE "users"
  ADD COLUMN "email_verified" boolean NOT NULL DEFAULT TRUE;--> statement-breakpoint

-- --- 3. chamber_app DML grants --------------------------------------------
--
-- Narrow column-level UPDATE grants on users (only the columns the F3
-- change-contact-email use case writes). SELECT was already granted in
-- migration 0006. sessions DELETE is new — F3 revokes every session for
-- the affected user inside the atomic txn.
--
-- Column-level grants are auditable and prevent a rogue adapter from
-- mutating users.password_hash or users.role under the chamber_app role.

GRANT UPDATE ("email", "email_verified") ON TABLE "users"    TO chamber_app;--> statement-breakpoint
GRANT SELECT, DELETE                     ON TABLE "sessions" TO chamber_app;--> statement-breakpoint
-- password_reset_tokens: the use case consumes outstanding reset tokens
-- for the affected user as part of step (iv) "disable sign-in via the old
-- email immediately". UPDATE on consumed_at is sufficient — no DELETE
-- needed because append-only retention matches the audit trail.
GRANT SELECT, UPDATE                     ON TABLE "password_reset_tokens" TO chamber_app;--> statement-breakpoint

-- Full CRUD on the new tokens table (chamber_app both writes and consumes).
GRANT SELECT, INSERT, UPDATE ON TABLE "email_change_tokens" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."email_change_token_type" TO chamber_app;--> statement-breakpoint
