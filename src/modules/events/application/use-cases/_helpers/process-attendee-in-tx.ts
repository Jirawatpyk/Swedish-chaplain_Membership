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
import { F6_FISCAL_YEAR_START_MONTH } from './fiscal-year-constants';
import type { TenantId, MemberId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import {
  asMatchResolutionView,
  type MatchResolutionView,
  type QuotaEffect,
} from '../../../domain/event-registration';
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
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../../ports/registrations-repository';
import type { AttendeeMatcher } from '../../ports/attendee-matcher';
import type {
  QuotaAccountingPort,
  AllotmentSnapshot,
} from '../../ports/quota-accounting-port';
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

/**
 * R5.5 / Round 4 type-design — narrowed `TxStageError` cause contract.
 *
 * Native `ErrorOptions.cause: unknown` is wide open per ECMAScript
 * spec. The R3.3.1 caller convention (9 sites) ALWAYS wraps Result.err
 * discriminators OR raw catch-block exceptions as `Error` instances
 * before passing — never primitives, never `null`. This narrower
 * options type makes that convention compile-time-enforced: a future
 * `new TxStageError(stage, msg, { cause: 'plain string' })` would now
 * be a type error.
 */
export interface TxStageErrorOptions {
  readonly cause: Error;
}

export class TxStageError extends Error {
  /**
   * H8.1 / NEW-I5 / R5.5 — thread the original Error via
   * `options.cause` (Node 16.9+ / ES2022 Error.cause) so SRE forensics
   * see the raw exception's `.name` (e.g. 'PostgresError',
   * 'AbortError') alongside the failureStage. Pino's default `err`
   * serialiser surfaces `cause.name` + `cause.message` automatically.
   *
   * Options narrowed from `ErrorOptions` to `TxStageErrorOptions` so
   * the cause is statically guaranteed to be an `Error` — matches the
   * R3.3.1 caller convention (every call site wraps non-Error throws
   * via `safeStringify` before passing).
   */
  constructor(
    public readonly stage: FailureStage,
    message: string,
    options?: TxStageErrorOptions,
  ) {
    super(message, options);
    this.name = 'TxStageError';
  }
}

/**
 * R5.8 / Round 4 simplify-S1 — construct a synthetic-cause Error with
 * its `name` set to the wrapping error class's discriminator so
 * pino's default `err` serialiser surfaces `cause.name === 'AuditEmitError'`
 * (or 'EventsRepoError', 'QuotaEffectError', etc.) on the audit
 * fallback log line. The pre-R5.8 pattern left `name === 'Error'`,
 * forcing SRE dashboards to grep the cause.message body for the
 * discriminator — slower triage when filtering log streams.
 *
 * Message stays as just the `detail` (no class-name prefix) — pino
 * renders the chain as `cause: AuditEmitError: db_error: ...` from
 * `${cause.name}: ${cause.message}`, so re-prefixing the class name
 * inside the message would double the discriminator.
 *
 * Used by every R3.3.1 synthetic-cause site that wraps a Result.err
 * (no raw exception in scope to thread).
 */
function makeSyntheticCause(errorClass: string, detail: string): Error {
  const e = new Error(detail);
  e.name = errorClass;
  return e;
}

/**
 * R5.3.1 / Round 4 I-4 — JSON-stringify a non-Error value for
 * cause-wrapping. Guards against circular references (which would
 * crash a naive `JSON.stringify`) and caps the output so a future
 * adversarial throw can't bloat the audit row.
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      return v;
    });
    return (json ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

/**
 * Format a `markRefunded` repo error into a human-readable string for
 * the `TxStageError` payload. Switch exhausts the 4 known variants;
 * CLAUDE.md anti-pattern (nested ternary) avoided.
 */
function markRefundedErrorMessage(e: RegistrationsRepositoryError): string {
  switch (e.kind) {
    case 'db_error':
      return e.message;
    case 'invariant_violation':
      return `markRefunded invariant: ${e.invariant}`;
    case 'pseudonymised_row_rejected':
      return `markRefunded on pseudonymised row ${e.registrationId}`;
    case 'not_implemented':
      return `markRefunded not implemented: ${e.method}`;
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
    // R3.3.1 / R5.8 — thread synthetic cause so SRE forensics see the
    // error kind + discriminator on `cause.name` (now set to the
    // wrapping class name) + `cause.message`. Pino's default `err`
    // serialiser surfaces both. Result.err has no raw Error in scope.
    const causeDetail =
      result.error.kind === 'db_error'
        ? `${result.error.kind}: ${result.error.message}`
        : `${result.error.kind}: ${result.error.eventType}`;
    throw new TxStageError(
      'audit_emit',
      `audit emit failed (kind=${result.error.kind}): ${
        result.error.kind === 'db_error'
          ? result.error.message
          : result.error.eventType
      }`,
      { cause: makeSyntheticCause('AuditEmitError', causeDetail) },
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
     * column added by migration 0140.
     *
     * TYPE-D2 (Round 1 — type-design-analyzer): required + tri-state
     * (no `undefined`). Callers explicitly pass `null` for "unknown"
     * — webhook ingest, generic-CSV. `true`/`false` from EventCreate
     * adapter's `classifyPdpaConsent`. Three states preserved end-
     * to-end; the prior optional 4-state cardinality (undefined / null
     * / true / false) was eliminated by `exactOptionalPropertyTypes`.
     */
    readonly pdpaConsentAcknowledged: boolean | null;
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
  // R3.7.2 — accept the narrowed view directly so the switch arms
  // narrow on `resolution.type` without non-null assertions (H3.2
  // already pinned the invariant at the type level; this helper was
  // the lone holdout still using `.matchedMemberId!`).
  resolution: MatchResolutionView,
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
      // R10.1 / QA F-1 — `MatchResolutionView.member_contact` was
      // relaxed to accept matchedContactId: ContactId | null for the
      // admin-relink path (FR-014). Webhook ingest reaches this code
      // path via the `match-attendee-to-member.ts` flow which always
      // populates matchedContactId (via contacts.email lookup), so the
      // null case is a programming invariant violation if it ever
      // fires here. Throw loudly with the registrationId for forensic.
      if (resolution.matchedContactId === null) {
        throw new Error(
          `F6 invariant: emitMatchResolutionAudit called with member_contact + matchedContactId=null on the webhook-ingest path (registrationId=${registrationId}). Admin-relink emits a different audit event type; this should be unreachable.`,
        );
      }
      await emitOrThrow(audit, {
        ...base,
        eventType: 'attendee_matched_member_contact',
        summary: `attendee matched to member via contact email (${attendeeEmail})`,
        payload: {
          severity: 'info',
          registrationId,
          matchedMemberId: resolution.matchedMemberId,
          matchedContactId: resolution.matchedContactId,
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
          matchedMemberId: resolution.matchedMemberId,
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
          matchedMemberId: resolution.matchedMemberId,
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
    // R3.3.1 / R5.8 — thread synthetic cause carrying the error kind
    // so SRE forensics distinguish db_error / invariant_violation /
    // unimplemented via cause.name + cause.message on the audit
    // fallback log.
    throw new TxStageError('event_upsert', msg, {
      cause: makeSyntheticCause('EventsRepoError', `${e.kind}: ${msg}`),
    });
  }

  // 3. Attendee match (read-only against F3 — runs inside tx for
  //    consistent snapshot). Failures roll up to `event_upsert` stage
  //    via the explicit `TxStageError('event_upsert', ...)` below
  //    because the audit taxonomy doesn't expose a `match_attendee`
  //    enum value. No redundant `reportStage` here — the stage is
  //    still `event_upsert` from the preceding reportStage call above.
  const matchResult = await attendeeMatcher.match({
    tenantId: input.tenantId,
    attendeeEmail: asAttendeeEmail(input.attendee.email),
    attendeeCompany: input.attendee.companyName,
  });
  if (!matchResult.ok) {
    // R3.3.1 / R5.8 — thread synthetic cause so SRE forensics see the
    // matcher's underlying failure on `cause.name` + `cause.message`.
    throw new TxStageError('event_upsert', matchResult.error.message, {
      cause: makeSyntheticCause('AttendeeMatchError', matchResult.error.message),
    });
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
    // column. The input type is now tri-state `boolean | null` (TYPE-D2,
    // Round 1 — exactOptionalPropertyTypes excludes undefined). Webhook
    // ingest passes literal `null` (no consent captured upstream); CSV-
    // import path sets the literal true/false/null from `classifyPdpaConsent`.
    pdpaConsentAcknowledged: input.attendee.pdpaConsentAcknowledged,
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
    // R3.3.1 / R5.8 — thread synthetic cause carrying the error kind
    // so SRE forensics distinguish db_error / invariant_violation /
    // pseudonymised_row_rejected / unimplemented via cause.name +
    // cause.message on the audit fallback.
    throw new TxStageError('registration_insert', msg, {
      cause: makeSyntheticCause('RegistrationsRepoError', `${e.kind}: ${msg}`),
    });
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
        // wall time. F6 quota counters bucket by **calendar year** even
        // for tenants whose F4 fiscal year starts elsewhere — see
        // `F6_FISCAL_YEAR_START_MONTH` doc for the cross-module rationale.
        fiscalYear: deriveFiscalYear(
          event.startDate.toISOString(),
          F6_FISCAL_YEAR_START_MONTH,
        ),
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
      // R3.3.1 / R5.8 — thread synthetic cause carrying the quota-
      // error kind + nested cause discriminator so SRE forensics can
      // branch on lock_acquisition_failed vs quota_lookup_failed.db_error
      // vs member_not_found at the cause level (cause.name +
      // cause.message both surfaced).
      throw new TxStageError(
        'quota_decrement',
        `apply-quota-effect failed (${qe.kind}): ${detail}`,
        { cause: makeSyntheticCause('QuotaEffectError', `${qe.kind}: ${detail}`) },
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
        // R3.3.1 / R5.8 — thread synthetic cause for setQuotaEffect
        // repo error discriminator (db_error / invariant_violation /
        // pseudonymised_row_rejected / unimplemented).
        throw new TxStageError('quota_decrement', msg, {
          cause: makeSyntheticCause(
            'RegistrationsRepoError.setQuotaEffect',
            `${e.kind}: ${msg}`,
          ),
        });
      }
      quotaEffect = decided;
    }
    // If `decided` is neutral (over-quota path), no UPDATE needed —
    // the row already has both flags = false from the INSERT.
  }

  // 6. Refund credit-back branch — Phase 6 wave-3 (FR-018 / US4 AS4) +
  //    F6.1 Phase 4 US2 (T033) cancellation cascade.
  //    When the SAME (tenant, event, externalId) re-arrives with
  //    `payment_status='refunded'`, flip the row to refunded + zero out
  //    counted_against_* + emit one `quota_credit_back_refund` audit per
  //    previously-true scope.
  //
  //    The matchedMember + counted_against_* gates ONLY guard the quota
  //    credit-back audit emit (they're meaningless without matched member
  //    or counted state); the markRefunded flip itself ALWAYS runs when
  //    an existing non-refunded row is re-uploaded as Cancelled. This
  //    enables T032: a Cancellation re-upload of an unmatched / non-
  //    benefit-event attendee still flips payment_status to refunded
  //    (the CSV admin audit trail captures the row state regardless of
  //    quota scope).
  // R6.W / Round 5 staff-review R013 closure — documented race:
  //
  // The advisory-lock acquisition below is gated on `hasMatchedQuotaScope`
  // (matched member + counted_against_* flag). For unmatched/non_member
  // rows with no quota effect, no lock is acquired — the `markRefunded`
  // UPDATE still mutates `event_registrations.payment_status` but doesn't
  // serialise with concurrent `relinkRegistration` on the SAME row.
  //
  // End-state collision possible if relink + refund commit concurrently
  // on a previously-unmatched row that relink moves to a quota-bearing
  // member: relink emits `quota_*_decremented` audit; refund-flip
  // clears `counted_against_*`. Final-state row says "matched + refunded
  // + not counted" while audit log says quota was consumed.
  //
  // MVCC + `UPDATE … RETURNING` prevents lost writes; the divergence
  // is purely audit-vs-state. At SweCham single-admin scale unobservable.
  // For F6.2 multi-admin MTA: either (a) acquire per-registration
  // advisory lock at refund-flip time unconditionally, or (b) widen
  // relink to compare-and-swap on the quota-effect snapshot.
  const existingReg = regInsert.value.registration;
  const isRefundTransition =
    !regInsert.value.isNewRegistration &&
    input.attendee.paymentStatus === 'refunded' &&
    existingReg.ticket.paymentStatus !== 'refunded';
  if (isRefundTransition) {
    reportStage('quota_decrement');
    // Advisory lock + quota-credit-back audit emit are conditional on
    // matched member; the markRefunded flip is unconditional.
    const hasMatchedQuotaScope =
      matchedMemberId !== null &&
      (existingReg.quotaEffect.countedAgainstPartnership ||
        existingReg.quotaEffect.countedAgainstCulturalQuota);
    if (hasMatchedQuotaScope) {
      try {
        await ports.advisoryLockAcquirer.acquire(
          buildQuotaLockKey(input.tenantId, matchedMemberId!, event.eventId),
        );
      } catch (e) {
        // R3.3.1 / R5.3.1 / Round 4 I-4 — thread raw Error as cause so
        // SRE sees the lock adapter's underlying exception class
        // (PostgresError on pool-exhaust, etc.). Non-Error throws get
        // JSON-stringified instead of `String(e)` so plain-object
        // payloads (`{code:'POOL_EXHAUSTED',detail:'…'}`) preserve
        // their diagnostic content. Some `@neondatabase/serverless`
        // versions throw plain objects from pool-exhaustion paths.
        const rawForCause =
          e instanceof Error
            ? e
            : new Error(`NonError(${safeStringify(e)})`);
        const messageForWrap =
          e instanceof Error
            ? (e.message ?? 'unknown')
            : safeStringify(e);
        throw new TxStageError(
          'quota_decrement',
          `refund advisory-lock acquisition failed: ${messageForWrap}`,
          { cause: rawForCause },
        );
      }
    }

    const flip = await registrationsRepo.markRefunded(
      input.tenantId,
      existingReg.registrationId,
    );
    if (!flip.ok) {
      // R3.3.1 / R5.8 — thread synthetic cause carrying the
      // markRefunded error kind so SRE forensics distinguish the 4
      // variants (registration_not_found / already_refunded /
      // db_error / pseudonymised_row_rejected) on the audit fallback
      // log via cause.name + cause.message.
      const refundDetail = markRefundedErrorMessage(flip.error);
      throw new TxStageError(
        'quota_decrement',
        refundDetail,
        {
          cause: makeSyntheticCause(
            'MarkRefundedError',
            `${flip.error.kind}: ${refundDetail}`,
          ),
        },
      );
    }

    const prev = flip.value.previousQuotaEffect;
    // R3 (R2 type-design): imported from quota-accounting-port as
    // the canonical paired-snapshot type (was inline-redeclared).
    let allotmentSnapshot: AllotmentSnapshot | null = null;
    if (
      matchedMemberId !== null &&
      (prev.countedAgainstPartnership || prev.countedAgainstCulturalQuota)
    ) {
      const r = await ports.quotaAccountingPort.queryAllotments({
        tenantId: input.tenantId,
        memberId: matchedMemberId,
        eventId: event.eventId,
        fiscalYear: deriveFiscalYear(
          event.startDate.toISOString(),
          F6_FISCAL_YEAR_START_MONTH,
        ),
      });
      if (!r.ok) {
        // R3.3.1 / R5.8 — thread synthetic cause carrying the quota-
        // accounting error kind so SRE forensics see the underlying
        // DB / lookup discriminator via cause.name + cause.message
        // (vs the wrapping outer message).
        const causeDetail =
          r.error.kind === 'db_error' ? r.error.message : r.error.kind;
        throw new TxStageError(
          'quota_decrement',
          `refund credit-back allotment lookup failed: ${causeDetail}`,
          {
            cause: makeSyntheticCause(
              'QuotaAccountingError',
              `${r.error.kind}: ${causeDetail}`,
            ),
          },
        );
      }
      allotmentSnapshot = r.value;
    }
    // Audit emit only when a matched member + counted scope existed —
    // otherwise there's no allotment to credit back (the row flip itself
    // is already complete; CSV-import history captures the cancellation
    // forensically via `csv_import_completed`).
    if (matchedMemberId !== null && allotmentSnapshot !== null) {
      const baseRefundAudit = {
        tenantId: input.tenantId,
        actorType: input.actorContext.actorType,
        actorUserId: input.actorContext.actorUserId,
        occurredAt: new Date(),
      };
      if (prev.countedAgainstPartnership) {
        const { allotments, consumed } = allotmentSnapshot;
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
        const { allotments, consumed } = allotmentSnapshot;
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
    }
    // POST-refund state: both flags false.
    quotaEffect = {
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
    };
  }

  // 7. Match-resolution audit (always emitted regardless of branch).
  // Failures route through emitOrThrow → TxStageError('audit_emit').
  // R3.7.2 — narrow the port-side `MatchResolution` to the
  // discriminated `MatchResolutionView` at this boundary so the audit
  // helper switch arms get compile-time-narrowed non-null IDs (H3.2
  // invariant). A read-time violation throws
  // `MatchResolutionInvariantError` — caught by the outer rollback
  // path + surfaces in `webhook_rolled_back` audit.
  reportStage('audit_emit');
  await emitMatchResolutionAudit(
    audit,
    input.tenantId,
    input.actorContext,
    asMatchResolutionView(matchResult.value.resolution),
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
