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
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { TERMINAL_BROADCAST_STATUSES } from '../../domain/value-objects/broadcast-status';
import type {
  OrphanOutcome,
  OrphanReason,
  OrphanResourceType,
} from '../../domain/value-objects/orphaned-resend-id';
import type {
  BroadcastOrphansRepo,
  OrphanedResendIdRef,
} from '../../application/ports/broadcast-orphans-repo';
import { broadcastOrphanedResendIds as orphans, broadcasts } from '../schema';
import { assertTenantBoundTx } from './drizzle-broadcasts-repo';

/** `TERMINAL_BROADCAST_STATUSES` as SQL binds — derived from the Domain, never hand-listed. */
const TERMINAL_IN = sql.join(
  TERMINAL_BROADCAST_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * [A1] No NON-TERMINAL `broadcasts` row of this tenant holds the orphan's id,
 * type-matched: a broadcast orphan against `resend_broadcast_id`, an audience
 * orphan against `resend_audience_id`. A terminal holder never blocks.
 */
function notHeldByLiveRow(tenantId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${broadcasts}
     WHERE ${broadcasts.tenantId} = ${tenantId}
       AND ${broadcasts.status}::text NOT IN (${TERMINAL_IN})
       AND (
         (${orphans.resourceType} = 'broadcast' AND ${broadcasts.resendBroadcastId} = ${orphans.resourceId})
         OR (${orphans.resourceType} = 'audience' AND ${broadcasts.resendAudienceId} = ${orphans.resourceId})
       )
  )`;
}

const COLUMNS = {
  orphanId: orphans.orphanId,
  broadcastId: orphans.broadcastId,
  requestedByMemberId: orphans.requestedByMemberId,
  resourceType: orphans.resourceType,
  resourceId: orphans.resourceId,
  reason: orphans.reason,
  createdAt: orphans.createdAt,
  outcome: orphans.outcome,
};

type SelectedRow = {
  orphanId: string;
  broadcastId: string;
  requestedByMemberId: string;
  resourceType: string;
  resourceId: string | null;
  reason: string;
  createdAt: Date;
  outcome: string | null;
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

    async listDrainableOrphans(limit) {
      return bound('listDrainableOrphans', async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug),
            ),
          )
          .orderBy(asc(orphans.createdAt), asc(orphans.orphanId))
          .limit(limit);
        return rows.map(toRef);
      });
    },

    async listMemberOrphans(requestedByMemberId) {
      return bound('listMemberOrphans', async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              eq(orphans.requestedByMemberId, requestedByMemberId),
              eq(orphans.resourceType, 'broadcast'),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug),
            ),
          )
          .orderBy(asc(orphans.createdAt), asc(orphans.orphanId));
        return rows.map(toRef);
      });
    },

    async listUnsettledAudienceOrphans(limit) {
      return bound('listUnsettledAudienceOrphans', async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(orphans)
          .where(
            and(
              eq(orphans.tenantId, ctx.slug),
              eq(orphans.resourceType, 'audience'),
              isNull(orphans.settledAt),
              isNotNull(orphans.resourceId),
              notHeldByLiveRow(ctx.slug),
            ),
          )
          .orderBy(asc(orphans.createdAt), asc(orphans.orphanId))
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
