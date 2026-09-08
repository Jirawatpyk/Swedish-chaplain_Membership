-- 0298 — `broadcasts.audience_import_*`: track ONE Resend Contacts-Import job
-- per broadcast, so a dispatch tick can hand the whole audience over in a
-- single call instead of pushing it one contact at a time (108 US5, T086;
-- contract `broadcast-audience.md` § 4; research R9 V2 + V4).
--
-- WHY. `addContactsToAudience` is a serial `await` loop at a measured ~2.08
-- req/s (`POST /contacts`, mean 481 ms — research § R9, the CORRECTED block),
-- so ~623 contacts is all one 300 s function can drain. Every mechanism this
-- codebase has grown to work around that — the split threshold, per-batch
-- manifests, one-wave dispatch, drift guards across ticks — exists only
-- because the push is per-contact. `POST /contacts/imports` takes the whole
-- list in one multipart request in ~412 ms REGARDLESS OF SIZE (measured
-- 2026-09-08, T145), which removes the constraint rather than managing it.
--
-- SHAPE. Three nullable columns on `broadcasts`, no new table:
--   * `audience_import_id`            — Resend's job id; NON-NULL means "an
--                                       import is in flight or finished", and
--                                       is the idempotency guard: a tick never
--                                       submits a second import while it is set
--                                       (contract § 4).
--   * `audience_import_submitted_at`  — when we handed it over. The 30-minute
--                                       stuck rule (FR-044 f, T106) measures
--                                       from HERE, not from `scheduled_for`.
--   * `audience_import_completed_at`  — stamped only after the completion rule
--                                       passes: `status = completed` AND
--                                       `failed = 0` AND
--                                       `created + updated + skipped = total`
--                                       AND `total` = the resolved count.
--                                       `sendBroadcast` runs only after this.
--
-- **NO NEW STATUS, and that is a deliberate departure from contract § 4**,
-- which specified a `broadcast_status` value `audience_building`. Two reasons,
-- the first decisive:
--   1. `cancelBroadcast` is cancellable iff status IN ('submitted','approved').
--      A broadcast parked in `audience_building` could not be cancelled — the
--      exact defect the 2026-09-08 reliability review raised against the batch
--      path's drift halt (H-2), where a runbook told staff to cancel something
--      the code refuses to cancel. Adding the status would have reintroduced
--      that class knowingly.
--   2. A new enum value costs an `ALTER TYPE`, the Domain `transition()`
--      policy, every exhaustive switch over `BroadcastStatus`, three locales
--      of UI copy, and the audit taxonomy — for a distinction
--      `audience_import_id IS NOT NULL` already draws. Constitution X.
-- The row therefore stays `approved` for the whole build and moves straight to
-- `sending` when the import is confirmed. Everything that already understands
-- `approved` — cancel, the immutability trigger, the overdue gauge — keeps
-- working with no change.
--
-- IMMUTABILITY. `broadcasts_immutable_after_submit_fn` (0224) blocks changes
-- after submit, but its non-GUC branch is a BLOCKLIST naming only subject /
-- body_html / body_source / segment_type / segment_params /
-- custom_recipient_emails / scheduled_for. These three columns are not in it,
-- so writes on an `approved` row pass. Verified by reading 0224, and by the
-- live-Neon test that already writes `estimated_recipient_count` on an
-- `approved` row through the same trigger.
--
-- ROLLBACK. Additive and nullable: an older deployment ignores the columns and
-- keeps using the per-contact push. Dropping them requires the import code to
-- be gone first (a code revert), the same rule 0297 carries for
-- `marketing_unsubscribes.contact_id`.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS audience_import_id text,
  ADD COLUMN IF NOT EXISTS audience_import_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS audience_import_completed_at timestamptz;
--> statement-breakpoint

-- A completion stamp without a job id would mean "finished an import we never
-- submitted", and a submitted-at without an id the same. Both are unreachable
-- through the use case; the CHECK is what keeps a future writer honest.
ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_audience_import_coherent;
--> statement-breakpoint
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_audience_import_coherent CHECK (
    (audience_import_id IS NOT NULL OR audience_import_submitted_at IS NULL)
    AND (audience_import_id IS NOT NULL OR audience_import_completed_at IS NULL)
    AND (audience_import_completed_at IS NULL OR audience_import_submitted_at IS NOT NULL)
  );
--> statement-breakpoint

-- The stuck sweep (T106) asks one question every 15 minutes: which broadcasts
-- have an import that was submitted but never completed? Partial, because the
-- answer is a handful of rows out of the whole table.
CREATE INDEX IF NOT EXISTS broadcasts_audience_import_pending_idx
  ON broadcasts (tenant_id, audience_import_submitted_at)
  WHERE audience_import_id IS NOT NULL
    AND audience_import_completed_at IS NULL;
