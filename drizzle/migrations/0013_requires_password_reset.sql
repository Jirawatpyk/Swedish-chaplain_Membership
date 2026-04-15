-- ---------------------------------------------------------------------------
-- F3 US3.b.3 — users.requires_password_reset flag + GRANT widening
--
-- The revert-contact-email use case (FR-012b) atomically rolls back the
-- email change AND flags the linked user with `requires_password_reset`.
-- F1 sign-in uses this flag to refuse authentication until the user
-- completes a password reset — preventing an attacker who somehow knew
-- the OLD password from continuing to sign in after the legitimate
-- owner hits the revert link.
--
-- The column is added NOT NULL with default FALSE so existing rows are
-- unaffected. chamber_app needs UPDATE access on the new column
-- (migration 0012 only granted UPDATE on email + email_verified).
-- ---------------------------------------------------------------------------

ALTER TABLE "users"
  ADD COLUMN "requires_password_reset" boolean NOT NULL DEFAULT FALSE;--> statement-breakpoint

-- Replace the 0012 column-level UPDATE grant with a superset that also
-- covers the new column. Postgres GRANT is additive, so issuing UPDATE
-- on the new column is sufficient — no need to REVOKE first.
GRANT UPDATE ("requires_password_reset") ON TABLE "users" TO chamber_app;--> statement-breakpoint
