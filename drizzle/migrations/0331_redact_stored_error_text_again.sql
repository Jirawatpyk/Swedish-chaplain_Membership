-- 0331 — #739 B3b part 2: repeat 0330's scrub of stored error text.
--
-- 0330 ran inside #800's build, before the new code was promoted, so the old
-- deployment could still write an error's own text into these three columns
-- until the alias flipped. This repeats the same four UPDATEs, with the same
-- predicates, to catch those rows. Code since #800 writes only closed codes
-- (`render:TypeError`, `resend:validation_error`, `dispatcher_crash:Error`),
-- which every predicate below keeps.
--
-- Not touched: audit_log (append-only; docs/decisions.md records the read-only
-- prod count that decides any payload rewrite, outside this migration).
--
-- Correct before and after the code deploys: plain UPDATEs, idempotent, no DDL,
-- no updated_at (none of the three tables has an updated_at trigger; the
-- invoices immutability trigger does not lock receipt_pdf_last_error). Rollback:
-- none needed — the text is gone by design.
-- A promote back to a deployment before #739 writes error text into these
-- columns again; re-run these UPDATEs by hand after one (docs/observability.md).

UPDATE "invoices"
   SET "receipt_pdf_last_error" = 'legacy_redacted'
 WHERE "receipt_pdf_last_error" IS NOT NULL
   AND "receipt_pdf_last_error" !~ '^[a-z][a-z0-9_]*(:[A-Za-z][A-Za-z0-9_]*(:[A-Za-z0-9_.-]+)*)?$';

--> statement-breakpoint

UPDATE "notifications_outbox"
   SET "last_error" = 'legacy_redacted'
 WHERE "last_error" IS NOT NULL
   AND ("last_error" !~ '^([a-z][a-z0-9_-]*(:[A-Za-z0-9_.-]+)*|receipt_pdf_(gate|render)_skip:[a-z_]+ — .*)$'
        OR position('@' IN "last_error") > 0);

--> statement-breakpoint

UPDATE "renewal_reminder_events"
   SET "failure_reason" = 'dispatcher_crash:legacy_redacted'
 WHERE left("failure_reason", 18) = 'dispatcher_crash: ';

--> statement-breakpoint

UPDATE "renewal_reminder_events"
   SET "failure_reason" = 'legacy_redacted'
 WHERE "failure_reason" IS NOT NULL
   AND "failure_reason" !~ '^[a-z][a-z0-9_]*(:[A-Za-z][A-Za-z0-9_.-]*)?$';
