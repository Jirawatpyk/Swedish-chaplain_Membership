/**
 * T047 — `ingestWebhookAttendee` use-case (F6 Application).
 *
 * Strict-transactional ACID unit per FR-037. Orchestrates the full
 * webhook-ingest pipeline in ONE database transaction:
 *
 *   1. Validate payload (zod) — outside tx
 *   2. Begin tx + SET LOCAL ROLE chamber_app + SET LOCAL app.current_tenant
 *   3. Idempotency receipt INSERT ON CONFLICT DO NOTHING
 *      - On conflict → emit `webhook_duplicate_rejected` IN-TX + return
 *        `duplicate_request_id` err. Tx commits with ONLY the duplicate
 *        audit row (no event/registration side effects).
 *   4. Event upsert (FR-010 last-write-wins)
 *   5. Attendee match (4-rule cascade)
 *   6. Quota effect compute (Phase 3 MVP = neutral; Phase 6 T085 wires real)
 *   7. Registration insert (FR-011 ON CONFLICT DO NOTHING — second
 *      idempotency layer)
 *   8. Emit `webhook_receipt_verified` + match-resolution audit IN-TX
 *   9. Tx commits — return success
 *
 * On any throw at stages 3–8: tx ROLLS BACK (zero side effects); the
 * catch block emits `webhook_rolled_back` in a SEPARATE tx via
 * `emitRolledBackStandalone` (FR-037 dual-write fallback). Returns
 * `rolled_back` err.
 *
 * Deps shape — FACTORIES not pre-bound port instances. This is the F5
 * stripe-webhook precedent inverted: F5 binds at the route layer
 * (`runInTenant` inside the route); F6 binds INSIDE the use-case because
 * the use-case OWNS the tx boundary (strict-tx invariant). Tests
 * substitute the factories to inject failures at any stage.
 *
 * Spec authority:
 *   - FR-001, FR-002 (verify happens at route layer; this use-case
 *     receives a verified payload), FR-004 (idempotency), FR-010
 *     (event upsert), FR-011 + FR-011a (registration idempotency +
 *     forward-compat metadata), FR-012 (match cascade), FR-037
 *     (strict-tx + dual-write rolled-back audit)
 *   - research.md R6 (dual-write fallback)
 *   - contracts/audit-port.md § 1–2 (audit envelope shape)
 *
 * Security-critical use-case → 100% branch coverage target per
 * Constitution Principle II.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { asTenantId } from '@/modules/members';
import {
  EventCreatePayloadV1,
  EVENT_CANONICAL_KEYS,
  ATTENDEE_CANONICAL_KEYS,
  extractMetadata,
} from '../../domain/eventcreate-payload';
import {
  asExternalEventId,
  asExternalAttendeeId,
  asAttendeeEmail,
} from '../../domain/branded-types';
import type {
  RegistrationId,
} from '../../domain/branded-types';
import type { QuotaEffect } from '../../domain/event-registration';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { ProcessingOutcome } from '../../domain/value-objects/webhook-outcome';
import type { IdempotencySource } from '../../domain/value-objects/source';
import type {
  EventsRepository,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
} from '../ports/registrations-repository';
import type {
  IdempotencyStore,
} from '../ports/idempotency-store';
import type {
  AttendeeMatcher,
} from '../ports/attendee-matcher';
import type {
  F6AuditPort,
  F6AuditEntry,
  AuditEmitError,
} from '../ports/audit-port';
import type { AuditEventId } from '@/modules/auth';
import type { MemberId } from '@/modules/members';

// ---------------------------------------------------------------------------
// Inputs + outputs
// ---------------------------------------------------------------------------

export interface IngestWebhookAttendeeInput {
  /**
   * Plain `string` — the use-case brands internally (via `asTenantId`)
   * for audit emission. Callers can pass either a raw slug or a branded
   * `TenantId` / `TenantSlug` (TS structural typing accepts both since
   * they're string aliases at runtime).
   */
  readonly tenantId: string;
  readonly requestId: string;
  readonly source: IdempotencySource;
  readonly rawPayload: unknown;
  readonly sourceIp: string;
  /** Whether the signature verified against the GRACE secret (forwarded
   *  for the audit `graceSecretUsed` flag). */
  readonly graceSecretUsed?: boolean;
}

export interface IngestSuccess {
  readonly matched: MatchType;
  readonly matchedMemberId: MemberId | null;
  readonly eventCreated: boolean;
  readonly registrationId: RegistrationId;
  readonly quotaEffect: QuotaEffect;
  /**
   * Wall-clock latency from use-case start to result resolution.
   * Route emits `eventcreateMetrics.ingestLatencyMs` from this value
   * so the SC-003 p95<300ms SLO becomes observable.
   */
  readonly ingestLatencyMs: number;
}

export type IngestError =
  | {
      readonly kind: 'malformed_rejected';
      readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    }
  | { readonly kind: 'duplicate_request_id'; readonly originalProcessedAt: Date | null }
  | { readonly kind: 'tenant_ingest_disabled' }
  | {
      readonly kind: 'rolled_back';
      readonly failureStage: FailureStage;
      readonly errorMessage: string;
      /**
       * True when `emitRolledBackStandalone` ALSO failed (FR-037
       * catastrophic double-failure). Route includes this in its 500
       * log line so SREs know the audit-integrity surface is
       * compromised and stderr fallback is the only forensic source.
       */
      readonly auditFallbackFailed: boolean;
      /**
       * Use-case-internal wall-clock latency from start to rollback.
       * Distinct from route-end-to-end latency (which includes
       * body-read + signature-verify time). Route emits this on the
       * `ingestLatencyMs` histogram so dashboards can compare success
       * vs rolled_back p95 on equivalent semantics.
       */
      readonly ingestLatencyMs: number;
    };

/**
 * FailureStage matches the audit-payload `webhook_rolled_back.failureStage`
 * shape in contracts/audit-port.md § 1. `match_attendee` failures roll up
 * to `event_upsert` (same logical stage of work) since the audit taxonomy
 * has 6 enum values; we surface the same closed set so the audit payload
 * is type-safe.
 */
export type FailureStage =
  | 'event_upsert'
  | 'registration_insert'
  | 'idempotency_receipt'
  | 'quota_decrement'
  | 'audit_emit'
  | 'unknown';

/**
 * Tx-scoped ports — the deps factory binds Drizzle adapters to a
 * specific transaction handle and yields this bundle to the use-case
 * inside `runInTenantTx`.
 */
export interface TxScopedPorts {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly idempotencyStore: IdempotencyStore;
  readonly attendeeMatcher: AttendeeMatcher;
  readonly audit: F6AuditPort;
}

export interface IngestWebhookAttendeeDeps {
  /**
   * Tx + tenant-context boundary owned by Infrastructure (per
   * Constitution Principle III — Application MUST NOT import
   * `drizzle-orm`). The factory in `infrastructure/di.ts` wires this
   * to `runInTenant(ctx, tx => …)` + binds the Drizzle adapter
   * instances to the tx.
   *
   * The use-case calls this once to enter the strict-transactional
   * ACID unit (FR-037). On throw inside `fn`, the tx rolls back +
   * the throw propagates back to the use-case's catch handler.
   */
  readonly runInTenantTx: <T>(
    tenantId: string,
    fn: (ports: TxScopedPorts) => Promise<T>,
  ) => Promise<T>;

  /**
   * Separate-tx rolled-back emitter for FR-037 dual-write fallback.
   * Internally uses a fresh `db.transaction` so commit semantics work
   * even when the primary tx is mid-rollback.
   */
  readonly emitRolledBackStandalone: (
    entry: F6AuditEntry<'webhook_rolled_back'>,
  ) => Promise<Result<AuditEventId, AuditEmitError>>;

  /**
   * Generic standalone-tx emit for audit events OUTSIDE the strict-tx
   * unit. Invoked by the route handler for `webhook_signature_rejected`
   * (signature fails BEFORE the ingest use-case starts; we still want
   * a durable 5-year forensic trail) and for the config-load-failed
   * branch. Wraps `F6AuditPort.emitStandalone`.
   */
  readonly emitStandalone: <T extends import('../ports/audit-port').F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ) => Promise<Result<AuditEventId, AuditEmitError>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TxStageError extends Error {
  constructor(public readonly stage: FailureStage, message: string) {
    super(message);
  }
}

/**
 * Audit emit with Result check + throw on err.
 *
 * If the audit INSERT silently failed (Postgres connection blip, enum
 * drift, jsonb serialisation error) the tx would COMMIT side effects
 * with NO audit row AND NO `webhook_rolled_back` fallback — a hard
 * silent-failure (state mutation + no audit trail) violating FR-009 +
 * FR-037. Every `audit.emit` Result is therefore checked; on err →
 * throw `TxStageError('audit_emit', ...)` so the outer catch fires the
 * dual-write fallback audit + rolls back the tx. Side effects + audit
 * row stay consistent.
 */
async function emitOrThrow(
  audit: F6AuditPort,
  entry: F6AuditEntry,
): Promise<void> {
  const result = await audit.emit(entry);
  if (!result.ok) {
    throw new TxStageError(
      'audit_emit',
      `audit emit failed (kind=${result.error.kind}): ${
        result.error.kind === 'db_error' ? result.error.message : result.error.eventType
      }`,
    );
  }
}

/**
 * Single source of truth for the Domain MatchType → audit/metric
 * ProcessingOutcome label mapping. Exported so the route handler can
 * use it for metric emission without duplicating the lookup. Adding
 * a new MatchType breaks compilation here AND at the route — never
 * silently fall through.
 */
export const MATCH_TYPE_TO_PROCESSING_OUTCOME: Readonly<Record<MatchType, ProcessingOutcome>> = {
  member_contact: 'matched_member_contact',
  member_domain: 'matched_member_domain',
  member_fuzzy: 'matched_member_fuzzy',
  non_member: 'non_member',
  unmatched: 'unmatched',
};

/**
 * `IdempotencySource` → audit-payload source label. Typed helper
 * eliminates the duplicated inline ternary at the two emit sites
 * (`webhook_receipt_verified` + `webhook_rolled_back`). Adding a
 * third source variant breaks compilation here once, instead of
 * silently falling through both call sites.
 */
function toAuditSource(s: IdempotencySource): 'eventcreate' | 'eventcreate_csv' {
  return s === 'eventcreate_webhook' ? 'eventcreate' : 'eventcreate_csv';
}

async function emitMatchResolutionAudit(
  audit: F6AuditPort,
  input: IngestWebhookAttendeeInput,
  resolution: { type: MatchType; matchedMemberId: MemberId | null; matchedContactId: import('@/modules/members').ContactId | null },
  fuzzyDetail: { attendeeCompanyOriginal: string; matchedMemberCompanyNormalised: string; levenshteinDistance: number } | null,
  unmatchedCandidates: ReadonlyArray<{ memberId: MemberId; levenshteinDistance: number }> | null,
  registrationId: RegistrationId,
  attendeeEmail: string,
): Promise<void> {
  const base = {
    tenantId: asTenantId(input.tenantId),
    actorType: 'zapier_webhook' as const,
    actorUserId: null,
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
          matchedMemberCompanyNormalised: fuzzyDetail?.matchedMemberCompanyNormalised ?? '',
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
          candidateLevenshteinDistances: unmatchedCandidates?.map((c) => c.levenshteinDistance) ?? [],
        },
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function ingestWebhookAttendee(
  input: IngestWebhookAttendeeInput,
  deps: IngestWebhookAttendeeDeps,
): Promise<Result<IngestSuccess, IngestError>> {
  // Phase 1: payload validation (no tx)
  const parsed = EventCreatePayloadV1.safeParse(input.rawPayload);
  if (!parsed.success) {
    return err({
      kind: 'malformed_rejected',
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const startedAtMs = Date.now();
  let failureStage: FailureStage = 'unknown';
  let errorMessage = '';

  try {
    // Phase 2: strict-transactional ACID unit
    return await deps.runInTenantTx(input.tenantId, async (ports) => {
      const { eventsRepo, registrationsRepo, idempotencyStore, attendeeMatcher, audit } = ports;

      // 1. Idempotency receipt
      failureStage = 'idempotency_receipt';
      const receipt = await idempotencyStore.tryInsert({
        tenantId: asTenantId(input.tenantId),
        source: input.source,
        requestId: input.requestId,
      });
      if (!receipt.ok) {
        throw new TxStageError('idempotency_receipt', receipt.error.message);
      }
      if (!receipt.value.wasFresh) {
        // Duplicate — advance failureStage to audit_emit before the
        // emit so a duplicate-path audit failure is correctly labelled
        // (a duplicate-path audit failure would otherwise be
        // mislabelled as `idempotency_receipt`).
        failureStage = 'audit_emit';
        await emitOrThrow(audit, {
          eventType: 'webhook_duplicate_rejected',
          tenantId: asTenantId(input.tenantId),
          actorType: 'zapier_webhook',
          actorUserId: null,
          occurredAt: new Date(),
          summary: `duplicate webhook delivery — request_id=${input.requestId}`,
          payload: {
            severity: 'info',
            requestId: input.requestId,
            originalProcessedAt:
              receipt.value.originalProcessedAt?.toISOString() ?? new Date().toISOString(),
            sourceIp: input.sourceIp,
          },
        });
        return err({
          kind: 'duplicate_request_id',
          originalProcessedAt: receipt.value.originalProcessedAt,
        });
      }

      // 2. Event upsert
      failureStage = 'event_upsert';
      const eventUpsert = await eventsRepo.upsert({
        tenantId: asTenantId(input.tenantId),
        source: 'eventcreate',
        externalId: asExternalEventId(parsed.data.event.externalId),
        name: parsed.data.event.name,
        description: parsed.data.event.description ?? null,
        startDate: new Date(parsed.data.event.startDate),
        endDate: parsed.data.event.endDate ? new Date(parsed.data.event.endDate) : null,
        location: parsed.data.event.location ?? null,
        category: parsed.data.event.category ?? null,
        eventcreateUrl: parsed.data.event.eventCreateUrl ?? null,
        metadata: extractMetadata(parsed.data.event, EVENT_CANONICAL_KEYS),
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
      // consistent snapshot). Roll up to event_upsert stage on failure
      // because the audit taxonomy doesn't expose match_attendee.
      failureStage = 'event_upsert';
      const matchResult = await attendeeMatcher.match({
        tenantId: asTenantId(input.tenantId),
        attendeeEmail: asAttendeeEmail(parsed.data.attendee.email),
        attendeeCompany: parsed.data.attendee.companyName ?? null,
      });
      if (!matchResult.ok) {
        throw new TxStageError('event_upsert', matchResult.error.message);
      }

      // 4. Quota effect — Phase 3 MVP returns neutral; Phase 6 T085
      // wires the real `apply-quota-effect.ts` that reads F2 plan +
      // counts consumed registrations under an advisory lock.
      const quotaEffect: QuotaEffect = {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      };

      // 5. Registration insert (FR-011 second idempotency layer)
      failureStage = 'registration_insert';
      const regInsert = await registrationsRepo.insertOnConflictDoNothing({
        tenantId: asTenantId(input.tenantId),
        eventId: eventUpsert.value.event.eventId,
        externalId: asExternalAttendeeId(parsed.data.attendee.externalId),
        attendee: {
          email: asAttendeeEmail(parsed.data.attendee.email),
          name: parsed.data.attendee.fullName,
          company: parsed.data.attendee.companyName ?? null,
        },
        match: matchResult.value.resolution,
        ticket: {
          type: parsed.data.attendee.ticketType ?? null,
          priceThb: parsed.data.attendee.ticketPricePaid ?? null,
          paymentStatus: parsed.data.attendee.paymentStatus,
        },
        quotaEffect,
        metadata: extractMetadata(parsed.data.attendee, ATTENDEE_CANONICAL_KEYS),
        registeredAt: new Date(parsed.data.attendee.registeredAt),
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

      // 6. Emit success audit + match-resolution audit
      failureStage = 'audit_emit';
      const ingestLatencyMs = Date.now() - startedAtMs;
      await emitOrThrow(audit, {
        eventType: 'webhook_receipt_verified',
        tenantId: asTenantId(input.tenantId),
        actorType: 'zapier_webhook',
        actorUserId: null,
        occurredAt: new Date(),
        summary: `webhook verified — event=${parsed.data.event.externalId} attendee=${parsed.data.attendee.externalId}`,
        payload: {
          severity: 'info',
          requestId: input.requestId,
          source: toAuditSource(input.source),
          eventExternalId: parsed.data.event.externalId,
          attendeeExternalId: parsed.data.attendee.externalId,
          processingOutcome:
            MATCH_TYPE_TO_PROCESSING_OUTCOME[matchResult.value.resolution.type],
          matchedMemberId: matchResult.value.resolution.matchedMemberId,
          registrationId: regInsert.value.registration.registrationId,
          eventCreated: eventUpsert.value.eventCreated,
          ingestLatencyMs,
          graceSecretUsed: input.graceSecretUsed ?? false,
        },
      });

      await emitMatchResolutionAudit(
        audit,
        input,
        matchResult.value.resolution,
        matchResult.value.fuzzyDetail,
        matchResult.value.unmatchedCandidates,
        regInsert.value.registration.registrationId,
        parsed.data.attendee.email,
      );

      return ok({
        matched: matchResult.value.resolution.type,
        matchedMemberId: matchResult.value.resolution.matchedMemberId,
        eventCreated: eventUpsert.value.eventCreated,
        registrationId: regInsert.value.registration.registrationId,
        quotaEffect,
        ingestLatencyMs,
      });
    });
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    const stage: FailureStage = e instanceof TxStageError ? e.stage : failureStage;
    const errorStack = e instanceof Error && e.stack ? e.stack : null;

    // FR-037 dual-write fallback: emit `webhook_rolled_back` in a
    // SEPARATE tx so the audit row commits even though the primary tx
    // rolled back. The audit emitter internally handles a pino.fatal
    // fallback if the secondary tx ALSO fails — we additionally
    // surface a logger.fatal here so SREs see "primary tx rolled back
    // AND audit fallback also failed" as a distinct catastrophic
    // signal.
    const fallbackResult = await deps.emitRolledBackStandalone({
      eventType: 'webhook_rolled_back',
      tenantId: asTenantId(input.tenantId),
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: `webhook rolled back at stage ${stage}: ${errorMessage}`,
      payload: {
        severity: 'error',
        requestId: input.requestId,
        source: toAuditSource(input.source),
        failureStage: stage,
        errorMessage,
        errorStack,
      },
    });

    let auditFallbackFailed = false;
    if (!fallbackResult.ok) {
      auditFallbackFailed = true;
      eventcreateMetrics.auditFallbackDoubleFailure(input.tenantId, stage);
      logger.fatal(
        {
          event: 'f6_audit_fallback_double_failure',
          tenantId: input.tenantId,
          requestId: input.requestId,
          primaryStage: stage,
          fallbackErrorKind: fallbackResult.error.kind,
        },
        '[F6] CRITICAL: primary tx rolled back AND audit fallback also failed — only stderr trail remains (FR-037 catastrophic)',
      );
    }

    return err({
      kind: 'rolled_back',
      failureStage: stage,
      errorMessage,
      auditFallbackFailed,
      ingestLatencyMs: Date.now() - startedAtMs,
    });
  }
}

// Composition factory lives in Infrastructure/di per Constitution
// Principle III (Application MUST NOT import from Infrastructure).
// See `src/modules/events/infrastructure/di.ts` for the wiring.
