-- ---------------------------------------------------------------------------
-- COMP-1 US2a / L1 — grant chamber_app DELETE on notifications_outbox.
--
-- GDPR Art.17 / PDPA §33 member erasure (`eraseMember`) cancels the erased
-- subject's pending `notifications_outbox` rows inside its atomic scrub tx so
-- the dispatcher cannot email the erased subject post-erasure (each row's
-- `to_email` is frozen = the real address; the retry ladder keeps a once-failed
-- row `pending` up to 12h). The cancel is a DELETE of `status='pending'` rows
-- only — `sent` / `permanently_failed` history is preserved.
--
-- Migration 0011 granted chamber_app only SELECT, INSERT, UPDATE on this table
-- (the F3 enqueue + the dispatcher status flips). The erasure path needs DELETE.
-- RLS+FORCE (migration 0098) still confines every chamber_app DELETE to the
-- tenant whose slug is in `app.current_tenant` — the GRANT only widens the verb,
-- not the row scope. Idempotent (re-running GRANT is a no-op).
-- ---------------------------------------------------------------------------

GRANT DELETE ON TABLE "notifications_outbox" TO chamber_app;--> statement-breakpoint
