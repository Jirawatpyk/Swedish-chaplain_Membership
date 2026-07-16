-- 065 renewal-swecham-alignment (§5.1) — members.billing_cycle.
--
-- FREE per-member choice (calendar-year 1/1-31/12 vs rolling anniversary),
-- RECORDED not derived. Foundation-only: drives no behaviour this round; the
-- future auto-invoice phase reads it (calendar -> Dec 1 batch; rolling -> T-30).
--
-- Backfill is BEST-EFFORT from the member's latest renewal cycle: period_from
-- = January 1 (Asia/Bangkok) -> 'calendar', else 'rolling'; no cycle -> default
-- 'rolling'. KNOWN LIMITATION: a rolling member whose FIRST payment landed in
-- January has period_from = Jan 1 and is indistinguishable by date from a
-- calendar member -- it is over-marked 'calendar'. Because the column drives no
-- behaviour this round, this is tolerable; the admin-review pass is mandatory
-- before the auto-invoice phase consumes the column.
--
-- A fresh enum type (not an ALTER TYPE ... ADD VALUE), so CREATE TYPE + the
-- ADD COLUMN that uses it are safe in one migration transaction.

-- 1. New enum type.
CREATE TYPE "billing_cycle" AS ENUM('calendar', 'rolling');--> statement-breakpoint

-- 2. Add the column NOT NULL DEFAULT 'rolling' (every existing row seeded
--    'rolling', then step 3 flips the calendar-aligned ones).
ALTER TABLE "members"
  ADD COLUMN "billing_cycle" "billing_cycle" NOT NULL DEFAULT 'rolling';--> statement-breakpoint

-- 3. Backfill: flip to 'calendar' for members whose LATEST cycle starts Jan 1
--    (Asia/Bangkok). DISTINCT ON picks the most-recent cycle per member.
UPDATE "members" m
SET "billing_cycle" = 'calendar'
FROM (
  SELECT DISTINCT ON (rc."member_id")
    rc."tenant_id", rc."member_id", rc."period_from"
  FROM "renewal_cycles" rc
  ORDER BY rc."member_id", rc."created_at" DESC, rc."cycle_id" DESC
) latest
WHERE latest."tenant_id" = m."tenant_id"
  AND latest."member_id" = m."member_id"
  AND EXTRACT(MONTH FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1
  AND EXTRACT(DAY   FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1;--> statement-breakpoint
