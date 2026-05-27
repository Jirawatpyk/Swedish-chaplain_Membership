/**
 * F6 Phase 10 T120 — `getEventAttendeesByMember` Application use-case
 * (F6 → F8 bridge per research.md R11).
 *
 * F8 (renewals) consumes this via its `EventAttendeesPort` for the
 * at-risk-scorer's "did the member actually engage" factor (FR-029a).
 * F8's stub adapter (`event-attendees-stub.ts`) returns `[]` until F6
 * ships; this wrapper is the F6-side counterpart that F8's composition
 * root swaps in when `FEATURE_F6_EVENTCREATE === 'true'`.
 *
 * Architectural notes (R11 E1):
 *   - Enforces tenant-scoped read via the injected query port (which
 *     internally wraps `runInTenant` so RLS GUC is set in the Drizzle
 *     adapter).
 *   - Maps Drizzle row shape → stable domain record shape so F8 sees
 *     a stable contract even if F6 schema evolves.
 *   - Returns ReadonlyArray of bare records (no Result wrapper) to
 *     keep the F8 port surface identical to the stub.
 *
 * F6 does NOT import the F8 `EventAttendeesPort` type here — the
 * adapter exported via the F6 barrel is shape-matched STRUCTURALLY at
 * the F8 composition root. This prevents an F6 → F8 backwards
 * dependency (Constitution Principle III).
 *
 * Pure Application — no framework imports.
 */
import type { TenantId, MemberId } from '@/modules/members';

export interface EventAttendanceRecord {
  readonly memberId: string;
  /** ISO 8601 UTC — derived from `events.start_date`. */
  readonly attendedAt: string;
  readonly eventId: string;
  /**
   * Derived from F6 event-category flags:
   *   - partnership_and_cultural: both flags true (rare)
   *   - partnership: is_partner_benefit only
   *   - cultural: is_cultural_event only
   *   - general: neither (default)
   *
   * NOT a domain-modeled enum — F8 uses this as a free-form correlation
   * key, and F6 reserves the right to extend the taxonomy without an
   * F8 schema migration.
   */
  readonly eventType: string;
}

export interface ListAttendancesOpts {
  /**
   * Lookback window. When omitted, defaults to 365 days in the use-case
   * (consistent with the F8 stub's documented default behaviour).
   */
  readonly sinceIso?: string;
  /**
   * Upper bound on `start_date` (exclusive-ish; the adapter applies
   * `start_date <= until`). Omitted by F8 (it wants all attendances up to
   * now). F9 benefit-usage passes the year-end / now boundary so future-dated
   * and out-of-window rows don't consume the row cap before the relevant rows
   * are read, and a not-yet-occurred registration isn't counted as used.
   */
  readonly untilIso?: string;
  /**
   * Max rows. When omitted, defaults to 100 — tight enough to avoid
   * row-cap blast radius on a member with many attendances, generous
   * enough that the at-risk-scorer's 1-year window almost always fits.
   */
  readonly limit?: number;
}

export interface EventAttendeesQueryPort {
  list(input: {
    readonly tenantId: TenantId;
    readonly memberId: MemberId;
    readonly since: Date;
    /** When set, the adapter filters `start_date <= until`. */
    readonly until?: Date;
    readonly limit: number;
  }): Promise<ReadonlyArray<EventAttendanceRecord>>;
}

export interface GetEventAttendeesByMemberDeps {
  readonly query: EventAttendeesQueryPort;
}

/**
 * Phase 10 default: 365-day lookback. F8's at-risk-scorer's window is
 * also 365 days, so this default lines up. If F8 needs a different
 * window per scoring run it can pass `opts.sinceIso` explicitly.
 */
const DEFAULT_LOOKBACK_DAYS = 365;
const DEFAULT_LIMIT = 100;

export async function getEventAttendeesByMember(
  tenantId: TenantId,
  memberId: MemberId,
  opts: ListAttendancesOpts | undefined,
  deps: GetEventAttendeesByMemberDeps,
): Promise<ReadonlyArray<EventAttendanceRecord>> {
  const sinceIso = opts?.sinceIso;
  const since =
    sinceIso !== undefined
      ? new Date(sinceIso)
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const until = opts?.untilIso !== undefined ? new Date(opts.untilIso) : undefined;
  // exactOptionalPropertyTypes: omit `until` entirely when absent.
  return deps.query.list({
    tenantId,
    memberId,
    since,
    limit,
    ...(until !== undefined ? { until } : {}),
  });
}
