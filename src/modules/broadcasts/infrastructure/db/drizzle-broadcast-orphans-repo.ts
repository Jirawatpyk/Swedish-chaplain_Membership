/**
 * Spec 140 s2c — the Drizzle adapter of `BroadcastOrphansRepo` over
 * `broadcast_orphaned_resend_ids` (migration 0325).
 *
 * Bound to one tenant. Every method opens its own `runInTenant` transaction
 * (chamber_app, `SET LOCAL app.current_tenant`), checks that binding with
 * `assertTenantBoundTx`, and fences every table it names on `tenant_id`
 * (D-029) — the NOT EXISTS subquery's `broadcasts` reference included — so the
 * application predicate and RLS + FORCE are two walls, not one.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { TERMINAL_BROADCAST_STATUSES } from '../../domain/value-objects/broadcast-status';
import {
  ORPHAN_SUPERSEDING_STATUSES,
  type OrphanOutcome,
  type OrphanReason,
  type OrphanResourceType,
} from '../../domain/value-objects/orphaned-resend-id';
import type {
  BroadcastOrphansRepo,
  OrphanedResendIdRef,
} from '../../application/ports/broadcast-orphans-repo';
import { broadcastOrphanedResendIds as orphans, broadcasts } from '../schema';
import { assertTenantBoundTx } from './drizzle-broadcasts-repo';
import { orphanStuckSql } from './_orphan-stuck-sql';

/** `TERMINAL_BROADCAST_STATUSES` as SQL binds — derived from the Domain, never hand-listed. */
const TERMINAL_IN = sql.join(
  TERMINAL_BROADCAST_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** `ORPHAN_SUPERSEDING_STATUSES` as SQL binds (review round 2, code-review #2). */
const SUPERSEDING_IN = sql.join(
  ORPHAN_SUPERSEDING_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * Review round 2 (code-review #2) — a BROADCAST orphan whose id a row of this
 * tenant in `ORPHAN_SUPERSEDING_STATUSES` holds (the port's `heldBySentRow`).
 * A SELECT-list expression: Drizzle renders a column there UNQUALIFIED, so an
 * inner `"tenant_id"` would bind by SQL scope alone. Every name is written
 * qualified instead (the subquery's table under the alias `held`).
 */
function heldBySentRow(tenantId: string) {
  return sql<boolean>`("broadcast_orphaned_resend_ids"."resource_type" = 'broadcast' AND EXISTS (
    SELECT 1 FROM ${broadcasts} AS held
     WHERE held.tenant_id = ${tenantId}
       AND held.resend_broadcast_id = "broadcast_orphaned_resend_ids"."resource_id"
       AND held.status::text IN (${SUPERSEDING_IN})
  ))`;
}

/**
 * [A1] No live `broadcasts` row of this tenant holds the orphan's id,
 * type-matched: a broadcast orphan against `resend_broadcast_id` held by a
 * NON-TERMINAL row; an audience orphan against `resend_audience_id` held by a
 * non-terminal row OR (review round 1, code-review #3) by a terminal row whose
 * `updated_at` is at or after `audienceGraceCutoff` — the existing audience
 * loop's `GRACE_MS`. `null` = no audience grace (the member list reads
 * broadcast orphans only).
 */
function notHeldByLiveRow(tenantId: string, audienceGraceCutoff: Date | null) {
  const cutoff = audienceGraceCutoff === null ? null : audienceGraceCutoff.toISOString();
  return sql`NOT EXISTS (
    SELECT 1 FROM ${broadcasts}
     WHERE ${broadcasts.tenantId} = ${tenantId}
       AND (
         (${orphans.resourceType} = 'broadcast' AND ${broadcasts.resendBroadcastId} = ${orphans.resourceId}
           AND ${broadcasts.status}::text NOT IN (${TERMINAL_IN}))
         OR (${orphans.resourceType} = 'audience' AND ${broadcasts.resendAudienceId} = ${orphans.resourceId}
           AND (${broadcasts.status}::text NOT IN (${TERMINAL_IN})
                OR ${broadcasts.updatedAt} >= ${cutoff}::timestamptz))
       )
  )`;
}

const columns = (tenantId: string) => ({
  orphanId: orphans.orphanId,
  broadcastId: orphans.broadcastId,
  requestedByMemberId: orphans.requestedByMemberId,
  resourceType: orphans.resourceType,
  resourceId: orphans.resourceId,
  reason: orphans.reason,
  createdAt: orphans.createdAt,
  outcome: orphans.outcome,
  attempts: orphans.attempts,
  heldBySentRow: heldBySentRow(tenantId),
});

type SelectedRow = {
  orphanId: string;
  broadcastId: string;
  requestedByMemberId: string;
  resourceType: string;
  resourceId: string | null;
  reason: string;
  createdAt: Date;
  outcome: string | null;
  attempts: number;
  heldBySentRow: boolean;
};

function toRef(r: SelectedRow): OrphanedResendIdRef {
  return {
    orphanId: r.orphanId,
    broadcastId: r.broadcastId,
    requestedByMemberId: r.requestedByMemberId,
    // The 0325 CHECKs close all three sets; the casts state what they admit.
    resourceType: r.resourceType as OrphanResourceType,
    // NOT NULL by every read's WHERE.
    resourceId: r.resourceId ?? '',
    reason: r.reason as OrphanReason,
    createdAt: r.createdAt,
    outcome: r.outcome as OrphanOutcome | null,
    attempts: r.attempts,
    heldBySentRow: r.heldBySentRow === true,
  };
}

export function makeDrizzleBroadcastOrphansRepo(tenantId: string): BroadcastOrphansRepo {
  const ctx = asTenantContext(tenantId);
  const bound = async <T>(name: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    runInTenant(ctx, async (tx) => {
      await assertTenantBoundTx(tx, ctx.slug, name);
      return fn(tx);
    });

  return {
    async recordOrphanedResendId(input) {
      await bound('recordOrphanedResendId', async (tx) => {
        await tx
          .insert(orphans)
          .values({
            tenantId: ctx.slug,
            broadcastId: input.broadcastId as string,
            requestedByMemberId: input.requestedByMemberId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            reason: input.reason,
          })
          .onConflictDoNothing();
      });
    },

    async listDrainableOrphans(limit, audienceGraceCutoff) {
      return bound('listDrainableOrphans', async (tx) => {
        const rows = await tx
          .select(columns(ctx.slug))
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug, audienceGraceCutoff),
            ),
          )
          // Review round 2 (code-review #3) — past-grace rows first (false < true).
          .orderBy(
            asc(sql`(${orphans.createdAt} >= ${audienceGraceCutoff.toISOString()}::timestamptz)`),
            asc(orphans.attempts),
            asc(orphans.createdAt),
            asc(orphans.orphanId),
          )
          .limit(limit);
        return rows.map(toRef);
      });
    },

    // Spec 140 s2d (#736a) — the requesters of the unsettled in-grace rows.
    // The WHERE has the shape of the 0325 partial index (tenant_id, created_at)
    // WHERE settled_at IS NULL (on the dev branch's few rows the planner
    // seq-scans). ORDER BY the selected column keeps a capped answer stable
    // from run to run.
    async listInGraceRequesterIds(graceCutoff, cap) {
      return bound('listInGraceRequesterIds', async (tx) => {
        const rows = await tx
          .selectDistinct({ requestedByMemberId: orphans.requestedByMemberId })
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              gte(orphans.createdAt, graceCutoff),
            ),
          )
          .orderBy(asc(orphans.requestedByMemberId))
          .limit(cap);
        return rows.map((r) => r.requestedByMemberId);
      });
    },

    // Spec 140 s2d (#736a) — the erased requesters' rows, read first by the
    // drain; the same holder rule as listDrainableOrphans (B2).
    async listUnsettledOrphansForRequesters(requestedByMemberIds, limit, audienceGraceCutoff) {
      if (requestedByMemberIds.length === 0) return [];
      return bound('listUnsettledOrphansForRequesters', async (tx) => {
        const rows = await tx
          .select(columns(ctx.slug))
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              inArray(orphans.requestedByMemberId, [...requestedByMemberIds]),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug, audienceGraceCutoff),
            ),
          )
          .orderBy(asc(orphans.attempts), asc(orphans.createdAt), asc(orphans.orphanId))
          .limit(limit);
        return rows.map(toRef);
      });
    },

    async listMemberOrphans(requestedByMemberId) {
      return bound('listMemberOrphans', async (tx) => {
        const rows = await tx
          .select(columns(ctx.slug))
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              eq(orphans.requestedByMemberId, requestedByMemberId),
              eq(orphans.resourceType, 'broadcast'),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug, null),
            ),
          )
          .orderBy(asc(orphans.createdAt), asc(orphans.orphanId));
        return rows.map(toRef);
      });
    },

    async listUnsettledAudienceOrphans(limit, audienceGraceCutoff, stuckAgeCutoff) {
      return bound('listUnsettledAudienceOrphans', async (tx) => {
        const rows = await tx
          .select(columns(ctx.slug))
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              eq(orphans.resourceType, 'audience'),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug, audienceGraceCutoff),
            ),
          )
          // Review round 3 (code-review #1) — stuck rows last (false < true),
          // the same rule as the caller's isStuck. Round 4 follow-up
          // (code-review #4): created_at at millisecond precision, as the
          // driver hands it to the app, so the two never disagree.
          // Spec 140 s2d (#736b) — the rule is orphanStuckSql, shared with
          // the detach cap; the cutoff is the caller's.
          .orderBy(
            asc(orphanStuckSql(sql`${orphans.attempts}`, sql`${orphans.createdAt}`, stuckAgeCutoff)),
            asc(orphans.attempts),
            asc(orphans.createdAt),
            asc(orphans.orphanId),
          )
          .limit(limit);
        return rows.map(toRef);
      });
    },

    async settleOrphan(orphanId, outcome) {
      return bound('settleOrphan', async (tx) => {
        const rows = await tx
          .update(orphans)
          .set({ settledAt: sql`now()`, outcome })
          .where(and(eq(orphans.tenantId, ctx.slug), eq(orphans.orphanId, orphanId), isNull(orphans.settledAt)))
          .returning({ orphanId: orphans.orphanId });
        return rows.length === 1;
      });
    },

    async markOrphanAttempted(orphanId) {
      return bound('markOrphanAttempted', async (tx) => {
        const rows = await tx
          .update(orphans)
          .set({ attempts: sql`${orphans.attempts} + 1`, lastAttemptedAt: sql`now()` })
          .where(and(eq(orphans.tenantId, ctx.slug), eq(orphans.orphanId, orphanId), isNull(orphans.settledAt)))
          .returning({ orphanId: orphans.orphanId });
        return rows.length === 1;
      });
    },

    async pruneOrphans(cutoff) {
      return bound('pruneOrphans', async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT prune_orphaned_resend_ids(${ctx.slug}, ${cutoff.toISOString()}::timestamptz) AS pruned`,
        )) as unknown as Array<{ pruned: number | string | null }>;
        return Number(rows[0]?.pruned ?? 0);
      });
    },
  };
}
