/**
 * T062 — F6 EventAttendees stub implementation (F7).
 *
 * Returns `[]` / `null` per FR-015a + Clarifications Q5 (2026-04-29 session).
 * F7 ships before F6 EventCreate Integration ships its real Drizzle
 * adapter. Both features release together in the Phase 2 batch per
 * `docs/phases-plan.md` § Phase 2 ordering.
 *
 * **Swap pattern** (when F6 lands):
 *   1. F6 implements `DrizzleEventAttendeesRepository` against new `events` +
 *      `event_attendees` tables
 *   2. F6 swaps this stub at `broadcasts-deps.ts` composition root
 *   3. This file is deleted; F7 unit tests for `resolve-segment-recipients.ts`
 *      gain real attendee fixtures (T044/T050 update)
 *
 * Until then: `event_attendees_last_90d` segments resolve to empty,
 * causing submission to be rejected with `broadcast_empty_segment_blocked`
 * if no other segment is selected (T050).
 */
import type { EmailLower } from '../domain/value-objects/email-lower';
import type {
  EventAttendee,
  EventAttendeesRepository,
} from '../application/ports/event-attendees-repository';

export const eventAttendeesStub: EventAttendeesRepository = {
  async getLastNinetyDayAttendees(): Promise<ReadonlyArray<EventAttendee>> {
    return [];
  },

  async lookupAttendeeEmailInTenant(
    _tenantCtx,
    _emailLower: EmailLower,
  ): Promise<EventAttendee | null> {
    return null;
  },
};
