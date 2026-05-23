-- Migration 0182 — tenant-agnostic LOWER(email) index for the invitation-bounce resolver.
--
-- handle-invitation-bounce.resolveBouncedInviteContacts matches LOWER(email)
-- across ALL tenants on the global db client (no tenant_id leading column), so
-- the existing contacts_tenant_email_uniq (tenant_id, lower(email)) partial
-- index cannot serve it — every bounce webhook would otherwise do a contacts
-- seq-scan + join. This adds a tenant-agnostic lower(email) btree index,
-- partial on non-removed rows to match the resolver's `removed_at IS NULL`
-- filter (which also keeps it small — removed contacts are excluded).
--
-- Non-CONCURRENTLY: contacts is tiny (~hundreds of rows) so the brief lock is
-- negligible; CONCURRENTLY cannot run inside the drizzle-kit migrate tx.

CREATE INDEX IF NOT EXISTS "contacts_lower_email_idx"
  ON "contacts" USING btree (lower("email")) WHERE removed_at IS NULL;
