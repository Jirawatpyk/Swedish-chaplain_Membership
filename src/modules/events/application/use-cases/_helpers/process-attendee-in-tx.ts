/**
 * `processAttendeeInTx` — shared per-attendee tx-scoped pipeline.
 *
 * Extracted from `ingestWebhookAttendee` (Phase 3 T047) so the webhook
 * use-case (one attendee per HTTP request) AND the CSV importer
 * (Phase 7 T094, batched 100 rows per tx with SAVEPOINT-per-row
 * failure isolation) share ONE attendee-processing code path.
 *
 * FR-027 webhook ↔ CSV equivalence is therefore by construction — not
 * by parallel implementation drift.
 *
 * Pipeline stages (numbered to match the contracts/audit-port.md
 * canonical flow):
 *   2. Event upsert (FR-010 last-write-wins)
 *   3. Attendee match (FR-012 4-rule cascade)
 *   4. Registration INSERT with neutral quota flags
 *   5. Apply quota effect — advisory lock + queryAllotments + decide
 *      counted_against_* + emit quota_* audit + UPDATE on flag flip
 *   6. Refund credit-back — flip prior-counted row to refunded + emit
 *      `quota_credit_back_refund` per previously-true scope (FR-018)
 *   7. Emit match-resolution audit (attendee_matched_* / non_member /
 *      unmatched)
 *
 * What the CALLER still owns (NOT inside this helper):
 *   1. Payload validation (zod EventCreatePayloadV1 vs CsvRowSchema)
 *   1b. Idempotency receipt INSERT + duplicate-path audit decision
 *      (webhook emits `webhook_duplicate_rejected`; CSV silent-skip
 *      per contracts/csv-import-api.md § 4c csv-import-api contracts R3)
 *   8. Verb-level success audit (`webhook_receipt_verified` for the
 *      webhook caller; `csv_import_completed` is per-import not per-row
 *      so the CSV caller emits it after all batches)
 *   9. Catch-block fallback audit (`webhook_rolled_back` for webhook;
 *      `csv_import_row_failed` for CSV — emitted in a SAVEPOINT-scoped
 *      catch handler at the row boundary)
 *
 * Throws `TxStageError(stage, message)` on any failure; the caller's
 * outer catch reads the stage from the error and emits the appropriate
 * fallback audit.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { logger } from '@/lib/logger';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import type { TenantId, MemberId, ContactId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { QuotaEffect } from '../../../domain/event-registration';
import type { MatchType } from '../../../domain/value-objects/match-type';
import type { PaymentStatus } from '../../../domain/value-objects/payment-status';
import {
  asExternalEventId,
  asExternalAttendeeId,
  asAttendeeEmail,
  type RegistrationId,
} from '../../../domain/branded-types';
import type {
  ActorType,
  F6AuditEntry,
  F6AuditPort,
} from '../../ports/audit-port';
import type { EventsRepository } from '../../ports/events-repository';
import type { RegistrationsRepository } from '../../ports/registrations-repository';
import type { AttendeeMatcher } from '../../ports/attendee-matcher';
import type { QuotaAccountingPort } from '../../ports/quota-accounting-port';
import type { AdvisoryLockAcquirer } from '../../ports/advisory-lock-acquirer';
import { applyQuotaEffect, buildQuotaLockKey } from '../apply-quota-effect';

// ---------------------------------------------------------------------------
// TxStageError — shared between helper and webhook/CSV callers
// ---------------------------------------------------------------------------

import type { FailureStage } from '../../ports/audit-port';

// Re-export so callers in `application/use-cases/*` can import the
// taxonomy from either the helper or the audit-port — both names refer
// to the SAME type declared once in audit-port.ts (H5 deduplication).
export type { FailureStage };

export class TxStageError extends Error {
  constructor(
    public readonly stage: FailureStage,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Audit emit-or-throw helper (shared)
// ---------------------------------------------------------------------------

/**
 * Audit emit with Result check + throw on err.
 *
 * If the audit INSERT silently failed (Postgres connection blip, enum
 * drift, jsonb serialisation error) the tx would COMMIT side effects
 * with NO audit row AND NO `webhook_rolled_back` fallback — a hard
 * silent-failure (state mutation + no audit trail) violating FR-009 +
 * FR-037. Every `audit.emit` Result is therefore checked; on err →
 * throw `TxStageError('audit_emit', ...)` so the outer catch fires the
 * dual-write fallback audit + rolls back the tx.
 */
export async function emitOrThrow(
  audit: F6AuditPort,
  entry: F6AuditEntry,
): Promise<void> {
  const result = await audit.emit(entry);
  if (!result.ok) {
    throw new TxStageError(
      'audit_emit',
      `audit emit failed (kind=${result.error.kind}): ${
        result.error.kind === 'db_error'
          ? result.error.message
          : result.error.eventType
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helper input + output types
// ---------------------------------------------------------------------------

export interface AttendeeActorContext {
  readonly actorType: ActorType;
  readonly actorUserId: UserId | null;
}

export interface ProcessAttendeeInTxInput {
  readonly tenantId: TenantId;
  readonly actorContext: AttendeeActorContext;
  /**
   * Optional closure callback fired BEFORE each pipeline stage await.
   * Threads the current stage back to the caller so a plain-Error
   * rejection from an injected mock (Phase 3 transactional-ingest.test.ts
   * uses `vi.fn().mockRejectedValue(new Error(...))` — a plain Error,
   * NOT a TxStageError) still surfaces the correct stage in the
   * caller's `webhook_rolled_back` audit payload.
   *
   * The helper ALSO throws TxStageError(stage, ...) for every
   * Result.err path so callers that don't supply this callback still
   * get accurate stage reporting on the well-formed-Result code path.
   * The callback is purely defensive against the "plain Error
   * propagates past Result-check" edge case the integration test
   * relies on.
   */
  readonly onStageChange?: (stage: FailureStage) => void;
  /**
   * Event sub-object — pre-validated by the caller (the webhook caller
   * applies `EventCreatePayloadV1.event`; the CSV caller maps a
   * `CsvRow` into this shape per the column-mapping decisions made
   * upstream).
   */
  readonly event: {
    readonly externalId: string;
    readonly name: string;
    readonly description: string | null;
    readonly startDate: Date;
    readonly endDate: Date | null;
    readonly location: string | null;
    readonly category: string | null;
    readonly eventcreateUrl: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
  /**
   * Attendee sub-object — pre-validated by the caller.
   */
  readonly attendee: {
    readonly externalId: string;
    readonly email: string;
    readonly fullName: string;
    readonly companyName: string | null;
    readonly ticketType: string | null;
    readonly ticketPricePaid: number | null;
    readonly paymentStatus: PaymentStatus;
    readonly registeredAt: Date;
    readonly metadata: Readonly<Record<string, unknown>>;
    /**
     * F6.1 (Feature 013 · FR-009 dedicated-column population) — PDPA
     * consent classification per attendee. Populates the
     * `event_registrations.attendee_pdpa_consent_acknowledged` BOOLEAN
     * column added by migration 0140. Tri-state:
     *   - `true`  → admin/attendee acknowledged consent
     *   - `false` → admin/attendee explicitly withdrew consent
     *   - `null`  → unknown / not captured (default for webhook ingest +
     *               generic-CSV rows that omit the consent column)
     *
     * Optional on the helper input to preserve backward-compat for the
     * webhook ingest path (which does not yet carry PDPA consent).
     */
    readonly pdpaConsentAcknowledged?: boolean | null;
  };
}

export interface ProcessAttendeeInTxOutput {
  readonly registrationId: RegistrationId;
  readonly eventCreated: boolean;
  readonly matchType: MatchType;
  readonly matchedMemberId: MemberId | null;
  readonly quotaEffect: QuotaEffect;
  /**
   * TRUE when the (tenant, event, external_id) row was freshly inserted
   * by this call; FALSE when the row already existed (Zapier replay
   * hit the second idempotency layer at `event_registrations` —
   * FR-011). CSV callers use this to drive
   * `rowsProcessed` vs `rowsAlreadyImported` counter increments per
   * contracts/csv-import-api.md csv-import-api contracts R3.
   */
  readonly isNewRegistration: boolean;
}

export interface ProcessAttendeeInTxPorts {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly attendeeMatcher: AttendeeMatcher;
  readonly audit: F6AuditPort;
  readonly quotaAccountingPort: QuotaAccountingPort;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
}

// ---------------------------------------------------------------------------
// Private — match-resolution audit emit
// ---------------------------------------------------------------------------

async function emitMatchResolutionAudit(
  audit: F6AuditPort,
  tenantId: TenantId,
  actorContext: AttendeeActorContext,
  resolution: {
    readonly type: MatchType;
    readonly matchedMemberId: MemberId | null;
    readonly matchedContactId: ContactId | null;
  },
  fuzzyDetail: {
    readonly attendeeCompanyOriginal: string;
    readonly matchedMemberCompanyNormalised: string;
    readonly levenshteinDistance: number;
  } | null,
  unmatchedCandidates: ReadonlyArray<{
    readonly memberId: MemberId;
    readonly levenshteinDistance: number;
  }> | null,
  registrationId: RegistrationId,
  attendeeEmail: string,
): Promise<void> {
  const base = {
    tenantId,
    actorType: actorContext.actorType,
    actorUserId: actorContext.actorUserId,
    occurredAt: new Date(),
  };
  switch (resolution.type) {
    case 'member_contact':
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_matched_member_contact',
        summary: `attendee matched to member via contact email (${attendeeEmail})`,
        payload: {
          severity: 'info',
          registrationId,
          matchedMemberId: resolution.matchedMemberId!,
          matchedContactId: resolution.matchedContactId!,
          matchedOnEmail: asAttendeeEmail(attendeeEmail),
        },
      });
      return;
    case 'member_domain':
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_matched_member_domain',
        summary: `attendee matched to member via email domain`,
        payload: {
          severity: 'info',
          registrationId,
          matchedMemberId: resolution.matchedMemberId!,
          emailDomain: attendeeEmail.split('@')[1] ?? '',
        },
      });
      return;
    case 'member_fuzzy':
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_matched_member_fuzzy',
        summary: `attendee matched to member via fuzzy company-name match`,
        payload: {
          severity: 'info',
          registrationId,
          matchedMemberId: resolution.matchedMemberId!,
          attendeeCompanyOriginal: fuzzyDetail?.attendeeCompanyOriginal ?? '',
          matchedMemberCompanyNormalised:
            fuzzyDetail?.matchedMemberCompanyNormalised ?? '',
          levenshteinDistance: fuzzyDetail?.levenshteinDistance ?? 0,
        },
      });
      return;
    case 'non_member':
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_non_member',
        summary: `attendee is a non-member (FR-032 2y retention applies)`,
        payload: {
          severity: 'info',
          registrationId,
          attendeeEmail: asAttendeeEmail(attendeeEmail),
        },
      });
      return;
    case 'unmatched':
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_unmatched',
        summary: `attendee match ambiguous — admin relink required`,
        payload: {
          severity: 'info',
          registrationId,
          attendeeCompanyOriginal: fuzzyDetail?.attendeeCompanyOriginal ?? '',
          candidateMemberIds: unmatchedCandidates?.map((c) => c.memberId) ?? [],
          candidateLevenshteinDistances:
            unmatchedCandidates?.map((c) => c.levenshteinDistance) ?? [],
        },
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Main helper — strict-tx attendee processor
// ---------------------------------------------------------------------------

export async function processAttendeeInTx(
  input: ProcessAttendeeInTxInput,
  ports: ProcessAttendeeInTxPorts,
): Promise<ProcessAttendeeInTxOutput> {
  const { eventsRepo, registrationsRepo, attendeeMatcher, audit } = ports;
  const reportStage = input.onStageChange ?? (() => {});

  // 2. Event upsert (FR-010 last-write-wins)
  reportStage('event_upsert');
  const eventUpsert = await eventsRepo.upsert({
    tenantId: input.tenantId,
    source: 'eventcreate',
    externalId: asExternalEventId(input.event.externalId),
    name: input.event.name,
    description: input.event.description,
    startDate: input.event.startDate,
    endDate: input.event.endDate,
    location: input.event.location,
    category: input.event.category,
    eventcreateUrl: input.event.eventcreateUrl,
    metadata: input.event.metadata,
  });
  if (!eventUpsert.ok) {
    const e = eventUpsert.error;
    let msg: string;
    if (e.kind === 'db_error') {
      msg = e.message;
    } else if (e.kind === 'invariant_violation') {
      msg = `events.upsert invariant violated: ${e.invariant}`;
      logger.fatal(
        {
          event: 'f6_events_repo_invariant_violation',
          tenantId: input.tenantId,
          invariant: e.invariant,
        },
        '[F6] events.upsert returned no row — likely RLS / schema drift',
      );
    } else {
      msg = `event upsert rejected: ${e.kind}`;
      logger.fatal(
        {
          event: 'f6_use_case_called_unimplemented_port',
          tenantId: input.tenantId,
          method: e.method,
          futureTask: e.futureTask,
        },
        '[F6] events.upsert called an unimplemented port stub',
      );
    }
    throw new TxStageError('event_upsert', msg);
  }

  // 3. Attendee match (read-only against F3 — runs inside tx for
  //    consistent snapshot). Failures roll up to `event_upsert` stage
  //    via the explicit `TxStageError('event_upsert', ...)` below
  //    because the audit taxonomy doesn't expose a `match_attendee`
  //    enum value. No redundant `reportStage` here — the stage is
  //    still `event_upsert` from line 323.
  const matchResult = await attendeeMatcher.match({
    tenantId: input.tenantId,
    attendeeEmail: asAttendeeEmail(input.attendee.email),
    attendeeCompany: input.attendee.companyName,
  });
  if (!matchResult.ok) {
    throw new TxStageError('event_upsert', matchResult.error.message);
  }

  // 4. Registration insert with NEUTRAL quota flags. The advisory-lock
  //    decide-then-write sequence runs in step 5 AFTER the row exists,
  //    preserving research.md R5's canonical ordering (lock → read
  //    consumed → decide → write).
  let quotaEffect: QuotaEffect = {
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: false,
  };

  reportStage('registration_insert');
  const regInsert = await registrationsRepo.insertOnConflictDoNothing({
    tenantId: input.tenantId,
    eventId: eventUpsert.value.event.eventId,
    externalId: asExternalAttendeeId(input.attendee.externalId),
    attendee: {
      email: asAttendeeEmail(input.attendee.email),
      name: input.attendee.fullName,
      company: input.attendee.companyName,
    },
    match: matchResult.value.resolution,
    ticket: {
      type: input.attendee.ticketType,
      priceThb: input.attendee.ticketPricePaid,
      paymentStatus: input.attendee.paymentStatus,
    },
    quotaEffect,
    metadata: input.attendee.metadata,
    registeredAt: input.attendee.registeredAt,
    // F6.1 (FR-009 column population) — thread PDPA consent through
    // to the dedicated `event_registrations.attendee_pdpa_consent_acknowledged`
    // column. `undefined` from webhook ingest passes through as `null`
    // at the repo boundary (no consent captured upstream); CSV-import
    // path sets the literal true/false/null from `classifyPdpaConsent`.
    pdpaConsentAcknowledged: input.attendee.pdpaConsentAcknowledged ?? null,
  });
  if (!regInsert.ok) {
    const e = regInsert.error;
    let msg: string;
    if (e.kind === 'db_error') {
      msg = e.message;
    } else if (e.kind === 'invariant_violation') {
      msg = `event_registrations.upsert invariant violated: ${e.invariant}`;
      logger.fatal(
        {
          event: 'f6_registrations_repo_invariant_violation',
          tenantId: input.tenantId,
          invariant: e.invariant,
        },
        '[F6] event_registrations.upsert returned no row — likely RLS / schema drift',
      );
    } else if (e.kind === 'pseudonymised_row_rejected') {
      msg = `registration insert blocked: pseudonymised row ${e.registrationId}`;
    } else {
      msg = `registration insert rejected: ${e.kind}`;
      logger.fatal(
        {
          event: 'f6_use_case_called_unimplemented_port',
          tenantId: input.tenantId,
          method: e.method,
          futureTask: e.futureTask,
        },
        '[F6] event_registrations.insertOnConflictDoNothing called an unimplemented port stub',
      );
    }
    throw new TxStageError('registration_insert', msg);
  }

  // 5. Apply quota effect — Phase 6 T085 wiring.
  //    Acquires `eventcreate-quota:{tenant}:{member}:{event}` advisory
  //    lock, queries F2 plan allotments + F6 consumed counts, decides
  //    counted_against_* flags, emits the appropriate quota audit
  //    (decremented OR over_quota_warning), and UPDATEs the row when
  //    flags flip from neutral. Refunded ingests + non-benefit events
  //    short-circuit (no lock, no audit).
  const event = eventUpsert.value.event;
  const matchedMemberId = matchResult.value.resolution.matchedMemberId;
  const shouldApplyQuota =
    regInsert.value.isNewRegistration &&
    matchedMemberId !== null &&
    event.archivedAt === null &&
    (event.isPartnerBenefit || event.isCulturalEvent) &&
    input.attendee.paymentStatus !== 'refunded';
  if (shouldApplyQuota) {
    reportStage('quota_decrement');
    const quotaResult = await applyQuotaEffect(
      {
        tenantId: input.tenantId,
        matchedMemberId,
        eventId: event.eventId,
        registrationId: regInsert.value.registration.registrationId,
        eventFlags: {
          isPartnerBenefit: event.isPartnerBenefit,
          isCulturalEvent: event.isCulturalEvent,
        },
        // FR-016 — calendar year of event.startDate in Asia/Bangkok
        // wall time. For SweCham fiscal-year-start-month=1, fiscal
        // year == calendar year. Other tenants may diverge later.
        fiscalYear: deriveFiscalYear(event.startDate.toISOString(), 1),
        paymentStatus: input.attendee.paymentStatus,
        actorType: input.actorContext.actorType,
        actorUserId: input.actorContext.actorUserId,
        occurredAt: new Date(),
      },
      {
        quotaAccountingPort: ports.quotaAccountingPort,
        advisoryLockAcquirer: ports.advisoryLockAcquirer,
        audit,
      },
    );
    if (!quotaResult.ok) {
      const qe = quotaResult.error;
      let detail: string;
      if (
        qe.kind === 'lock_acquisition_failed' ||
        qe.kind === 'lock_key_invariant_violation' ||
        qe.kind === 'audit_emit_failed'
      ) {
        detail = qe.message;
      } else {
        // quota_lookup_failed — switch on the nested cause with an
        // explicit case per variant + `default: never` exhaustiveness
        // assertion so a future 4th variant compile-errors here.
        const c = qe.cause;
        switch (c.kind) {
          case 'db_error':
            detail = c.message;
            break;
          case 'member_not_found':
            detail = `member_not_found memberId=${c.memberId}`;
            break;
          case 'plan_not_found':
            detail = `plan_not_found memberId=${c.memberId}`;
            break;
          default: {
            const _exhaustive: never = c;
            void _exhaustive;
            detail = `unexpected quota lookup cause: ${JSON.stringify(c)}`;
          }
        }
      }
      throw new TxStageError(
        'quota_decrement',
        `apply-quota-effect failed (${qe.kind}): ${detail}`,
      );
    }
    const decided = quotaResult.value.quotaEffect;
    if (
      decided.countedAgainstPartnership ||
      decided.countedAgainstCulturalQuota
    ) {
      const upd = await registrationsRepo.setQuotaEffect(
        input.tenantId,
        regInsert.value.registration.registrationId,
        decided,
      );
      if (!upd.ok) {
        const e = upd.error;
        const msg =
          e.kind === 'db_error'
            ? e.message
            : e.kind === 'invariant_violation'
              ? `setQuotaEffect invariant: ${e.invariant}`
              : e.kind === 'pseudonymised_row_rejected'
                ? `setQuotaEffect on pseudonymised row ${e.registrationId}`
                : `setQuotaEffect ${e.kind}`;
        throw new TxStageError('quota_decrement', msg);
      }
      quotaEffect = decided;
    }
    // If `decided` is neutral (over-quota path), no UPDATE needed —
    // the row already has both flags = false from the INSERT.
  }

  // 6. Refund credit-back branch — Phase 6 wave-3 (FR-018 / US4 AS4).
  //    When the SAME (tenant, event, externalId) re-arrives with
  //    `payment_status='refunded'` AND the existing row was previously
  //    counted (`counted_against_*=true` on at least one scope), flip
  //    the row to refunded + zero out counted_against_* + emit one
  //    `quota_credit_back_refund` audit per previously-true scope.
  const existingReg = regInsert.value.registration;
  const isRefundTransition =
    !regInsert.value.isNewRegistration &&
    input.attendee.paymentStatus === 'refunded' &&
    existingReg.ticket.paymentStatus !== 'refunded' &&
    matchedMemberId !== null &&
    (existingReg.quotaEffect.countedAgainstPartnership ||
      existingReg.quotaEffect.countedAgainstCulturalQuota);
  if (isRefundTransition) {
    reportStage('quota_decrement');
    try {
      await ports.advisoryLockAcquirer.acquire(
        buildQuotaLockKey(input.tenantId, matchedMemberId, event.eventId),
      );
    } catch (e) {
      throw new TxStageError(
        'quota_decrement',
        `refund advisory-lock acquisition failed: ${
          (e as Error)?.message ?? 'unknown'
        }`,
      );
    }

    const flip = await registrationsRepo.markRefunded(
      input.tenantId,
      existingReg.registrationId,
    );
    if (!flip.ok) {
      const e = flip.error;
      const msg =
        e.kind === 'db_error'
          ? e.message
          : e.kind === 'invariant_violation'
            ? `markRefunded invariant: ${e.invariant}`
            : e.kind === 'pseudonymised_row_rejected'
              ? `markRefunded on pseudonymised row ${e.registrationId}`
              : `markRefunded ${e.kind}`;
      throw new TxStageError('quota_decrement', msg);
    }

    const prev = flip.value.previousQuotaEffect;
    let lookupResult:
      | Awaited<ReturnType<typeof ports.quotaAccountingPort.queryAllotments>>
      | null = null;
    if (prev.countedAgainstPartnership || prev.countedAgainstCulturalQuota) {
      lookupResult = await ports.quotaAccountingPort.queryAllotments({
        tenantId: input.tenantId,
        memberId: matchedMemberId,
        eventId: event.eventId,
        fiscalYear: deriveFiscalYear(event.startDate.toISOString(), 1),
      });
      if (!lookupResult.ok) {
        throw new TxStageError(
          'quota_decrement',
          `refund credit-back allotment lookup failed: ${
            lookupResult.error.kind === 'db_error'
              ? lookupResult.error.message
              : lookupResult.error.kind
          }`,
        );
      }
    }
    const baseRefundAudit = {
      tenantId: input.tenantId,
      actorType: input.actorContext.actorType,
      actorUserId: input.actorContext.actorUserId,
      occurredAt: new Date(),
    };
    if (prev.countedAgainstPartnership) {
      const { allotments, consumed } = lookupResult!.value;
      const allotmentAfter =
        allotments.partnershipPerEvent -
        consumed.partnershipConsumedForEvent;
      await emitOrThrow(audit, {
        ...baseRefundAudit,
        eventType: 'quota_credit_back_refund',
        summary: `partnership credit-back via refund: registration ${existingReg.registrationId} flipped paid→refunded`,
        payload: {
          severity: 'info',
          registrationId: existingReg.registrationId,
          memberId: matchedMemberId,
          scope: 'partnership',
          allotmentAfter,
        },
      });
    }
    if (prev.countedAgainstCulturalQuota) {
      const { allotments, consumed } = lookupResult!.value;
      const allotmentAfter =
        allotments.culturalPerYear - consumed.culturalConsumedForYear;
      await emitOrThrow(audit, {
        ...baseRefundAudit,
        eventType: 'quota_credit_back_refund',
        summary: `cultural credit-back via refund: registration ${existingReg.registrationId} flipped paid→refunded`,
        payload: {
          severity: 'info',
          registrationId: existingReg.registrationId,
          memberId: matchedMemberId,
          scope: 'cultural',
          allotmentAfter,
        },
      });
    }
    // POST-refund state: both flags false.
    quotaEffect = {
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
    };
  }

  // 7. Match-resolution audit (always emitted regardless of branch).
  // Failures route through emitOrThrow → TxStageError('audit_emit').
  reportStage('audit_emit');
  await emitMatchResolutionAudit(
    audit,
    input.tenantId,
    input.actorContext,
    matchResult.value.resolution,
    matchResult.value.fuzzyDetail,
    matchResult.value.unmatchedCandidates,
    regInsert.value.registration.registrationId,
    input.attendee.email,
  );

  return {
    registrationId: regInsert.value.registration.registrationId,
    eventCreated: eventUpsert.value.eventCreated,
    matchType: matchResult.value.resolution.type,
    matchedMemberId,
    quotaEffect,
    isNewRegistration: regInsert.value.isNewRegistration,
  };
}
