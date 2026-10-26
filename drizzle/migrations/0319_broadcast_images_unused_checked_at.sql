-- 0319 — spec 131: the "examined" watermark for the image sweep's UNUSED arm.
--
-- Arm 3 (`reclaimOrphanedImages`, spec 131) reaps a live image of an E-Blast
-- in a terminal status when that E-Blast's own body, source and versions do
-- not embed its URL. A terminal E-Blast's content never changes (the
-- immutability trigger), yet without a watermark every image a SENT E-Blast
-- does show stayed in the candidate set and was re-scanned (`position()` over
-- each body and version) on every daily tick for the five-year retention.
-- Rows the tenant-wide content backstop kept were re-selected oldest-first
-- each tick and could fill the bounded batch for good (#658 reviews).
--
-- `unused_checked_at` records when arm 3 last examined the row. The sweep
-- stamps the rows an owner still uses, and the rows the backstop keeps, and
-- skips a stamped row for 30 days, so a row is examined at most monthly and a
-- kept row is re-examined automatically. A row whose per-row transaction
-- fails is NOT stamped and is retried on the next tick.
--
-- Additive and nullable: safe before the code that reads it is deployed (no
-- reader yet; NULL means "never examined", which is every existing row). The
-- partial index serves the sweep's two arm-3 statements, which read only live
-- E-Blast rows of one tenant by watermark, in their ORDER BY
-- (`unused_checked_at NULLS FIRST, created_at`), so a LIMIT can stop early.
--
-- The ADD COLUMN takes an ACCESS EXCLUSIVE lock and the CREATE INDEX a SHARE
-- lock, both brief on this table; lock_timeout makes a deploy that meets a long
-- transaction (the daily sweep, an upload) ABORT instead of queueing every
-- editor read behind it (the 0318 precedent).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE broadcast_images
  ADD COLUMN IF NOT EXISTS unused_checked_at timestamptz NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS broadcast_images_tenant_unused_checked_idx
  ON broadcast_images (tenant_id, unused_checked_at NULLS FIRST, created_at)
  WHERE deleted_at IS NULL AND owner_kind = 'broadcast';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
