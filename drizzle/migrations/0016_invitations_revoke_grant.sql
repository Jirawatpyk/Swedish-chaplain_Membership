-- ---------------------------------------------------------------------------
-- Grant limited access on `invitations` to chamber_app so the F3 archive
-- cascade (use case: archive-member) can soft-consume pending unredeemed
-- invitations in the same tx as the member status flip + session
-- revocation — defense-in-depth per spec edge case "Contact tied to a
-- pending F1 invitation".
--
-- The F1 `invitations` table is intentionally owner-role only at rest;
-- this migration broadens chamber_app to SELECT + UPDATE(consumed_at)
-- so archive can mark pending invitations as consumed. We deliberately
-- do NOT grant INSERT / DELETE / full UPDATE — the only mutation we need
-- is the `consumed_at` flip.
--
-- SS-4 convention note: no new columns added; schema.ts unchanged, so
-- no drizzle snapshot is generated. Same convention as 0010 / 0014 /
-- 0015 (snapshot-less by design).
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE invitations TO chamber_app;
GRANT UPDATE (consumed_at) ON TABLE invitations TO chamber_app;
