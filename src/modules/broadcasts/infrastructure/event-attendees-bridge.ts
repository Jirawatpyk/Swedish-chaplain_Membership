/**
 * F6 → F7 events bridge — `EventAttendeesRepository` implementation over
 * F6's recent-attendee query (the `event_attendees_last_90d` segment).
 *
 * Replaces the T062 `eventAttendeesStub` (which returned `[]` until F6
 * EventCreate shipped). Calls the F6 barrel (`@/modules/events`) — never
 * imports the events schema directly (Constitution Principle III; mirrors
 * the F3 `members-bridge`). FAIL-LOUD: a query fault throws so the
 * broadcast recipient resolution surfaces it instead of silently sending
 * to zero recipients (the masked-zero class).
 */
import {
  getRecentEventAttendees,
  getRecentEventAttendeeByEmail,
  type RecentEventAttendee,
} from '@/modules/events';
import type { TenantContext } from '@/modules/tenants';
import { unsafeBrandEmailLower } from '../domain/value-objects/email-lower';
import type { EmailLower } from '../domain/value-objects/email-lower';
import type {
  EventAttendee,
  EventAttendeesRepository,
} from '../application/ports/event-attendees-repository';

function toEventAttendee(r: RecentEventAttendee): EventAttendee {
  return {
    emailLower: unsafeBrandEmailLower(r.emailLower),
    displayName: r.displayName,
    memberId: r.memberId,
    mostRecentEventDate: r.mostRecentEventDate,
    mostRecentEventTitle: r.mostRecentEventTitle,
  };
}

export const eventAttendeesBridge: EventAttendeesRepository = {
  async getLastNinetyDayAttendees(
    tenantCtx: TenantContext,
  ): Promise<ReadonlyArray<EventAttendee>> {
    const rows = await getRecentEventAttendees(tenantCtx.slug);
    return rows.map(toEventAttendee);
  },

  async lookupAttendeeEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<EventAttendee | null> {
    const row = await getRecentEventAttendeeByEmail(
      tenantCtx.slug,
      String(emailLower),
    );
    return row === null ? null : toEventAttendee(row);
  },
};
