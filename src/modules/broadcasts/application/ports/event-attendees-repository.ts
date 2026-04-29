/**
 * T028 — `EventAttendeesRepository` Application port (F7).
 *
 * **F6 stub-port** (FR-015a / Q5). F7 ships a stub implementation
 * returning `[]` until F6 EventCreate Integration ships its real
 * Drizzle-backed implementation. Both features release together in
 * the Phase 2 batch per `docs/phases-plan.md` § Phase 2 ordering.
 *
 * The port shape is the **F6 contract** — F6's `/speckit.implement`
 * MUST swap the F7 stub for a Drizzle adapter that returns real
 * attendee data. F6 may refine the `EventAttendee` type but MUST NOT
 * remove fields used by F7's `resolve-segment-recipients.ts`.
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
   * Return distinct attendees who attended ≥1 event in the last 90
   * days (FR-015 — `event_attendees_last_90d` segment). MAY be the
   * stub returning `[]` until F6 ships.
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
   * if the email did not attend any event in 90d (or if F6 stub —
   * always returns `null`).
   */
  lookupAttendeeEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<EventAttendee | null>;
}
