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
   * NULL, added by migration 0140).
   *
   * TYPE-D2 (Round 1): required tri-state. Callers explicitly pass
   * `null` for unknown; webhook ingest passes null until upstream
   * consent capture lands.
   *
   * Tri-state semantics:
   *   - `true`  → consent explicitly granted (EventCreate "I hereby acknowledge")
   *   - `false` → consent explicitly withdrawn (EventCreate "I do not consent")
   *   - `null`  → unknown / not captured / generic-CSV (default)
   */
  readonly pdpaConsentAcknowledged: boolean | null;
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
  /**
   * Single-value scoping filter on `payment_status`. `null` (or
   * omitted) returns all statuses. F6.1 follow-up 2026-05-18 —
   * surfaces post-Option-B+ mixed-status rows (paid / pending /
   * waitlisted / no_show / refunded / free). Optional for backward
   * compat with existing call sites that don't yet thread it.
   */
  readonly paymentStatusFilter?:
    | import('../../domain/value-objects/payment-status').PaymentStatus
    | null;
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

  /**
   * COMP-1 US2c (member-erasure F6 fan-out) — enumerate every event
   * registration matched to a member (`matched_member_id = memberId`),
   * returning just the `(registrationId, eventId)` pair each consumer
   * needs to drive the per-registration `eraseAttendeePii` call. Scoped
   * to the tenant by RLS + the explicit `tenant_id` predicate; rides the
   * existing `event_regs_tenant_matched_member_idx (tenant_id,
   * matched_member_id)` index (migration 0131) — no new index needed.
   *
   * Returns a bare array (NOT `Result`-wrapped): the fan-out's `list`
   * dependency expects a plain array and a DB error must FAIL LOUD —
   * propagate as a thrown error rather than being swallowed into a
   * `Result.err` the best-effort caller might silently treat as "no
   * registrations". The `*InTx` suffix flags that the caller MUST thread
   * the tenant-scoped `tx` from `runInTenant` (RLS gotcha).
   *
   * Idempotent for the erasure path: after the registrations are
   * hard-deleted, a re-run enumerates 0 rows.
   */
  listMemberRegistrationsInTx(
    tenantId: TenantId,
    memberId: MemberId,
  ): Promise<
    ReadonlyArray<{
      readonly registrationId: RegistrationId;
      readonly eventId: EventId;
    }>
  >;

  findByEventId(
    input: ListRegistrationsByEventInput,
  ): Promise<Result<ListRegistrationsByEventResult, RegistrationsRepositoryError>>;

  /**
   * FR-032a by-email erasure enumeration. Returns EVERY registration whose
   * `attendee_email_lower` exactly equals the (lowered) email, RLS-scoped +
   * capped at `FIND_BY_EMAIL_CAP` rows.
   *
   * `truncated` is a COMPLETENESS signal (I-1 review finding): `true` when the
   * subject has MORE registrations than the cap, so the returned `rows` are a
   * partial set and residual PII survives beyond them. Callers (the erasure
   * preview + bulk fan-out) MUST surface `truncated` so an admin never reads a
   * capped, incomplete sweep as a COMPLETE Art. 17 DSR.
   */
  findByEmailLower(
    tenantId: TenantId,
    emailLower: string,
  ): Promise<
    Result<
      {
        readonly rows: ReadonlyArray<EventRegistrationAggregate>;
        readonly truncated: boolean;
      },
      RegistrationsRepositoryError
    >
  >;

  /**
   * F6.1 Phase 4 US2 (T031) — lookup an existing registration by
   * `(tenantId, eventId, attendee_email_lower)` for the re-upload
   * state-change detection path. Called by `processOneRowInSavepoint`
   * on idempotency-receipt duplicate-hit so we can compare the
   * incoming row's fields (payment_status, company) against the
   * persisted row + apply an UPDATE when they differ. Returns null
   * when no matching row exists (should not happen if the receipt was
   * a real duplicate, but defensive on the boundary).
   *
   * Index: piggybacks on the existing `(tenant_id, event_id,
   * attendee_email_lower)` lookup pattern used by Phase 4 attendee
   * table. No new index required.
   */
  findByEventAndEmail(
    tenantId: TenantId,
    eventId: EventId,
    emailLower: string,
  ): Promise<
    Result<EventRegistrationAggregate | null, RegistrationsRepositoryError>
  >;

  /**
   * F6.1 Phase 4 US2 (T031) — non-refund payment_status state change
   * on re-upload. Used by `processOneRowInSavepoint` when the incoming
   * row's inferred payment_status (from EventCreate Notes) differs
   * from the persisted row's status AND the new value is NOT
   * `'refunded'` (refund transitions go through `markRefunded` for
   * the quota credit-back path).
   *
   * Idempotent: re-running with the same status is a no-op UPDATE.
   * REJECTS rows where `piiPseudonymisedAt IS NOT NULL` per FR-014.
   */
  updatePaymentStatus(
    tenantId: TenantId,
    registrationId: RegistrationId,
    nextPaymentStatus: import('../../domain/value-objects/payment-status').PaymentStatus,
  ): Promise<
    Result<
      {
        readonly registration: EventRegistrationAggregate;
        readonly previousPaymentStatus: import('../../domain/value-objects/payment-status').PaymentStatus;
      },
      RegistrationsRepositoryError
    >
  >;

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
