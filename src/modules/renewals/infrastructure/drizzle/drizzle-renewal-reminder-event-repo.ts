/**
 * F8 Phase 4 Wave I2c — Drizzle adapter for `RenewalReminderEventRepo`.
 *
 * Implements the F8 port `RenewalReminderEventRepo` (Wave E T042)
 * against the `renewal_reminder_events` table (Wave C migration 0088).
 * Tenant isolation is enforced by Postgres RLS+FORCE — every method
 * wraps its query in `runInTenant(ctx, …)`.
 *
 * The idempotency primitive `renewal_reminder_events_idem_idx UNIQUE
 * (tenant, cycle, step_id, year_in_cycle)` is the single source of
 * truth for "has this step already fired this year"; `insertIfAbsent`
 * is `INSERT … ON CONFLICT DO NOTHING` against that exact target so
 * concurrent cron passes serialise deterministically.
 *
 * Phase 4 directly exercises:
 *   - `insertIfAbsent` — by `dispatchOneCycle` (T088 + T089)
 *   - `transitionStatus` — by `dispatchOneCycle` after gateway call
 *
 * `listForCycle` + `listFailedSince` ship for port completeness; admin
 * cycle-detail page (Wave I8) + ops failure-cursor (Wave I8) consume
 * them. Adapter ships full surface so no rework when those waves land.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import {
  renewalReminderEvents,
  type RenewalReminderEventRow,
} from '../schema-renewal-reminder-events';
import {
  ReminderEventNotFoundError,
  type ListRetryEligibleArgs,
  type ListRetryExhaustedArgs,
  type MarkRetryExhaustedInput,
  type NewReminderEventInput,
  type ReminderEvent,
  type ReminderEventChannel,
  type ReminderEventStatus,
  type ReminderEventTransitionInput,
  type RenewalReminderEventRepo,
} from '../../application/ports/renewal-reminder-event-repo';
import type { CycleId } from '../../domain/renewal-cycle';

// ---------------------------------------------------------------------------
// Row → Domain translation
// ---------------------------------------------------------------------------

function rowToDomain(row: RenewalReminderEventRow): ReminderEvent {
  return {
    tenantId: row.tenantId,
    reminderEventId: row.reminderEventId,
    cycleId: row.cycleId,
    stepId: row.stepId,
    channel: row.channel as ReminderEventChannel,
    templateId: row.templateId,
    taskType: row.taskType,
    dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
    deliveryId: row.deliveryId,
    status: row.status as ReminderEventStatus,
    skipReason: row.skipReason,
    failureReason: row.failureReason,
    actorUserId: row.actorUserId,
    yearInCycle: row.yearInCycle,
    createdAt: row.createdAt.toISOString(),
    retryUntil: row.retryUntil ? row.retryUntil.toISOString() : null,
    retryExhaustedAt: row.retryExhaustedAt
      ? row.retryExhaustedAt.toISOString()
      : null,
  };
}

// ---------------------------------------------------------------------------
// Per-tenant factory
// ---------------------------------------------------------------------------

export function makeDrizzleRenewalReminderEventRepo(
  tenant: TenantContext,
): RenewalReminderEventRepo {
  return {
    async insertIfAbsent(tx: unknown, input: NewReminderEventInput) {
      const txDb = tx as typeof db;
      // ON CONFLICT against the unique idem index — Drizzle infers
      // the target from the `target` columns + the index's WHERE
      // clause is full-coverage (no partial), so no targetWhere
      // needed. Exact column set: (tenant_id, cycle_id, step_id,
      // year_in_cycle) per migration 0088.
      const inserted = await txDb
        .insert(renewalReminderEvents)
        .values({
          tenantId: tenant.slug,
          cycleId: input.cycleId,
          stepId: input.stepId,
          yearInCycle: input.yearInCycle,
          channel: input.channel,
          templateId: input.templateId ?? null,
          taskType: input.taskType ?? null,
          actorUserId: input.actorUserId ?? null,
          status: 'pending',
        })
        .onConflictDoNothing({
          target: [
            renewalReminderEvents.tenantId,
            renewalReminderEvents.cycleId,
            renewalReminderEvents.stepId,
            renewalReminderEvents.yearInCycle,
          ],
        })
        .returning();
      if (inserted[0]) {
        return { created: true, row: rowToDomain(inserted[0]) };
      }
      // Conflict → SELECT the existing row.
      // J9-M1: include `tenant_id` in the WHERE clause as defence-
      // in-depth. RLS already enforces tenant scoping at the SQL
      // layer, so the previous query was correct under MTA+STD —
      // but Constitution Principle I clause 1 mandates application-
      // layer + database-layer tenant filters. If a future RLS
      // misconfig or a `runInTenant` regression caused this SELECT
      // to run unbound, a UUID collision (`cycle_id, step_id,
      // year_in_cycle` matches across tenants) would silently
      // return another tenant's row. Adding the tenant_id filter
      // closes the leak even if RLS is somehow bypassed.
      const existing = await txDb
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenant.slug),
            eq(renewalReminderEvents.cycleId, input.cycleId),
            eq(renewalReminderEvents.stepId, input.stepId),
            eq(renewalReminderEvents.yearInCycle, input.yearInCycle),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        throw new Error(
          `insertIfAbsent: ON CONFLICT DO NOTHING returned no row but no existing reminder event found — RLS or unique-index regression`,
        );
      }
      return { created: false, row: rowToDomain(existing[0]) };
    },

    async transitionStatus(
      tx: unknown,
      input: ReminderEventTransitionInput,
    ): Promise<ReminderEvent> {
      const txDb = tx as typeof db;
      // WHERE status='pending' guarantees only one transition wins
      // — defends against racing dispatch attempts (e.g., admin
      // "Send reminder now" colliding with the cron run). Wave I2e
      // also relaxes this for the retry path: the retry use-case
      // calls `transitionStatusFromFailed` (separate method below)
      // because retry events are already at status='failed'.
      const setClause: Partial<typeof renewalReminderEvents.$inferInsert> = {
        status: input.nextStatus,
        dispatchedAt: input.dispatchedAt
          ? new Date(input.dispatchedAt)
          : null,
        deliveryId: input.deliveryId ?? null,
        skipReason: input.skipReason ?? null,
        failureReason: input.failureReason ?? null,
      };
      // Wave I2e — retry_until is set/cleared with the transition.
      // Undefined = leave column unchanged (preserves current value).
      if (input.retryUntil !== undefined) {
        setClause.retryUntil = input.retryUntil
          ? new Date(input.retryUntil)
          : null;
      }
      const updated = await txDb
        .update(renewalReminderEvents)
        .set(setClause)
        .where(
          and(
            eq(renewalReminderEvents.reminderEventId, input.reminderEventId),
            eq(renewalReminderEvents.status, 'pending'),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ReminderEventNotFoundError(input.reminderEventId);
      }
      return rowToDomain(updated[0]);
    },

    async transitionFailedToSent(
      tx: unknown,
      input: {
        readonly tenantId: string;
        readonly reminderEventId: string;
        readonly dispatchedAt: string;
        readonly deliveryId: string;
      },
    ): Promise<ReminderEvent> {
      const txDb = tx as typeof db;
      // WHERE status='failed' AND retry_exhausted_at IS NULL — defends
      // against (a) concurrent retry passes both attempting flip and
      // (b) flipping a row that was already permanently exhausted by a
      // prior retry pass.
      const updated = await txDb
        .update(renewalReminderEvents)
        .set({
          status: 'sent',
          dispatchedAt: new Date(input.dispatchedAt),
          deliveryId: input.deliveryId,
          retryUntil: null,
          failureReason: null,
        })
        .where(
          and(
            eq(renewalReminderEvents.reminderEventId, input.reminderEventId),
            eq(renewalReminderEvents.status, 'failed'),
            sql`${renewalReminderEvents.retryExhaustedAt} IS NULL`,
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ReminderEventNotFoundError(input.reminderEventId);
      }
      return rowToDomain(updated[0]);
    },

    async listForCycle(
      _tenantId: string,
      cycleId: CycleId,
    ): Promise<ReadonlyArray<ReminderEvent>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalReminderEvents)
          .where(eq(renewalReminderEvents.cycleId, cycleId))
          .orderBy(
            sql`${renewalReminderEvents.dispatchedAt} DESC NULLS LAST`,
          );
        return rows.map(rowToDomain);
      });
    },

    async listFailedSince(
      _tenantId: string,
      sinceIso: string,
      limit: number,
    ): Promise<ReadonlyArray<ReminderEvent>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalReminderEvents)
          .where(
            and(
              eq(renewalReminderEvents.status, 'failed'),
              sql`${renewalReminderEvents.createdAt} >= ${sinceIso}`,
            ),
          )
          .orderBy(desc(renewalReminderEvents.createdAt))
          .limit(limit);
        return rows.map(rowToDomain);
      });
    },

    async listRetryEligible(
      _tenantId: string,
      args: ListRetryEligibleArgs,
    ): Promise<ReadonlyArray<ReminderEvent>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalReminderEvents)
          .where(
            and(
              eq(renewalReminderEvents.status, 'failed'),
              sql`${renewalReminderEvents.retryUntil} > ${args.nowIso}`,
              sql`${renewalReminderEvents.retryExhaustedAt} IS NULL`,
            ),
          )
          .orderBy(asc(renewalReminderEvents.retryUntil))
          .limit(args.pageSize);
        return rows.map(rowToDomain);
      });
    },

    async listRetryExhausted(
      _tenantId: string,
      args: ListRetryExhaustedArgs,
    ): Promise<ReadonlyArray<ReminderEvent>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalReminderEvents)
          .where(
            and(
              eq(renewalReminderEvents.status, 'failed'),
              sql`${renewalReminderEvents.retryUntil} <= ${args.nowIso}`,
              sql`${renewalReminderEvents.retryExhaustedAt} IS NULL`,
            ),
          )
          .orderBy(asc(renewalReminderEvents.retryUntil))
          .limit(args.pageSize);
        return rows.map(rowToDomain);
      });
    },

    async markRetryExhausted(
      tx: unknown,
      input: MarkRetryExhaustedInput,
    ): Promise<ReminderEvent> {
      const txDb = tx as typeof db;
      // WHERE retry_exhausted_at IS NULL ensures only one caller wins
      // — concurrent retry-pass invocations deterministically produce
      // one permanent-audit emission per row.
      const updated = await txDb
        .update(renewalReminderEvents)
        .set({ retryExhaustedAt: new Date(input.exhaustedAtIso) })
        .where(
          and(
            eq(renewalReminderEvents.reminderEventId, input.reminderEventId),
            sql`${renewalReminderEvents.retryExhaustedAt} IS NULL`,
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ReminderEventNotFoundError(input.reminderEventId);
      }
      return rowToDomain(updated[0]);
    },
  };
}
