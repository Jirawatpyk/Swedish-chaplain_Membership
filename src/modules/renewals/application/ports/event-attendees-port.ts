/**
 * T049 (F8 Phase 2 Wave E) — `EventAttendeesPort` Application port.
 *
 * F6 readiness probe + attendance lookup per research.md R5. Wave E
 * ships the interface; Wave G composition root binds the F6 stub
 * adapter (`isAvailable()` returns false; `listAttendances()` returns
 * `[]`) until F6 ships its real adapter.
 *
 * The at-risk-score formula's eventAttendance factor consults
 * `isAvailable()` first — when false, the factor is skipped + flagged
 * via `eventAttendanceFactorSkipped: true` in the result (FR-029a
 * F6-readiness fallback). Once F6 ships, swapping the stub adapter
 * for the real F6 bridge is a 1-line composition root change.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface EventAttendanceRecord {
  readonly memberId: string;
  /** ISO 8601 UTC. */
  readonly attendedAt: string;
  readonly eventId: string;
  /** Free-form event type (e.g. 'networking_dinner', 'cme_seminar'). */
  readonly eventType: string;
}

export interface ListAttendancesOpts {
  /** Lookback window. Defaults to 12 months in adapter. */
  readonly sinceIso?: string;
  readonly limit?: number;
}

export interface EventAttendeesPort {
  /**
   * F6 readiness gate per research.md R5 + FR-029a. The stub adapter
   * returns `false` until F6 ships its bridge. The at-risk-scorer
   * port consults this BEFORE counting attendances + skips the
   * factor if false.
   */
  isAvailable(): boolean;

  /**
   * List a member's event attendances. Stub adapter returns `[]` for
   * any tenant/member combination. Real F6 adapter (post-F6 ship)
   * queries the F6 attendees view scoped to the tenant context.
   */
  listAttendances(
    tenantId: string,
    memberId: string,
    opts?: ListAttendancesOpts,
  ): Promise<ReadonlyArray<EventAttendanceRecord>>;
}
