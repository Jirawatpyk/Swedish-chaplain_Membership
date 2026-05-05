-- ---------------------------------------------------------------------------
-- F8 Phase 4 Wave I4 — extend F1 `email_delivery_events` with `bounce_type`
-- column + supporting partial index for F8 BounceEventQuery adapter.
--
-- Resend's webhook payload includes `bounce.type` ('permanent' or
-- 'transient') for `email.bounced` events. The original F1 webhook
-- handler discards this field; F8 needs it to compute FR-012a's three
-- thresholds:
--   - 1 hard bounce (permanent)            → flip email_unverified
--   - 3 soft bounces in same renewal cycle → flip email_unverified
--   - 5 soft bounces rolling 30 days       → flip email_unverified
--
-- Schema notes:
--   * Column is NULLABLE — only set on `event_type='bounced'` rows.
--     Non-bounced events have `bounce_type IS NULL` permanently.
--   * Type is TEXT (not enum) — accommodates Resend extending the
--     bounce_type vocabulary without requiring a migration. F8
--     adapter filters by exact `'permanent'` / `'transient'` match;
--     unknown values silently skip (no double-counting risk).
--   * Backfilling old rows is unnecessary for MVP correctness (F8
--     ships dark behind FEATURE_F8_RENEWALS=false; post-flag-flip
--     bounces are captured fresh).
--
-- Index notes:
--   * Partial index on (to_email, created_at DESC) WHERE
--     event_type='bounced' supports the BounceEventQuery composite
--     SELECT (3 FILTER aggregates per call). DESC keeps the
--     soft-30d window scan tight on the most-recent end.
-- ---------------------------------------------------------------------------

ALTER TABLE "email_delivery_events"
  ADD COLUMN "bounce_type" TEXT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_delivery_events_bounced_lookup_idx"
  ON "email_delivery_events" ("to_email", "created_at" DESC)
  WHERE "event_type" = 'bounced';
--> statement-breakpoint

COMMENT ON COLUMN "email_delivery_events"."bounce_type" IS
  'Resend bounce.type (permanent | transient). NULL on non-bounced events. Used by F8 FR-012a threshold computation.';
