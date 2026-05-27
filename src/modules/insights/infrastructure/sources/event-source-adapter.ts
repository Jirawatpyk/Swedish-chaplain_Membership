/**
 * F9 event-consumption source adapter (US4 / T017) — counts a member's
 * cultural-event ticket usage in a membership year + last-used date, via the
 * events PUBLIC BARREL (`getEventAttendeesByMember` + `drizzleEventAttendeesQuery`),
 * no deep import (Constitution Principle III).
 *
 * Membership year = calendar year in the tenant timezone (FR-023). The year's
 * UTC bounds are derived here (Infrastructure owns the tz-aware DB filter) so a
 * registration at 23:00 ICT on 31-Dec counts in the correct year. "Cultural"
 * spans the F6 event-category taxonomy values that include cultural
 * (`cultural`, `partnership_and_cultural`).
 */
import { Instant } from '@js-joda/core';
import '@js-joda/timezone';
import { env } from '@/lib/env';
import {
  getEventAttendeesByMember,
  drizzleEventAttendeesQuery,
} from '@/modules/events';
import { asTenantId, asMemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import { tenantYearBoundsUtcMs } from '../../application/tenant-year';
import type {
  BenefitConsumption,
  EventConsumptionSource,
} from '../../application/ports/source-ports';

/** A safe upper bound on cultural attendances per member-year (cap blast radius). */
const ATTENDANCE_FETCH_LIMIT = 500;

export const eventSourceAdapter: EventConsumptionSource = {
  async getCulturalConsumption(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<BenefitConsumption> {
    // Shared with the benefit-usage use-case so the year window cannot drift.
    const { startMs, endMs } = tenantYearBoundsUtcMs(membershipYear, env.tenant.timezone);
    const records = await getEventAttendeesByMember(
      asTenantId(ctx.slug),
      asMemberId(memberId),
      { sinceIso: new Date(startMs).toISOString(), limit: ATTENDANCE_FETCH_LIMIT },
      { query: drizzleEventAttendeesQuery },
    );

    let used = 0;
    let lastUsedMs: number | null = null;
    for (const r of records) {
      if (!r.eventType.includes('cultural')) continue;
      const atMs = Instant.parse(r.attendedAt).toEpochMilli();
      if (atMs < startMs || atMs >= endMs) continue; // strictly within the year
      used += 1;
      if (lastUsedMs === null || atMs > lastUsedMs) lastUsedMs = atMs;
    }
    return {
      used,
      lastUsedAt: lastUsedMs === null ? null : new Date(lastUsedMs).toISOString(),
    };
  },
};
