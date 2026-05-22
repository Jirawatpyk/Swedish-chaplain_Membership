/**
 * F8 Phase 2 Wave C · T017 — Drizzle adapter for `ScheduledPlanChangeRepo`.
 *
 * Implements the F2 cross-module port `ScheduledPlanChangeRepo` against
 * the `scheduled_plan_changes` table (data-model.md § 2.9, migration
 * `0086_f8_create_scheduled_plan_changes_table.sql`).
 *
 * Tenant isolation: every method runs inside `runInTenant(ctx, fn)`
 * which sets `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`
 * — Postgres RLS scopes reads + writes transparently. NO explicit
 * `WHERE tenant_id = ?` filter is added (research.md § 7.1 — the whole
 * point of the two-layer defence is that you don't need one).
 *
 * Wave B verify-run F1 remediation: `supersedeAndInsertPendingAtomically`
 * runs the supersede UPDATE + INSERT inside a single Postgres tx. If
 * either statement fails, both roll back — the (tenant, member, cycle)
 * never observes a "no pending row" intermediate state (Constitution
 * Principle VIII Reliability).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { scheduledPlanChanges } from './schema-scheduled-plan-changes';
import type { ScheduledPlanChangeRow } from './schema-scheduled-plan-changes';
import type {
  ScheduledPlanChangeRepo,
  SupersedeAndInsertResult,
} from '../../application/ports';
import {
  assertValidScheduledPlanChange,
  type MutableScheduledPlanChange,
  type ScheduleNextRenewalPlanChangeInput,
  type ScheduledPlanChange,
  type ScheduledPlanChangeStatus,
} from '../../domain/scheduled-plan-change';

// --- Row → Domain translation -----------------------------------------------

function rowToDomain(row: ScheduledPlanChangeRow): ScheduledPlanChange {
  // Build the loose `MutableScheduledPlanChange` shape from raw DB
  // columns, then have `assertValidScheduledPlanChange` narrow it to
  // the discriminated `ScheduledPlanChange` union. The status↔timestamp
  // invariant lives in the type system from this point on (consumers
  // can `if (row.status === 'applied') row.appliedAt.length` without
  // a non-null bang).
  const candidate: MutableScheduledPlanChange = {
    tenantId: row.tenantId,
    scheduledChangeId: row.scheduledChangeId,
    memberId: row.memberId,
    effectiveAtCycleId: row.effectiveAtCycleId,
    fromPlanId: row.fromPlanId,
    toPlanId: row.toPlanId,
    scheduledByUserId: row.scheduledByUserId,
    reason: row.reason,
    // The CHECK constraint at the DB level guarantees this narrows correctly.
    status: row.status as ScheduledPlanChangeStatus,
    scheduledAt: row.scheduledAt.toISOString(),
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
  // Defence-in-depth status↔timestamp invariant. Throws
  // `InvalidScheduledPlanChangeError` on DB CHECK drift; the canonical
  // DB CHECK is in migration 0086 (`scheduled_plan_changes` table
  // creation). The asserts predicate narrows `candidate` from
  // `MutableScheduledPlanChange` to `ScheduledPlanChange`, so the
  // return type carries the type-level invariant.
  assertValidScheduledPlanChange(candidate);
  return candidate;
}

// --- Adapter ----------------------------------------------------------------

export const drizzleScheduledPlanChangeRepo: ScheduledPlanChangeRepo = {
  async supersedeAndInsertPendingAtomically(
    tenant: TenantContext,
    input: ScheduleNextRenewalPlanChangeInput,
  ): Promise<SupersedeAndInsertResult> {
    return runInTenant(tenant, async (tx) => {
      // Step 1: supersede the existing pending row (if any) — atomic via
      // partial-unique guarantee + RETURNING. UPDATE matches at most ONE
      // row because the partial unique enforces "at most one pending per
      // (member, cycle)".
      const supersededRows = await tx
        .update(scheduledPlanChanges)
        .set({
          status: 'superseded',
          supersededAt: sql`now()`,
        })
        .where(
          and(
            eq(scheduledPlanChanges.memberId, input.memberId),
            eq(
              scheduledPlanChanges.effectiveAtCycleId,
              input.effectiveAtCycleId,
            ),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        )
        .returning();

      // Step 2: insert the fresh pending row in the SAME tx.
      const insertedRows = await tx
        .insert(scheduledPlanChanges)
        .values({
          // tenant_id is set by RLS USING/WITH CHECK; explicit set ensures
          // the INSERT passes WITH CHECK. RLS ensures it cannot be set to
          // any other tenant.
          tenantId: tenant.slug,
          memberId: input.memberId,
          effectiveAtCycleId: input.effectiveAtCycleId,
          fromPlanId: input.fromPlanId,
          toPlanId: input.toPlanId,
          scheduledByUserId: input.scheduledByUserId,
          reason: input.reason ?? null,
          // status defaults to 'pending'; explicit for clarity.
          status: 'pending',
        })
        .returning();

      const inserted = insertedRows[0];
      if (!inserted) {
        throw new Error(
          'supersedeAndInsertPendingAtomically: INSERT returned no row',
        );
      }

      const superseded = supersededRows[0] ?? null;
      return {
        inserted: rowToDomain(inserted),
        superseded: superseded ? rowToDomain(superseded) : null,
      };
    });
  },

  async findPendingForCycle(
    tenant: TenantContext,
    memberId: string,
    effectiveAtCycleId: string,
  ): Promise<ScheduledPlanChange | null> {
    return runInTenant(tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.memberId, memberId),
            eq(scheduledPlanChanges.effectiveAtCycleId, effectiveAtCycleId),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        )
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    });
  },

  // Primary-key lookup. RLS scopes to caller's tenant; explicit
  // tenant_id filter intentionally omitted per the
  // two-layer defence pattern (research.md § 7.1).
  async findById(
    tenant: TenantContext,
    scheduledChangeId: string,
  ): Promise<ScheduledPlanChange | null> {
    return runInTenant(tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.scheduledChangeId, scheduledChangeId))
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    });
  },

  async transitionStatus(
    tenant: TenantContext,
    scheduledChangeId: string,
    nextStatus: Exclude<ScheduledPlanChangeStatus, 'pending'>,
  ): Promise<ScheduledPlanChange> {
    return runInTenant(tenant, async (tx) => {
      // Conditional UPDATE: only flip if the source row is still 'pending'.
      // Mirrors the Domain rule (terminal-state immutability) at the DB
      // layer — defence in depth.
      const setClause: Record<string, unknown> = { status: nextStatus };
      if (nextStatus === 'applied') setClause.appliedAt = sql`now()`;
      if (nextStatus === 'superseded') setClause.supersededAt = sql`now()`;
      if (nextStatus === 'cancelled') setClause.cancelledAt = sql`now()`;

      const updated = await tx
        .update(scheduledPlanChanges)
        .set(setClause)
        .where(
          and(
            eq(scheduledPlanChanges.scheduledChangeId, scheduledChangeId),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        )
        .returning();

      if (updated.length === 0) {
        // Either the row doesn't exist (RLS-hidden or truly absent) OR
        // it is already terminal. Surface as a hard error — the use-case
        // asked for an impossible transition.
        throw new Error(
          `transitionStatus: row ${scheduledChangeId} not found or already terminal`,
        );
      }
      return rowToDomain(updated[0]!);
    });
  },

  async listForMember(
    tenant: TenantContext,
    memberId: string,
  ): Promise<readonly ScheduledPlanChange[]> {
    return runInTenant(tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, memberId))
        .orderBy(desc(scheduledPlanChanges.scheduledAt));
      return rows.map(rowToDomain);
    });
  },
};
