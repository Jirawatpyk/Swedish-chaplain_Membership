/**
 * F8 Phase 4 Wave I1a · T083 — Drizzle adapter for
 * `TenantRenewalSchedulePolicyRepo`.
 *
 * Implements the F8 port `TenantRenewalSchedulePolicyRepo` (Wave E
 * T046) against the `tenant_renewal_schedule_policies` table (Wave C
 * migration 0089). Tenant isolation is enforced by Postgres RLS+FORCE
 * — every method wraps its query in `runInTenant(ctx, …)` which sets
 * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`. NO
 * explicit `WHERE tenant_id = ?` — the policy adds it automatically
 * (research.md § 7.1).
 *
 * Phase 4 (US2) directly exercises:
 *   - `findByBucket`     — daily dispatcher cron looks up the policy
 *                          for each member's frozen `tier_at_cycle_start`
 *   - `listAllForTenant` — admin /admin/renewals/settings/schedules
 *                          editor page reads all 5 buckets
 *   - `upsertSteps`      — admin schedule editor PUT route saves
 *                          validated step list (caller pre-validates
 *                          via Domain `parseSchedulePolicySteps`)
 */
import { eq, asc } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import {
  tenantRenewalSchedulePolicies,
  type TenantRenewalSchedulePolicyRow,
  type ScheduleStepJson,
} from '../schema-tenant-renewal-config';
import type { TenantRenewalSchedulePolicyRepo } from '../../application/ports/tenant-renewal-schedule-policy-repo';
import type { TenantRenewalSchedulePolicy } from '../../domain/tenant-renewal-schedule-policy';
import {
  parseReminderStep,
  reminderStepToJson,
  type ReminderStep,
} from '../../domain/value-objects/reminder-step';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';

// ---------------------------------------------------------------------------
// Row → Domain translation
// ---------------------------------------------------------------------------

/**
 * Translate a Drizzle row into a typed `TenantRenewalSchedulePolicy`.
 *
 * Steps_jsonb is parsed step-by-step via `parseReminderStep` so a
 * malformed legacy row (e.g. seed migration with a future `assignee_role`
 * value) yields a clear "step at index N: <error>" message instead of a
 * silent type erasure. A row that has been admin-saved successfully
 * always round-trips cleanly because `update-schedule-policy` validates
 * via the same Domain parser before persisting.
 *
 * If parsing ANY step fails, throws a uniform invariant-violation error
 * naming the (tenantId, tier_bucket, index) so Sentry triage is trivial.
 * Steps are sorted by `offsetDays` ascending to match the Domain entity
 * invariant.
 */
export function rowToDomain(
  row: TenantRenewalSchedulePolicyRow,
): TenantRenewalSchedulePolicy {
  const stepsRaw = row.stepsJsonb as readonly ScheduleStepJson[];
  const parsed: ReminderStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const r = parseReminderStep(stepsRaw[i]!);
    if (!r.ok) {
      throw new Error(
        `F8 invariant violation: tenant_renewal_schedule_policies row ` +
          `(tenant_id=${row.tenantId}, tier_bucket=${row.tierBucket}) ` +
          `step at index ${i} failed parse: ${r.error.kind} — ` +
          `DB CHECK / app-layer validator regression`,
      );
    }
    parsed.push(r.value);
  }
  parsed.sort((a, b) => a.offsetDays - b.offsetDays);
  return {
    tenantId: row.tenantId,
    tierBucket: row.tierBucket as TierBucket,
    steps: parsed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Per-tenant factory
// ---------------------------------------------------------------------------

export function makeDrizzleTenantRenewalSchedulePolicyRepo(
  tenant: TenantContext,
): TenantRenewalSchedulePolicyRepo {
  return {
    async findByBucket(
      _tenantId: string,
      tierBucket: TierBucket,
    ): Promise<TenantRenewalSchedulePolicy | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantRenewalSchedulePolicies)
          .where(eq(tenantRenewalSchedulePolicies.tierBucket, tierBucket))
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    async listAllForTenant(
      _tenantId: string,
    ): Promise<ReadonlyArray<TenantRenewalSchedulePolicy>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantRenewalSchedulePolicies)
          .orderBy(asc(tenantRenewalSchedulePolicies.tierBucket));
        return rows.map(rowToDomain);
      });
    },

    async upsertSteps(
      tx: unknown,
      tenantId: string,
      tierBucket: TierBucket,
      steps: ReadonlyArray<ReminderStep>,
    ): Promise<TenantRenewalSchedulePolicy> {
      const txDb = tx as typeof db;
      const stepsJson = steps.map(reminderStepToJson) as readonly ScheduleStepJson[];
      // Upsert by composite PK (tenant_id, tier_bucket). Always set
      // updated_at = NOW() on conflict so the admin editor's "last
      // saved at" surface stays accurate. created_at is preserved on
      // conflict (initial seed timestamp persists for audit purposes).
      const inserted = await txDb
        .insert(tenantRenewalSchedulePolicies)
        .values({
          tenantId: tenant.slug,
          tierBucket,
          stepsJsonb: stepsJson,
        })
        .onConflictDoUpdate({
          target: [
            tenantRenewalSchedulePolicies.tenantId,
            tenantRenewalSchedulePolicies.tierBucket,
          ],
          set: {
            stepsJsonb: stepsJson,
            updatedAt: new Date(),
          },
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error(
          `upsertSteps: returning produced no row (tenant=${tenantId}, bucket=${tierBucket}) — ` +
            'RLS policy denied INSERT/UPDATE? Verify runInTenant binding before calling upsertSteps in a tx.',
        );
      }
      return rowToDomain(row);
    },
  };
}
