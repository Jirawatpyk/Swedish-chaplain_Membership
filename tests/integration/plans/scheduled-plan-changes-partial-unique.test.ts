/**
 * D1 (F8 Phase 2 Wave B verify-run remediation) — sentinel integration
 * test for the `scheduled_plan_changes` partial-unique invariant.
 *
 * The contract test at `tests/contract/f2-scheduled-plan-change.contract.test.ts`
 * validates the use-case behaviour against an in-memory mock. This file
 * is the live-DB counterpart that proves the invariant is enforced at
 * the Postgres layer too — i.e. the partial unique
 *
 *   `(tenant_id, member_id, effective_at_cycle_id) WHERE status='pending'`
 *
 * defined in `data-model.md § 2.9` (delivered by Wave C migration 0086)
 * actually rejects a second `pending` row for the same (tenant, member,
 * cycle). Without it, a Drizzle-adapter bug that forgets the supersede
 * step would silently leave duplicate pending rows in the table.
 *
 * STATUS: `it.todo` until the Drizzle adapter for `ScheduledPlanChangeRepo`
 * ships (Phase 5+ when US5 wires the F4 renewal-invoice-creation hook).
 * The sentinel forces this file into the test suite NOW so the gap is
 * visible in CI output rather than silently absent.
 *
 * When implementing in Phase 5+:
 *   1. Seed two distinct test tenants via `createTwoTestTenants()`.
 *   2. INSERT a pending `scheduled_plan_changes` row in tenantA via the
 *      Drizzle adapter (NOT raw SQL — verifies adapter contract).
 *   3. Attempt a second pending INSERT for the SAME (member, cycle) →
 *      assert it raises a Postgres unique-violation (SQLSTATE 23505)
 *      surfaced as a typed Drizzle error.
 *   4. Flip the first row to `superseded` via `transitionStatus`.
 *   5. Insert a fresh pending row → assert SUCCESS (the partial unique
 *      no longer matches because the first row is no longer `pending`).
 *   6. Cross-tenant probe: assert tenantB cannot SELECT/UPDATE/DELETE
 *      tenantA's pending row when running inside `runInTenant(tenantB)`
 *      — RLS+FORCE blocks visibility.
 */
import { describe, it } from 'vitest';

describe('Integration — scheduled_plan_changes partial-unique invariant', () => {
  it.todo(
    'Wave C+ — partial unique enforces at-most-one pending per (tenant, member, cycle); supersede unblocks new pending insert',
  );
  it.todo(
    'Wave C+ — RLS+FORCE blocks tenantB from observing tenantA pending rows (cross-tenant probe)',
  );
});
