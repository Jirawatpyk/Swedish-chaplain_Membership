-- 058 / PR-B (member-form UX) — two member columns.
--
-- 1. `registered_capital_thb` (ทุนจดทะเบียน) is a NEW field, NOT a rename of
--    `turnover_thb`. Turnover is not a display field: it gates the F2 plan
--    turnover band (out-of-band ⇒ mandatory override reason) and drives F8
--    auto tier-upgrade suggestions. Both columns coexist.
--
-- 2. `sub_district` (แขวง/ตำบล) is the Thai address level the existing five
--    address columns cannot express. It is threaded onto the §86/4 buyer
--    address by `composeBuyerAddress` — a Bangkok address reading
--    "เขตคลองเตย กรุงเทพมหานคร 10110" with no แขวง is not a complete address.
--    Do NOT overload `address_line2`: legacy rows hold building/floor/soi
--    there, and one column with two meanings is unfixable later.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + re-ADD),
-- pattern from 0232. Both columns are nullable — existing rows carry neither,
-- and no backfill is possible or wanted. RLS: `members` is per-tenant
-- row-level; new columns inherit the existing policy (no new policy needed).
--
-- The CHECK spells out `IS NULL OR >= 0` rather than a bare `>= 0`: a Postgres
-- CHECK admits NULL, so a bare comparison would be a no-op on the nullable
-- column. (0236 exists because 0232 made exactly that mistake.)

-- 1. ทุนจดทะเบียน — bigint, mirroring turnover_thb (SweCham Premium turnover
--    band exceeds 100M THB, so int32 would overflow).
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "registered_capital_thb" bigint;--> statement-breakpoint

-- 2. แขวง/ตำบล.
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "sub_district" text;--> statement-breakpoint

-- 3. Mirrors members_turnover_non_negative (0009 § 7).
ALTER TABLE "members"
  DROP CONSTRAINT IF EXISTS "members_registered_capital_non_negative";--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_registered_capital_non_negative"
  CHECK ("registered_capital_thb" IS NULL OR "registered_capital_thb" >= 0);--> statement-breakpoint
