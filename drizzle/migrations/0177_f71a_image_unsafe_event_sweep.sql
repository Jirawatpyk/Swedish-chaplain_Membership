-- ---------------------------------------------------------------------------
-- R2.1 close-out sweep-up — `broadcast_image_unsafe` audit event type.
--
-- This event was added to `F7_AUDIT_EVENT_TYPES` during F7.1a US2 work
-- but never had a dedicated migration. The drift was caught by
-- `tests/integration/broadcasts/audit-event-type-parity.test.ts` when we
-- ran it as part of M-test-2 close-out (event #57 introduction). Sweep
-- the gap with a separate migration so the audit-event-type parity test
-- can pass on live Neon Singapore.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent — if a prior environment had
-- it already (via manual psql add), this is a no-op.
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_image_unsafe';
