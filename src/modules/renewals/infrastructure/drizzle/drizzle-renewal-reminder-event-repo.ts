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
 * Production callers across the F8 surface:
 *   - `insertIfAbsent` — `dispatchOneCycle` (cron + admin entry)
 *   - `transitionStatus` — `dispatchOneCycle` after gateway call +
 *     `defensivelyMarkFailedForRetry` cleanup tx (J2-B2)
 *   - `transitionFailedToSent` — `attemptRetry` Pass 1 success path
 *   - `markRetryExhausted` — `emitPermanentFailure` (Pass 1 4xx
 *     + Pass 2 budget exhaustion)
 *   - `listRetryEligible` — `runRetryPasses` Pass 1 cursor
 *   - `listRetryExhausted` — `runRetryPasses` Pass 2 cursor
 *   - `listForCycle` — admin cycle-detail page event timeline
 *   - `listFailedSince` — ops failure-cursor dashboard
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
      const txDb = tx as unknown as typeof db;
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
      const txDb = tx as unknown as typeof db;
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
      const txDb = tx as unknown as typeof db;
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
      const txDb = tx as unknown as typeof db;
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

    async bulkInsertIfAbsent(tx, inputs) {
      // F8 Phase 10 T262 batched-write — single multi-row INSERT
      // ON CONFLICT DO NOTHING against
      // `renewal_reminder_events_idem_idx` (tenant, cycle, step, year)
      // unique. Caller branches on whether each input came back as
      // `inserted` (proceed to gateway) or `conflicted` (skip with
      // already_sent reason). Mirrors single-row `insertIfAbsent`
      // semantics but in 1 RTT instead of N.
      if (inputs.length === 0) {
        return { inserted: [], conflicted: [] };
      }
      // R5-C2 fix: assert input.tenantId matches the adapter-bound
      // tenant slug. The single-row `insertIfAbsent` (line 84) silently
      // substitutes `tenant.slug` for `input.tenantId`; replicating
      // that contract here without a guard would let a future caller
      // pass mixed-tenant inputs that all collapse onto the bound
      // tenant — undetectable cross-tenant write. Assertion fails fast
      // so the bug surfaces at the call site, not as silent corruption.
      for (const input of inputs) {
        if (input.tenantId !== tenant.slug) {
          throw new Error(
            `bulkInsertIfAbsent: input.tenantId='${input.tenantId}' ≠ adapter tenant.slug='${tenant.slug}' — cross-tenant write blocked (Constitution Principle I)`,
          );
        }
      }
      const txDb = tx as unknown as typeof db;
      const insertValues = inputs.map((input) => ({
        tenantId: tenant.slug,
        cycleId: input.cycleId,
        stepId: input.stepId,
        yearInCycle: input.yearInCycle,
        channel: input.channel,
        templateId: input.templateId ?? null,
        taskType: input.taskType ?? null,
        actorUserId: input.actorUserId ?? null,
        status: 'pending' as const,
      }));
      const insertedRows = await txDb
        .insert(renewalReminderEvents)
        .values(insertValues)
        .onConflictDoNothing({
          target: [
            renewalReminderEvents.tenantId,
            renewalReminderEvents.cycleId,
            renewalReminderEvents.stepId,
            renewalReminderEvents.yearInCycle,
          ],
        })
        .returning();
      const inserted = insertedRows.map(rowToDomain);
      // R6-H1-code fix: identify conflicted inputs via per-key COUNT
      // bookkeeping so duplicate inputs (same natural key in the same
      // batch) are handled correctly. Pre-fix: a Set-membership filter
      // mis-classified the second occurrence of `[A, A]` as conflicted
      // when in fact only ONE of them was inserted (Postgres ON
      // CONFLICT DO NOTHING absorbs the second). The COUNT pattern:
      //   - Each input contributes +1 to its natural-key bucket.
      //   - Each inserted row consumes -1 from its bucket.
      //   - Remaining +N counts represent N conflicted inputs.
      // This handles both within-batch duplicates AND replay conflicts
      // against pre-existing rows symmetrically.
      const keyOf = (k: { cycleId: string; stepId: string; yearInCycle: number }) =>
        `${k.cycleId}::${k.stepId}::${k.yearInCycle}`;
      const inputCountByKey = new Map<string, number>();
      for (const input of inputs) {
        const key = keyOf(input);
        inputCountByKey.set(key, (inputCountByKey.get(key) ?? 0) + 1);
      }
      for (const r of inserted) {
        const key = keyOf(r);
        const remaining = (inputCountByKey.get(key) ?? 0) - 1;
        if (remaining > 0) inputCountByKey.set(key, remaining);
        else inputCountByKey.delete(key);
      }
      // Project the remaining counts back to their input shapes by
      // walking inputs once and emitting matches for each remaining
      // count. Preserves input order for deterministic caller-side
      // emission of `already_sent` audits.
      const conflicted: Array<NewReminderEventInput> = [];
      const consumed = new Map<string, number>();
      for (const input of inputs) {
        const key = keyOf(input);
        const cnt = inputCountByKey.get(key) ?? 0;
        const used = consumed.get(key) ?? 0;
        if (cnt > used) {
          conflicted.push(input);
          consumed.set(key, used + 1);
        }
      }
      return { inserted, conflicted };
    },

    async bulkTransitionToSent(tx, inputs) {
      // F8 Phase 10 T262 batched-write — single multi-row UPDATE via
      // `UPDATE … SET … FROM (VALUES …) v WHERE id = v.id`. All
      // reminder_events flip pending → sent in 1 RTT. Caller MUST pair
      // with `bulkEmitInTx` for the matching `renewal_reminder_sent`
      // audits inside the SAME `runInTenant` block per Constitution
      // Principle VIII state↔audit atomicity.
      if (inputs.length === 0) {
        return [];
      }
      // R5-C2 fix: tenantId guard symmetric with bulkInsertIfAbsent.
      for (const input of inputs) {
        if (input.tenantId !== tenant.slug) {
          throw new Error(
            `bulkTransitionToSent: input.tenantId='${input.tenantId}' ≠ adapter tenant.slug='${tenant.slug}' — cross-tenant write blocked (Constitution Principle I)`,
          );
        }
      }
      const txDb = tx as unknown as typeof db;
      // R5-C2 fix: rewrite as `UPDATE … FROM (VALUES …)` instead of
      // CASE WHEN. The CASE form had no ELSE arm — a row matched by
      // `id IN (...)` but somehow missing from the CASE branches would
      // be SET to NULL silently. The VALUES-join form makes the
      // payload-to-row binding explicit and lets the WHERE clause join
      // do the matching, so a missing row simply doesn't update
      // (caller's row-count assertion below catches it).
      const valuesRows = sql.join(
        inputs.map(
          (i) =>
            sql`(${i.reminderEventId}::uuid, ${i.dispatchedAt}::timestamptz, ${i.deliveryId}::text)`,
        ),
        sql`, `,
      );
      // postgres-js returns rows as a plain array via drizzle's
      // `.execute()`; cast to the schema's $inferSelect for downstream
      // rowToDomain mapping. Note: snake_case column names from raw SQL
      // do not auto-map to camelCase; the rowToDomain helper expects
      // schema-typed rows so we re-fetch through the typed query layer
      // after the raw UPDATE for correctness.
      // R6-M3-err: tenant filter on the raw UPDATE itself (defence-in-
       // depth alongside RLS). The `r.tenant_id = ${tenant.slug}` clause
       // ensures even a future RLS misconfig cannot let this UPDATE
       // touch another tenant's rows. Mirrors the J9-M1 single-row
       // pattern.
      await txDb.execute(
        sql`
          UPDATE ${renewalReminderEvents} AS r
          SET status = 'sent',
              dispatched_at = v.dispatched_at,
              delivery_id = v.delivery_id
          FROM (VALUES ${valuesRows}) AS v(reminder_event_id, dispatched_at, delivery_id)
          WHERE r.reminder_event_id = v.reminder_event_id
            AND r.tenant_id = ${tenant.slug}
            AND r.status = 'pending'
        `,
      );
      const ids = inputs.map((i) => i.reminderEventId);
      const expectedDeliveryIds = inputs.map((i) => i.deliveryId);
      const updatedRows = await txDb
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            // R6-M3-err: defence-in-depth tenant filter at the
            // application layer (RLS already enforces, but
            // Constitution Principle I clause 1 mandates BOTH layers).
            // Mirrors the J9-M1 pattern from the single-row insertIfAbsent
            // (line 132) — closes the leak even if RLS is bypassed.
            eq(renewalReminderEvents.tenantId, tenant.slug),
            inArray(renewalReminderEvents.reminderEventId, ids),
            eq(renewalReminderEvents.status, 'sent'),
            // R6-H1-err: also verify the deliveryId matches OUR
            // expected values. Without this, a concurrent admin
            // "Send reminder now" that updated the same row with a
            // different deliveryId would still satisfy the row-count
            // check (status='sent' + id matches) but the bench would
            // return rows with the WRONG deliveryId. The IN-list
            // ensures we only count rows OUR bulk-flush actually wrote.
            inArray(renewalReminderEvents.deliveryId, expectedDeliveryIds),
          ),
        );
      // R5-C2 fix: row-count assertion — partial UPDATE (e.g. a
      // reminderEventId that doesn't exist OR is no longer 'pending'
      // because of a concurrent admin "Send reminder now" race) MUST
      // fail loudly so the caller's runInTenant rolls back and the
      // outer cron pass surfaces a real error. Silent partial-update
      // would leave audit emits dangling without state changes.
      if (updatedRows.length !== inputs.length) {
        throw new Error(
          `bulkTransitionToSent: expected ${inputs.length} rows updated, got ${updatedRows.length} — concurrent state race or stale reminderEventId; tx will roll back`,
        );
      }
      return updatedRows.map(rowToDomain);
    },
  };
}
