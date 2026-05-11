-- PR #24 deep-review fix — add the missing FK from
-- `scheduled_plan_changes.effective_at_cycle_id` to
-- `renewal_cycles(tenant_id, cycle_id)`.
--
-- Background: `scheduled_plan_changes` (migration 0086) shipped with
-- `effective_at_cycle_id uuid NOT NULL` but no referential-integrity
-- constraint to `renewal_cycles`, because `renewal_cycles` itself ships
-- in 0087 (the next migration). The FK was a known follow-up and never
-- landed before this PR closed. Without it, an admin (or a regressed
-- use-case) can schedule a plan change pointing at a non-existent OR
-- already-purged cycle UUID; the application layer enforces the lookup
-- on creation, but a direct Drizzle write or a future bug in the use-
-- case can leak orphan rows that F4 invoice-creation will then either
-- skip silently or crash on.
--
-- We also add `ON DELETE RESTRICT` (not CASCADE) — deleting a cycle row
-- with a pending scheduled-change is itself an integrity violation, so
-- the FK should reject the delete and force the operator to cancel the
-- scheduled change first.
--
-- Composite FK is `(tenant_id, effective_at_cycle_id) →
-- renewal_cycles(tenant_id, cycle_id)`. The composite ensures the FK
-- can never reference a cycle from a different tenant — defence-in-
-- depth on top of RLS.
--
-- Idempotent: `IF NOT EXISTS` is not standard for `ADD CONSTRAINT` on
-- Postgres, so we wrap in a DO block that skips if the constraint
-- already exists. Re-running the migration after manual application
-- is safe.

-- Round 8 review-fix — idempotency check uses `pg_constraint.conname`
-- (schema-agnostic OID lookup) instead of `information_schema
-- .table_constraints WHERE constraint_schema = current_schema()`.
-- The latter returns the FIRST schema in `search_path`, which can
-- be set to a non-public schema by a session-level `SET search_path`
-- — in that case the guard would mis-report the constraint as absent
-- and the ALTER TABLE would fail on re-apply. `pg_constraint` matches
-- the established pattern at migration 0082.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scheduled_plan_changes_effective_at_cycle_fk'
  ) THEN
    ALTER TABLE "scheduled_plan_changes"
      ADD CONSTRAINT "scheduled_plan_changes_effective_at_cycle_fk"
      FOREIGN KEY ("tenant_id", "effective_at_cycle_id")
      REFERENCES "renewal_cycles" ("tenant_id", "cycle_id")
      ON DELETE RESTRICT;
  END IF;
END $$;
