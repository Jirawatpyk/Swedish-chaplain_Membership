-- F8 Phase 8 R8 R4-IMP-5 close — add `year_in_cycle` column to
-- `renewal_escalation_tasks` so the queue UI can render the FR-043
-- multi-year pill ("Year 2 of 3 · Quarterly review") for cycles
-- with cycle_length_months > 12.
--
-- Why this is a follow-up: the column was missing from the original
-- 0092 migration (Phase 2 Wave C). The producers (5 inline emit
-- sites + the T208 createEscalationTask use-case) compute year-in-
-- cycle but only put it in the audit payload — the row itself had
-- no column to persist it. Round 4 review (Phase 8 final) caught
-- the silent UI gap: queue always rendered the single-year form
-- because the projection had nowhere to read year-in-cycle from.
--
-- DEFAULT 1 backfills existing rows safely. Multi-year contracts
-- shipped before this migration will appear as "Year 1 of <total>"
-- which is acceptable for backfilled audit-only rows; new producers
-- pass the actual yearInCycle through `insertIfAbsent`.
--
-- CHECK constraint: 1 ≤ year_in_cycle ≤ 50 (sanity bound — the
-- longest contract under SweCham is 5 years; 50 leaves headroom
-- without over-constraining a future MTA tenant with longer terms).

ALTER TABLE "renewal_escalation_tasks"
  ADD COLUMN "year_in_cycle" SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE "renewal_escalation_tasks"
  ADD CONSTRAINT "renewal_escalation_tasks_year_in_cycle_check"
    CHECK ("year_in_cycle" >= 1 AND "year_in_cycle" <= 50);
