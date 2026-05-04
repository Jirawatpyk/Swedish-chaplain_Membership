/**
 * F8 Phase 2 Wave G · T054 · part 3 — F6-readiness stub for
 * `EventAttendeesPort` (Wave E port T049).
 *
 * Per research.md R5 + spec FR-029a, F8 ships a stub that returns
 * `false` from `isAvailable()` and `[]` from `listAttendances()` until
 * F6 ships its real attendee bridge. The at-risk-scorer port (Wave E
 * T050) consults `isAvailable()` BEFORE counting attendances and skips
 * the F6 factor when false (sets `eventAttendanceFactorSkipped: true`
 * in the result for audit-trail observability).
 *
 * Swap-in path: when F6 ships, the composition root replaces this
 * adapter with a real F6 bridge — 1-line change in `renewals-deps.ts`.
 *
 * Pure Infrastructure — no framework / ORM imports.
 */
import type {
  EventAttendanceRecord,
  EventAttendeesPort,
} from '../application/ports/event-attendees-port';

export const eventAttendeesStub: EventAttendeesPort = {
  isAvailable(): boolean {
    return false;
  },

  async listAttendances(
    _tenantId: string,
    _memberId: string,
  ): Promise<ReadonlyArray<EventAttendanceRecord>> {
    return [];
  },
};
