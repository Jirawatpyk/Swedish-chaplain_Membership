-- membership-coverage-exclude-guard — the DB-enforced close of the
-- duplicate-membership-§86/4 problem that NO application read-guard can
-- solve correctly (two adversarial design rounds proved every plan_year /
-- cycle-window approximation either under-blocks → double-bills, or
-- over-blocks → refuses a migrated member's legitimate first renewal).
--
-- Root cause: `invoices` never stored the TRUE charged coverage window.
-- The charged window is stamped at every mint via `coverageWindow`
-- (confirm-renewal + auto-draft = [periodTo, periodTo+term);
-- admin-renew-lapsed-member ~:596 = [periodFrom, periodTo);
-- first_payment/erased still stamp the charged window even when the PRINTED
-- `membershipCoverage` line is omitted).
-- This migration persists that window and lets Postgres reject a second
-- OVERLAPPING live membership bill for the same (tenant, member) at INSERT
-- time with SQLSTATE 23P01 — path-agnostic, concurrency-safe (no advisory
-- lock needed), orphan-safe (a bill with NULL coverage never participates).
--
-- Rollout: the EXCLUDE cannot be added NOT VALID (Postgres allows NOT VALID
-- only for CHECK / FK). It validates immediately, but the partial predicate
-- `WHERE blocks_coverage` matches ZERO existing rows at add-time (every
-- legacy invoice has NULL coverage until the backfill), so the add is a
-- no-op scan and never fails the deploy on legacy overlaps. The backfill
-- then stamps coverage row-by-row; a genuine pre-existing overlap (a
-- double-bill from the no-guard era) surfaces there as a 23P01 for human
-- resolution rather than crashing the deploy. See docs/superpowers/plans/
-- 2026-07-25-membership-coverage-exclude-guard.md.
--
-- DEPLOY ORDERING (money-safety): until the backfill runs, legacy NULL-coverage
-- bills are a blind spot — the new guard skips them (matching `WHERE
-- (blocks_coverage)`), so they will NOT block a same-period re-mint the way the
-- retired plan_year guard did. Run scripts/backfill-membership-coverage.ts in
-- the SAME maintenance window as this deploy and confirm the NULL-coverage
-- committed-membership count reaches 0 before treating the guard as fully live.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "coverage_from" timestamptz,
  ADD COLUMN IF NOT EXISTS "coverage_to" timestamptz;
--> statement-breakpoint
-- Both-or-neither, and a well-formed forward window (mirrors the
-- create-invoice-draft zod guard fromIso < toIso).
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_coverage_window_wellformed"
  CHECK (
    ("coverage_from" IS NULL) = ("coverage_to" IS NULL)
    AND ("coverage_from" IS NULL OR "coverage_from" < "coverage_to")
  );
--> statement-breakpoint
-- A membership bill BLOCKS a same-period re-bill iff it carries a coverage
-- window AND is a live, not-fully-reversed document. `void` and fully
-- `credited` (full refund) never block — the period is re-billable, which
-- is exactly what the admin-renew "refunded frontier" path relies on.
-- `partially_credited` still blocks (partial refund → coverage retained).
-- `draft` does NOT block: provisional drafts for the same period legitimately
-- coexist (an auto-draft + a member-confirm draft; sibling auto-drafts awaiting
-- the discard sweep). The barrier is the ISSUE — a draft that BECOMES
-- issued/paid then blocks, and a concurrent double-issue is rejected here. The
-- auto-draft cron's own {draft,issued} dedup (Task 7) still prevents duplicate
-- DRAFTS. Event invoices (plan_id IS NULL) carry no coverage → never block.
-- Pure STORED generated column: row-local, immutable, no trigger.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "blocks_coverage" boolean
  GENERATED ALWAYS AS (
    "coverage_from" IS NOT NULL
    AND "status" IN ('issued', 'paid', 'partially_credited')
  ) STORED;
--> statement-breakpoint
-- The guard: no two BLOCKING membership bills for one (tenant, member) may
-- cover overlapping periods. Half-open [from, to) so adjacent terms
-- (…-01-01) do NOT count as overlapping.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_membership_coverage_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "member_id" WITH =,
    tstzrange("coverage_from", "coverage_to", '[)') WITH &&
  ) WHERE ("blocks_coverage");
