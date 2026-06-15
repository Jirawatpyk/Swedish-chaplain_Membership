/**
 * T028 — `EventAttendeesRepository` Application port (F7).
 *
 * **F6 contract** (FR-015a / Q5). Originally shipped with a stub
 * implementation returning `[]` until F6 EventCreate Integration landed.
 * F6 has since shipped, and the live composition roots now wire the
 * `eventAttendeesBridge` (`infrastructure/event-attendees-bridge.ts`) —
 * a Drizzle-backed adapter over F6's `event_registrations`/`events`
 * tables, reached through the `@/modules/events` barrel (Principle III).
 * The `event-attendees-stub.ts` is retained only for the empty-segment
 * integration tests.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { EmailLower } from '../../domain/value-objects/email-lower';

export interface EventAttendee {
  readonly emailLower: EmailLower;
  readonly displayName: string | null;
  readonly memberId: string | null;
  readonly mostRecentEventDate: Date;
  readonly mostRecentEventTitle: string | null;
}

export interface EventAttendeesRepository {
  /**
   * Return distinct attendees who attended ≥1 event whose date falls in
   * the last 90 days (FR-015 — `event_attendees_last_90d` segment).
   *
   * Deduplication: if the same email attended N events in 90d, return
   * one row with the most recent event's title + date.
   */
  getLastNinetyDayAttendees(
    tenantCtx: TenantContext,
  ): Promise<ReadonlyArray<EventAttendee>>;

  /**
   * Lookup one email — used by FR-015d custom-list validation branch 3
   * (verify a custom recipient was an event attendee). Returns `null`
   * if the email did not attend any event in the last 90 days.
   */
  lookupAttendeeEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<EventAttendee | null>;
}
