-- ---------------------------------------------------------------------------
-- Migration 0219 — DML grant for broadcast_batch_delivery_events (F7-SF-1).
--
-- The application role `chamber_app` (NOLOGIN NOBYPASSRLS; every request
-- does `SET LOCAL ROLE chamber_app` so RLS fires) needs SELECT/INSERT/
-- UPDATE/DELETE on the new dedup ledger from 0218 — the repo's idempotency
-- INSERT runs as chamber_app inside runInTenant. Without it the INSERT
-- fails "permission denied for table broadcast_batch_delivery_events".
--
-- NOTE: the sibling F7.1a tables (e.g. broadcast_batch_manifests) carry
-- this grant on the live Neon but it is NOT in the migration history —
-- it was applied out-of-band. This migration makes the grant explicit for
-- the new table so a fresh DB provisioned purely from migrations is
-- correct (matching the in-migration GRANT precedent from 0006 F2 tables).
-- Kept as its own migration (not folded into 0218) because 0218 is already
-- applied on the shared dev Neon; a separate forward-only step grants it
-- there cleanly without re-running the CREATE TABLE.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "broadcast_batch_delivery_events" TO chamber_app;
