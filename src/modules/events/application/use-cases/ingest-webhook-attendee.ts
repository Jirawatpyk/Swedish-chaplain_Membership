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
 *   4-7. Delegate the inner attendee-processing pipeline to the shared
 *        `processAttendeeInTx` helper (event upsert → match → registration
 *        insert → quota effect → refund credit-back → match-resolution
 *        audit). Same helper is reused by the Phase 7 CSV importer
 *        (`importCsv`) so webhook ↔ CSV equivalence (FR-027) is by
 *        construction, not by parallel implementation drift.
 *   8. Emit `webhook_receipt_verified` IN-TX
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
 *     forward-compat metadata), FR-012 (match cascade), FR-027 (CSV
 *     equivalence via shared helper), FR-037 (strict-tx + dual-write
 *     rolled-back audit)
 *   - research.md R6 (dual-write fallback)
 *   - contracts/audit-port.md § 1–2 (audit envelope shape)
 *
 * Security-critical use-case → 100% branch coverage target per
 * Constitution Principle II.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { redactStack } from '@/lib/redact-stack';
import { asTenantId } from '@/modules/members';
import {
  EventCreatePayloadV1,
  EVENT_CANONICAL_KEYS,
  ATTENDEE_CANONICAL_KEYS,
  extractMetadata,
} from '../../domain/eventcreate-payload';
import type {
  RegistrationId,
} from '../../domain/branded-types';
import type { QuotaEffect } from '../../domain/event-registration';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { ProcessingOutcome } from '../../domain/value-objects/webhook-outcome';
import type { IdempotencySource } from '../../domain/value-objects/source';
import type {
  IdempotencyStore,
} from '../ports/idempotency-store';
import type {
  F6AuditEntry,
  AuditEmitError,
} from '../ports/audit-port';
import type { AuditEventId } from '@/modules/auth';
import type { MemberId } from '@/modules/members';
import {
  processAttendeeInTx,
  emitOrThrow,
  TxStageError,
  type FailureStage,
  type ProcessAttendeeInTxPorts,
} from './_helpers/process-attendee-in-tx';

// Re-export `FailureStage` so external consumers (Phase 3 contract +
// integration tests + the route handler) keep their existing import
// path. Type-only export — no runtime cost.
export type { FailureStage } from './_helpers/process-attendee-in-tx';

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
 * Tx-scoped ports — the deps factory binds Drizzle adapters to a
 * specific transaction handle and yields this bundle to the use-case
 * inside `runInTenantTx`. Extends `ProcessAttendeeInTxPorts` with the
 * webhook-only `idempotencyStore` (the CSV importer manages its own
 * row-hash idempotency via the same store but exposes it differently).
 */
export interface TxScopedPorts extends ProcessAttendeeInTxPorts {
  readonly idempotencyStore: IdempotencyStore;
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
// Constants
// ---------------------------------------------------------------------------

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
      const { idempotencyStore, audit } = ports;

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

      // 2-7. Delegate attendee processing to the shared helper. The
      // helper sets fine-grained `TxStageError(stage, ...)` on each
      // Result.err path; the catch block reads the stage from the
      // error so the `webhook_rolled_back` payload still surfaces the
      // precise failure point. We also pass an `onStageChange`
      // callback so plain-Error rejections (e.g. mock-injected
      // failures in T040 integration test) thread the stage back to
      // this closure's `failureStage` variable — preserving the
      // pre-refactor behaviour where a plain throw past the
      // Result-check still reports the correct stage.
      const tenantIdBranded = asTenantId(input.tenantId);
      const result = await processAttendeeInTx(
        {
          tenantId: tenantIdBranded,
          actorContext: {
            actorType: 'zapier_webhook',
            actorUserId: null,
          },
          onStageChange: (s) => {
            failureStage = s;
          },
          event: {
            externalId: parsed.data.event.externalId,
            name: parsed.data.event.name,
            description: parsed.data.event.description ?? null,
            startDate: new Date(parsed.data.event.startDate),
            endDate: parsed.data.event.endDate
              ? new Date(parsed.data.event.endDate)
              : null,
            location: parsed.data.event.location ?? null,
            category: parsed.data.event.category ?? null,
            eventcreateUrl: parsed.data.event.eventCreateUrl ?? null,
            metadata: extractMetadata(parsed.data.event, EVENT_CANONICAL_KEYS),
          },
          attendee: {
            externalId: parsed.data.attendee.externalId,
            email: parsed.data.attendee.email,
            fullName: parsed.data.attendee.fullName,
            companyName: parsed.data.attendee.companyName ?? null,
            ticketType: parsed.data.attendee.ticketType ?? null,
            ticketPricePaid: parsed.data.attendee.ticketPricePaid ?? null,
            paymentStatus: parsed.data.attendee.paymentStatus,
            registeredAt: new Date(parsed.data.attendee.registeredAt),
            metadata: extractMetadata(parsed.data.attendee, ATTENDEE_CANONICAL_KEYS),
            // TYPE-D2 (Round 1 F6.1): webhook ingest does not capture
            // PDPA consent upstream — pass null explicitly for tri-state.
            pdpaConsentAcknowledged: null,
          },
        },
        ports,
      );

      // 8. Emit webhook-specific success audit (the helper already
      // emitted the match-resolution audit; the helper does NOT emit
      // `webhook_receipt_verified` because that's a webhook-only
      // verb-level success marker).
      failureStage = 'audit_emit';
      const ingestLatencyMs = Date.now() - startedAtMs;
      await emitOrThrow(audit, {
        eventType: 'webhook_receipt_verified',
        tenantId: tenantIdBranded,
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
          processingOutcome: MATCH_TYPE_TO_PROCESSING_OUTCOME[result.matchType],
          matchedMemberId: result.matchedMemberId,
          registrationId: result.registrationId,
          eventCreated: result.eventCreated,
          ingestLatencyMs,
          graceSecretUsed: input.graceSecretUsed ?? false,
        },
      });

      return ok({
        matched: result.matchType,
        matchedMemberId: result.matchedMemberId,
        eventCreated: result.eventCreated,
        registrationId: result.registrationId,
        quotaEffect: result.quotaEffect,
        ingestLatencyMs,
      });
    });
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    const stage: FailureStage = e instanceof TxStageError ? e.stage : failureStage;
    // R6-W2 staff-review fix (2026-05-13): scrub Vercel container
    // paths + macOS /private/* + node_modules + webpack-internal:///
    // from the stack BEFORE persisting to the 5-year audit row. The
    // pre-redaction stack is never written anywhere — only the
    // sanitised version reaches `audit_log.payload.errorStack`.
    const rawStack = e instanceof Error && e.stack ? e.stack : null;
    const errorStack = rawStack === null ? null : (redactStack(rawStack) ?? null);

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
