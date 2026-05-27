/**
 * F6 Phase 10 T121 — Drizzle adapter for `EventAttendeesQueryPort`.
 *
 * Queries `event_registrations` joined with `events` for a member's
 * past attendances within the requested window. Wraps in `runInTenant`
 * so RLS enforces tenant scope at the DB layer (Principle I sub-clause
 * 2). The use-case caller passes the `tenantId` slug; this adapter
 * derives the `TenantContext` + sets the GUC inside the tx.
 *
 * Excludes pseudonymised rows — once a registration is retention-
 * purged its `matched_member_id` may be invalidated. The at-risk
 * scorer cares about RECENT engagement, so excluding pseudonymised
 * rows (which are necessarily > 2 years old per FR-032) is a clean
 * design.
 *
 * Exports TWO surfaces:
 *   1. `drizzleEventAttendeesQuery: EventAttendeesQueryPort` — the
 *      Application-layer port impl (for use-case unit-testability).
 *   2. `drizzleEventAttendeesAdapter` — a STRUCTURAL match for F8's
 *      `EventAttendeesPort` interface (per research.md R11). F6 does
 *      NOT import the F8 type here; F8's composition root assigns
 *      via TypeScript structural typing. This keeps the dependency
 *      arrow pointing F8 → F6 (Constitution Principle III — F6 is
 *      lower-level than F8 in the dependency graph).
 *
 * Per Constitution Principle I sub-clause 5: every column referenced
 * here is tenant-scoped; cross-tenant memberId probes return [].
 *
 * Pure Infrastructure — Drizzle types are CONFINED to this file.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { eventcreateMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { events, eventRegistrations } from './schema';
import { sql } from 'drizzle-orm';
import type {
  EventAttendeesQueryPort,
  EventAttendanceRecord,
  ListAttendancesOpts,
} from '../application/use-cases/get-event-attendees-by-member';
import { getEventAttendeesByMember } from '../application/use-cases/get-event-attendees-by-member';
import type { TenantId, MemberId } from '@/modules/members';

function deriveEventType(row: {
  readonly isPartnerBenefit: boolean | null;
  readonly isCulturalEvent: boolean | null;
}): string {
  const partner = row.isPartnerBenefit === true;
  const cultural = row.isCulturalEvent === true;
  if (partner && cultural) return 'partnership_and_cultural';
  if (partner) return 'partnership';
  if (cultural) return 'cultural';
  return 'general';
}

/**
 * Core tenant-scoped attendances SELECT — THROWS on any fault. Shared by both
 * the fail-open (F8) and fail-loud (F9) port variants below so the query logic
 * + RLS scoping live in exactly one place.
 */
async function runAttendeesQuery(
  input: Parameters<EventAttendeesQueryPort['list']>[0],
): Promise<ReadonlyArray<EventAttendanceRecord>> {
  const ctx = asTenantContext(String(input.tenantId));
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        memberId: eventRegistrations.matchedMemberId,
        startDate: events.startDate,
        eventId: events.eventId,
        isPartnerBenefit: events.isPartnerBenefit,
        isCulturalEvent: events.isCulturalEvent,
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
          // Defense-in-depth WHERE alongside the RLS GUC set by
          // runInTenant. The matched_member_id is the F3 member uuid.
          eq(eventRegistrations.matchedMemberId, String(input.memberId)),
          gte(events.startDate, input.since),
          // Skip pseudonymised rows (FR-032 retention-purged).
          sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
          // Skip archived events (FR-019a quota-neutral state).
          sql`${events.archivedAt} IS NULL`,
        ),
      )
      .orderBy(desc(events.startDate))
      .limit(input.limit);

    return rows
      .filter((r) => r.memberId !== null)
      .map((r) => ({
        memberId: r.memberId as string,
        attendedAt:
          r.startDate instanceof Date
            ? r.startDate.toISOString()
            : new Date(r.startDate).toISOString(),
        eventId: r.eventId,
        eventType: deriveEventType(r),
      }));
  });
}

/**
 * F8-port contract: fail-open with `[]` on any throw (DB blip, RLS
 * regression, pool exhaustion). F8's at-risk scorer expects a no-throw
 * shape per the stub-port precedent. The metric counter
 * `bridgeEventAttendeesQueryFailed` is the SRE signal — alert on
 * sustained rate > 0.
 *
 * NOTE: this fail-open is correct ONLY for the F8 at-risk scorer. A consumer
 * that must distinguish "zero attendances" from "query failed" (F9 US4
 * benefit-usage — a masked `[]` understates cultural-ticket consumption and
 * fires a FALSE under-use warning) MUST use `drizzleEventAttendeesQueryStrict`.
 */
export const drizzleEventAttendeesQuery: EventAttendeesQueryPort = {
  async list(input): Promise<ReadonlyArray<EventAttendanceRecord>> {
    try {
      return await runAttendeesQuery(input);
    } catch (e) {
      // R3.3.4 / I-4 / R5.3.2 / Round 4 I-5 — preserve `err.stack` for
      // RLS-regression / pool-exhaustion forensics. `redactStack`
      // strips secrets before pino serialises.
      //
      // R5.3.2 / Round 4 I-5 — nested try/catch around `logger.error` +
      // the metric counter. The F8 EventAttendeesPort contract is "no
      // throw under any circumstance"; if pino itself throws on a
      // circular-reference inside `e` (e.g. a custom Error with
      // `this.cause = this`), or if `safeMetric`'s OTel SDK is
      // mid-shutdown, the bridge would break F8's at-risk scorer batch.
      // Last-resort `console.error` fallback ensures forensics survive
      // even when the structured logger is down.
      try {
        logger.error(
          {
            event: 'f6_event_attendees_query_failed',
            tenantId: String(input.tenantId),
            memberId: String(input.memberId),
            err:
              e instanceof Error
                ? {
                    name: e.name,
                    message: e.message,
                    stack:
                      typeof e.stack === 'string'
                        ? (redactStack(e.stack) ?? null)
                        : null,
                  }
                : { name: 'non_error', message: String(e), stack: null },
          },
          '[F6→F8 bridge] eventAttendees query failed — falling open to [] to preserve F8 scorer no-throw contract',
        );
        eventcreateMetrics.bridgeEventAttendeesQueryFailed(String(input.tenantId));
      } catch (loggerErr) {
        // Worst case: pino + safeMetric BOTH threw. Stack trace is
        // gone; `console.error` is the last-ditch breadcrumb so SRE
        // can at least see the bridge failed open from container logs.
        console.error(
          '[F6→F8 bridge] logger.error or metric counter itself threw — F8 no-throw contract preserved',
          loggerErr,
        );
      }
      return [];
    }
  },
};

/**
 * Fail-LOUD variant (F9 US4): rethrows on any fault so the caller surfaces it
 * (→ `compute_failed`/500) instead of a misleading zero-consumption. F9's
 * benefit-usage event source uses this — a masked `[]` would understate
 * cultural-ticket usage and trigger a false under-use warning, the same
 * masked-zero class the broadcast adapter avoids (review-run R3-1). The F8
 * at-risk scorer keeps the no-throw `drizzleEventAttendeesQuery` above.
 */
export const drizzleEventAttendeesQueryStrict: EventAttendeesQueryPort = {
  async list(input): Promise<ReadonlyArray<EventAttendanceRecord>> {
    return runAttendeesQuery(input);
  },
};

/**
 * Structural match for F8's `EventAttendeesPort`. The shape:
 *   - `isAvailable(): boolean`        → true (the F6 bridge is up)
 *   - `listAttendances(tenantId, memberId, opts?)` → records
 *
 * F8's `renewals-deps.ts` composition root assigns this to the
 * `eventAttendees: EventAttendeesPort` slot via TypeScript structural
 * typing — no nominal interface import is required across the module
 * boundary.
 *
 * Implementation delegates to the Application use-case to keep the
 * port + query separation per Clean Architecture.
 */
export const drizzleEventAttendeesAdapter = {
  isAvailable(): boolean {
    return true;
  },

  async listAttendances(
    tenantId: string,
    memberId: string,
    opts?: ListAttendancesOpts,
  ): Promise<ReadonlyArray<EventAttendanceRecord>> {
    return getEventAttendeesByMember(
      tenantId as TenantId,
      memberId as MemberId,
      opts,
      { query: drizzleEventAttendeesQuery },
    );
  },
} as const;
