/**
 * T031b — `RegistrationsRepository` Application port (F6).
 *
 * CRUD-ish access to the `event_registrations` table from Application
 * use-cases. The Infrastructure adapter
 * (`drizzle-registrations-repository.ts`, Phase 3 T049) implements
 * via Drizzle.
 *
 * Write methods are idempotency-safe:
 *   - `insertOnConflictDoNothing` returns a `wasFresh` flag (second of
 *     two webhook idempotency layers — the first is the X-Request-ID
 *     receipt in 0134).
 *
 * Read methods:
 *   - `findByEventId`           — event detail attendee table render
 *   - `findById`                — admin relink + erasure pre-fetch
 *   - `findByEmailLower`        — admin erasure search by email (FR-032a)
 *   - `countConsumedByMember`   — quota accounting computed-on-read
 *                                  per data-model.md § 8
 *   - `listPseudonymiseEligible` — daily retention sweep (Phase 10
 *                                  T113 — non-member rows older than 2y)
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId, MemberId } from '@/modules/members';
import type {
  EventId,
  RegistrationId,
  ExternalAttendeeId,
  AttendeeEmail,
} from '../../domain/branded-types';
import type { EventRegistrationAggregate, Attendee, Ticket } from '../../domain/event-registration';
import type { MatchResolution, QuotaEffect } from '../../domain/event-registration';

export interface InsertRegistrationInput {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly externalId: ExternalAttendeeId;
  readonly attendee: Attendee;
  readonly match: MatchResolution;
  readonly ticket: Ticket;
  readonly quotaEffect: QuotaEffect;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly registeredAt: Date;
}

export interface InsertRegistrationResult {
  readonly registration: EventRegistrationAggregate;
  /** TRUE if a new row was created; FALSE if (tenant, event, external_id) already existed. */
  readonly wasFresh: boolean;
}

export interface ListRegistrationsByEventInput {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly unmatchedOnly: boolean;
  readonly emailSearch: string | null; // substring match on attendee_email_lower
  readonly pageSize: number;
  readonly pageToken: string | null;
}

export interface ListRegistrationsByEventResult {
  readonly items: ReadonlyArray<EventRegistrationAggregate>;
  readonly nextPageToken: string | null;
  /**
   * Aggregate match-rate counters for the events-list table render
   * (FR-020). Computed once per page-load (NOT per-row).
   */
  readonly matchCounts: {
    readonly memberContact: number;
    readonly memberDomain: number;
    readonly memberFuzzy: number;
    readonly nonMember: number;
    readonly unmatched: number;
  };
}

export interface CountConsumedByMemberInput {
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly scope:
    | { readonly kind: 'partnership_per_event'; readonly eventId: EventId }
    | { readonly kind: 'cultural_per_year'; readonly fiscalYear: number };
}

export type RegistrationsRepositoryError =
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'pseudonymised_row_rejected'; readonly registrationId: RegistrationId };

export interface RegistrationsRepository {
  insertOnConflictDoNothing(
    input: InsertRegistrationInput,
  ): Promise<
    Result<InsertRegistrationResult, RegistrationsRepositoryError>
  >;

  findById(
    tenantId: TenantId,
    registrationId: RegistrationId,
  ): Promise<Result<EventRegistrationAggregate | null, RegistrationsRepositoryError>>;

  findByEventId(
    input: ListRegistrationsByEventInput,
  ): Promise<Result<ListRegistrationsByEventResult, RegistrationsRepositoryError>>;

  findByEmailLower(
    tenantId: TenantId,
    emailLower: string,
  ): Promise<Result<ReadonlyArray<EventRegistrationAggregate>, RegistrationsRepositoryError>>;

  countConsumedByMember(
    input: CountConsumedByMemberInput,
  ): Promise<Result<number, RegistrationsRepositoryError>>;

  /**
   * Updates the registration's match + quota fields atomically (admin
   * relink action per FR-014). REJECTS rows where
   * `piiPseudonymisedAt IS NOT NULL` with `pseudonymised_row_rejected`
   * error per round-2 R4.
   */
  updateMatchAndQuota(
    tenantId: TenantId,
    registrationId: RegistrationId,
    nextMatch: MatchResolution,
    nextQuotaEffect: QuotaEffect,
  ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>>;

  /**
   * Daily retention sweep eligibility scan per FR-032 / SC-011 (Phase 10
   * T113). Returns rows where match_type IN ('non_member','unmatched')
   * AND piiPseudonymisedAt IS NULL AND registeredAt < (now - 2y).
   */
  listPseudonymiseEligible(
    tenantId: TenantId,
    olderThan: Date,
    pageSize: number,
  ): Promise<Result<ReadonlyArray<EventRegistrationAggregate>, RegistrationsRepositoryError>>;

  /**
   * Replaces attendee_email + attendee_name + attendee_company with
   * deterministic salted hashes + sets piiPseudonymisedAt to the
   * provided timestamp. Idempotent — re-running on an already-pseudonymised
   * row is a no-op returning the existing aggregate.
   */
  pseudonymiseRow(
    tenantId: TenantId,
    registrationId: RegistrationId,
    pseudonymisedEmail: AttendeeEmail,
    pseudonymisedName: string,
    pseudonymisedCompany: string | null,
    pseudonymisedAt: Date,
  ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>>;

  /**
   * Hard delete + cascade for FR-032a admin erasure (Phase 10 T110).
   * Returns the deleted row so the use-case can emit
   * `pii_erasure_completed` audit with the affected quota counts.
   */
  hardDelete(
    tenantId: TenantId,
    registrationId: RegistrationId,
  ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>>;
}
