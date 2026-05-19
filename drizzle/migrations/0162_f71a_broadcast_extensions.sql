-- ---------------------------------------------------------------------------
-- F7.1a US1 + US7 (T012 + T016) — broadcasts table extensions.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 2.1.
-- Five new columns + one CHECK constraint:
--   - manual_retry_count           — US1 FR-008a (admin retry budget 0-3)
--   - partial_delivery_accepted_at — US1 FR-008c (admin accept-partial action)
--   - partial_delivery_accepted_by_user_id — US1 FR-008c (actor)
--   - started_from_template_id     — US7 FR-022 (FK → broadcast_templates.id)
--   - template_name_snapshot       — US7 FR-019 / critique P9 (denormalised
--                                    template name; survives template deletion
--                                    for forensic audit)
--
-- All ADD COLUMN statements are non-destructive: existing F7 MVP
-- `broadcasts` rows accept the column defaults (manual_retry_count=0,
-- partial_delivery_*=NULL, started_from_template_id=NULL,
-- template_name_snapshot=NULL) without rewrites.
--
-- The startedFromTemplateId FK uses ON DELETE SET NULL so deleting a
-- template does NOT cascade-delete the broadcasts that originated from
-- it (the broadcast row + audit trail remain valid; template_name_snapshot
-- preserves the name).
-- ---------------------------------------------------------------------------

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "manual_retry_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "partial_delivery_accepted_at" timestamptz;--> statement-breakpoint

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "partial_delivery_accepted_by_user_id" uuid;--> statement-breakpoint

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "started_from_template_id" uuid;--> statement-breakpoint

ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "template_name_snapshot" text;--> statement-breakpoint

-- FK added separately so the ALTER TABLE ADD COLUMN idempotency above
-- doesn't conflict with the constraint-add idempotency below.
-- Postgres has no IF NOT EXISTS for ADD CONSTRAINT — wrap in DO block
-- with a pg_constraint lookup (project convention; see 0125 + 0126).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_started_from_template_id_fkey'
  ) THEN
    ALTER TABLE "broadcasts"
      ADD CONSTRAINT "broadcasts_started_from_template_id_fkey"
      FOREIGN KEY ("started_from_template_id")
      REFERENCES "broadcast_templates"("id")
      ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint

-- US1 FR-008a — admin retry budget capped at 3 per broadcast.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_manual_retry_count_check'
  ) THEN
    ALTER TABLE "broadcasts"
      ADD CONSTRAINT "broadcasts_manual_retry_count_check"
      CHECK ("manual_retry_count" BETWEEN 0 AND 3);
  END IF;
END $$;--> statement-breakpoint
