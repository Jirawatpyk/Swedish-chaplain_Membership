/**
 * F9 cross-member benefit-consumption aggregate adapter (go-live P1-4 / FR-004).
 *
 * Two batched GROUP BY queries — ONE per benefit, regardless of member count —
 * that roll up every member's current-year consumption for the quota cards.
 * This is the perf core of Approach C: the snapshot never loops N members
 * (avoids N+1; constant query count) yet keeps all aggregate SQL inside the F9
 * infrastructure layer rather than widening the shipped F6/F7 barrels.
 *
 * Reaches into the broadcasts + events Drizzle SCHEMA directly — the same
 * documented escape-hatch `plan-source-adapter` uses for the F2 plan repo (a
 * module's public barrel cannot re-export Drizzle tables without dragging
 * postgres into client bundles; the cross-module ESLint guard scopes to
 * Presentation↔module, not module↔module). Both queries run inside
 * `runInTenant(ctx, tx)` so RLS+FORCE enforces tenant isolation at the DB layer
 * (Constitution Principle I) — defence-in-depth `tenantId` predicates are added
 * on top.
 *
 * The filters MUST stay byte-equivalent to the per-member sources:
 *   - E-Blast: `status='sent' AND quotaYearConsumed=$year` (matches
 *     `drizzle-broadcasts-repo.countForMemberQuota`).
 *   - Cultural: `isCulturalEvent=true AND startDate ∈ [yearStart, min(yearEnd,
 *     now)] AND piiPseudonymisedAt IS NULL AND archivedAt IS NULL` (matches
 *     `drizzle-event-attendees-by-member` + the F9 event-source year window;
 *     `isCulturalEvent=true` ⇔ `eventType.includes('cultural')` since both
 *     `cultural` and `partnership_and_cultural` set that flag).
 * An equivalence integration test pins this against the per-member path so any
 * future F6/F7 filter change fails loudly here first.
 *
 * Fail-loud by default: a Drizzle error rejects (never resolves an empty Map),
 * so the snapshot surfaces `compute_failed` instead of a false-zero under-use
 * count. An ABSENT member key means "sent/attended 0" (caller reads `?? 0`).
 *
 * Pure Infrastructure — Drizzle types are confined to this file.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import type { TenantContext } from '@/modules/tenants';
import { tenantYearBoundsUtcMs } from '../../application/tenant-year';
import type { BenefitConsumptionAggregateSource } from '../../application/ports/source-ports';

export function toCountMap(
  rows: ReadonlyArray<{ readonly memberId: string | null; readonly used: number }>,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    // A null group-key is a non-member row (unmatched attendee / orphaned
    // broadcast) — never a quota holder; skip it.
    if (r.memberId !== null) map.set(r.memberId, r.used);
  }
  return map;
}

export const benefitConsumptionAggregateAdapter: BenefitConsumptionAggregateSource =
  {
    async eblastUsedByMember(
      ctx: TenantContext,
      membershipYear: number,
    ): Promise<ReadonlyMap<string, number>> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            memberId: broadcasts.requestedByMemberId,
            used: sql<number>`COUNT(*)::int`,
          })
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, ctx.slug),
              eq(broadcasts.status, 'sent'),
              eq(broadcasts.quotaYearConsumed, membershipYear),
            ),
          )
          .groupBy(broadcasts.requestedByMemberId);
        return toCountMap(rows);
      });
    },

    async culturalUsedByMember(
      ctx: TenantContext,
      membershipYear: number,
    ): Promise<ReadonlyMap<string, number>> {
      // Same tenant-tz year window as the per-member event source: count
      // cultural attendances keyed on `events.start_date` within
      // [yearStart, min(yearEnd, now)] so a future-dated registration is not a
      // "used" ticket and a 31-Dec 23:00 ICT event counts in the right year.
      const { startMs, endMs } = tenantYearBoundsUtcMs(
        membershipYear,
        env.tenant.timezone,
      );
      const untilMs = Math.min(endMs, Date.now());
      // Drizzle timestamp columns compare against `Date`, not ISO strings.
      const since = new Date(startMs);
      const until = new Date(untilMs);

      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            memberId: eventRegistrations.matchedMemberId,
            used: sql<number>`COUNT(*)::int`,
          })
          .from(eventRegistrations)
          .innerJoin(
            events,
            and(
              eq(events.tenantId, eventRegistrations.tenantId),
              eq(events.eventId, eventRegistrations.eventId),
            ),
          )
          .where(
            and(
              eq(eventRegistrations.tenantId, ctx.slug),
              eq(events.isCulturalEvent, true),
              gte(events.startDate, since),
              lte(events.startDate, until),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
              sql`${events.archivedAt} IS NULL`,
              sql`${eventRegistrations.matchedMemberId} IS NOT NULL`,
            ),
          )
          .groupBy(eventRegistrations.matchedMemberId);
        return toCountMap(rows);
      });
    },
  };
