-- 0330 — #739 B3a: scrub stored error text from three columns.
--
-- Until this release three columns could hold an error's own text, and a
-- drizzle error's message quotes the statement's bound parameters (member
-- emails, names):
--   * invoices.receipt_pdf_last_error         — String(e) of a receipt render/upload;
--   * notifications_outbox.last_error          — a receipt render reason or Resend's message;
--   * renewal_reminder_events.failure_reason   — `dispatcher_crash: <message>` and the
--                                                renewals gateway's (sanitised) messages.
-- The code now writes closed codes only (`render:TypeError`, `resend:validation_error`,
-- `dispatcher_crash:Error`, …). This migration rewrites every stored value that does not
-- already have a closed-code shape; values the code authored itself are kept.
--
-- Not touched: audit_log. Its rows are append-only (10-year tax and 5-year forensic
-- retention); rows written before this release keep their text, as recorded in
-- docs/observability.md § 3 and the PR. The error-CSV blobs (events CSV import) are
-- private and TTL-swept at 30 days.
--
-- Safe before and after the code deploys: plain UPDATEs, idempotent (a second run finds
-- nothing to rewrite), no DDL. The invoices immutability trigger does not lock
-- receipt_pdf_last_error; none of the three tables has an updated_at trigger, and the
-- statements do not set updated_at, so no timer restarts. Rollback: none needed — the
-- text is gone by design.

-- invoices: keep `step:Class[:code]`, `annotation_step:Class[:code]` and plain tokens
-- (`receipt_doc_num_missing`); everything else becomes `legacy_redacted`.
UPDATE "invoices"
   SET "receipt_pdf_last_error" = 'legacy_redacted'
 WHERE "receipt_pdf_last_error" IS NOT NULL
   AND "receipt_pdf_last_error" !~ '^[a-z][a-z0-9_]*(:[A-Za-z][A-Za-z0-9_]*(:[A-Za-z0-9_.-]+)?)?$';

-- notifications_outbox: keep code-authored values — a token, `prefix:token`, optionally
-- followed by ` — <code-authored detail>` (`receipt_pdf_gate_skip:invoice_void — …`, which
-- findFailedAutoEmailsByInvoice matches by prefix) — when they hold no '@'. Resend's and
-- the drizzle driver's messages start upper-case or carry an address, so they go.
UPDATE "notifications_outbox"
   SET "last_error" = 'legacy_redacted'
 WHERE "last_error" IS NOT NULL
   AND ("last_error" !~ '^[a-z][a-z0-9_-]*(:[A-Za-z0-9_.-]+)*( — .*)?$'
        OR position('@' IN "last_error") > 0);

-- renewal_reminder_events: a crash keeps its prefix, so `failure_kind`-style
-- classification by prefix still works; other text becomes `legacy_redacted`.
UPDATE "renewal_reminder_events"
   SET "failure_reason" = 'dispatcher_crash:legacy_redacted'
 WHERE "failure_reason" LIKE 'dispatcher_crash: %';

UPDATE "renewal_reminder_events"
   SET "failure_reason" = 'legacy_redacted'
 WHERE "failure_reason" IS NOT NULL
   AND "failure_reason" !~ '^[a-z][a-z0-9_]*(:[A-Za-z][A-Za-z0-9_-]*)?$';
