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
import type { MatchType } from '../../domain/value-objects/match-type';

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
  /**
   * F6.1 (Feature 013 · FR-009 dedicated-column population) — PDPA
   * consent classification, persisted to
   * `event_registrations.attendee_pdpa_consent_acknowledged` (BOOLEAN
   * NULL, added by migration 0140). Optional for backward-compat with
   * the webhook ingest path that does not yet carry consent state;
   * webhook rows store NULL until F6.2 or a future Phase adds upstream
   * consent capture.
   *
   * Tri-state semantics:
   *   - `true`  → consent explicitly granted (EventCreate "I hereby acknowledge")
   *   - `false` → consent explicitly withdrawn (EventCreate "I do not consent")
   *   - `null`  → unknown / not captured / generic-CSV (default)
   */
  readonly pdpaConsentAcknowledged?: boolean | null;
}

export interface InsertRegistrationResult {
  readonly registration: EventRegistrationAggregate;
  /**
   * TRUE if a new row was created; FALSE if `(tenant, event,
   * external_id)` already existed (Zapier replay → second idempotency
   * layer hit). Distinct field name from `UpsertEventResult.eventCreated`
   * to prevent cross-port semantic conflation when both results are
   * inspected side-by-side.
   */
  readonly isNewRegistration: boolean;
}

export interface ListRegistrationsByEventInput {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly unmatchedOnly: boolean;
  /**
   * Exact match-type filter (Phase 4 — attendee table column filter).
   * `null` = no filter. Wired into the same admin attendee table that
   * `unmatchedOnly` operates on; mutually compatible (a non-null
   * `matchTypeFilter` overrides `unmatchedOnly`).
   */
  readonly matchTypeFilter: MatchType | null;
  readonly emailSearch: string | null; // substring on attendee_email_lower + attendee_name
  readonly offset: number;
  readonly pageSize: number;
}

export interface ListRegistrationsByEventResult {
  readonly items: ReadonlyArray<EventRegistrationAggregate>;
  readonly totalCount: number;
  /**
   * Aggregate match-rate counters for the event detail header (US2 AS2).
   * Reflects the FULL attendee list — NOT filtered by `unmatchedOnly` /
   * `matchTypeFilter` / `emailSearch`. Computed once per page-load (NOT
   * per-row).
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
  | { readonly kind: 'pseudonymised_row_rejected'; readonly registrationId: RegistrationId }
  | {
      /**
       * See EventsRepositoryError for rationale. Distinct from
       * `db_error` so stub-method invocations by future-phase code
       * surface a clear "this phase not yet wired" signal instead of
       * polluting the DB-error metric.
       */
      readonly kind: 'not_implemented';
      readonly method: string;
      readonly futureTask: string;
    }
  | {
      /**
       * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` returned
       * zero rows. See EventsRepositoryError for full rationale —
       * symptomatic of RLS misconfiguration or schema drift, NOT a
       * transient Postgres error.
       */
      readonly kind: 'invariant_violation';
      readonly invariant: string;
    };

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
   * error.
   */
  updateMatchAndQuota(
    tenantId: TenantId,
    registrationId: RegistrationId,
    nextMatch: MatchResolution,
    nextQuotaEffect: QuotaEffect,
  ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>>;

  /**
   * Updates ONLY the `counted_against_partnership` +
   * `counted_against_cultural_quota` flags on an existing row. Used by
   * the Phase 6 quota wiring path: `ingestWebhookAttendee` inserts the
   * registration with neutral flags (default), then `applyQuotaEffect`
   * decides the real flags under the advisory lock, then this method
   * persists them. Splitting INSERT-then-UPDATE keeps the canonical
   * "lock → read consumed → decide → write" order intact (the new row
   * IS visible to the SUM query inside the same tx but contributes
   * zero because its flag is `false` at INSERT time).
   *
   * Idempotent — re-running with the same flags is a no-op UPDATE.
   * REJECTS rows where `piiPseudonymisedAt IS NOT NULL`.
   */
  setQuotaEffect(
    tenantId: TenantId,
    registrationId: RegistrationId,
    nextQuotaEffect: QuotaEffect,
  ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>>;

  /**
   * Atomically flips the row to refunded state (FR-018 / US4 AS4 —
   * webhook re-ingest with `payment_status='refunded'` on an existing
   * `(tenant, event, externalId)` triple). Sets:
   *   - payment_status = 'refunded'
   *   - counted_against_partnership = false
   *   - counted_against_cultural_quota = false
   *
   * Idempotent — re-running on an already-refunded row updates nothing
   * material; returns the same aggregate with both `counted_against_*`
   * flags surfaced for the caller's audit-emission decision (the
   * `previousQuotaEffect` field tells the caller WHICH scopes need a
   * `quota_credit_back_refund` audit row — the SCOPES that were
   * previously true are the scopes that just credited back).
   *
   * REJECTS rows where `piiPseudonymisedAt IS NOT NULL` per FR-014.
   */
  markRefunded(
    tenantId: TenantId,
    registrationId: RegistrationId,
  ): Promise<
    Result<
      {
        readonly registration: EventRegistrationAggregate;
        readonly previousQuotaEffect: QuotaEffect;
        readonly previousPaymentStatus: import('../../domain/value-objects/payment-status').PaymentStatus;
      },
      RegistrationsRepositoryError
    >
  >;

  /**
   * Lists every registration for an event that is eligible for quota
   * re-evaluation (T087 admin toggle, FR-019 + FR-019a archive). Filters:
   *   - matched_member_id IS NOT NULL (non-matched rows never carry
   *     quota)
   *   - payment_status = 'paid' (refunded rows stay credit-back
   *     regardless of toggle)
   *   - pii_pseudonymised_at IS NULL (retention-purged rows skipped per
   *     FR-014)
   *
   * Ordered by `matched_member_id ASC` so callers iterating with per-
   * (tenant, member, event) advisory locks acquire them in a
   * deterministic order — eliminates the deadlock class where two
   * concurrent admin toggles on different events sharing common
   * members would otherwise lock A→B vs B→A.
   *
   * NOT paginated — the worst-case set is bounded by SweCham scale
   * (~500 attendees per event in the design envelope). If a future
   * larger tenant blows past that, gate on chunked iteration here.
   */
  listForRequota(
    tenantId: TenantId,
    eventId: EventId,
  ): Promise<Result<ReadonlyArray<EventRegistrationAggregate>, RegistrationsRepositoryError>>;

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
