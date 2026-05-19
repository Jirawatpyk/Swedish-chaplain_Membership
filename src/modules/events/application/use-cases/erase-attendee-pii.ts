/**
 * F6 Phase 10 Wave 1 — `eraseAttendeePii` use-case (F6 Application).
 *
 * Admin erasure action per FR-032a (PDPA / GDPR Article 17). Atomically:
 *   1. Loads the registration via `registrationsRepo.findById` →
 *      `registration_not_found` short-circuits with idempotent fallback
 *      (check `auditPort.findPriorErasureCompletion` — if a prior
 *      `pii_erasure_completed` row exists for this registrationId,
 *      return `Result.ok({alreadyErased: true})` instead of an error;
 *      retains the no-fork-bomb retry semantic of FR-032a).
 *   2. Validates the path `eventId` matches the registration's actual
 *      eventId — returns `event_path_mismatch` BEFORE any mutation
 *      (mirrors Round-2 relink-registration R-CRIT post-load guard so a
 *      route handler that received a forged path can't trigger a
 *      mid-tx commit then 404 to the admin).
 *   3. Emits the `pii_erasure_requested` audit FIRST so the request is
 *      durably recorded even if the subsequent delete + credit-back
 *      somehow throws. Payload includes the admin-supplied reason
 *      text + the last 4 characters of the attendee email (forensic
 *      correlation without storing the full PII post-erasure).
 *   4. If the row was counted (countedAgainstPartnership OR
 *      countedAgainstCulturalQuota), acquires the per-(tenant, member,
 *      event) advisory lock — same `eventcreate-quota:` namespace the
 *      ingest path uses so a concurrent ingest blocks until this
 *      erasure commits — then emits ONE `quota_credit_back_archive`
 *      audit per previously-true scope. Reuses the `archive` audit
 *      type for "scope flag retracted" semantic (same as the
 *      event-wide archive variant; the macro `pii_erasure_completed`
 *      adjacent in the audit-log provides the cause differentiation).
 *   5. Hard-deletes the registration row via
 *      `registrationsRepo.hardDelete`.
 *   6. Emits the macro `pii_erasure_completed` audit with the
 *      cumulative `quotaReversals.{partnership,cultural}` counts +
 *      the wall-clock seconds between request and completion.
 *
 * Per FR-035 erasure is admin-only (manager + member get 404 at the
 * route boundary). Idempotent on retry (per FR-032a + R-1 retry
 * pattern): if the registration is already gone AND a
 * `pii_erasure_completed` audit exists for this registrationId, the
 * use-case returns `Result.ok({alreadyErased: true, quotaReversals:
 * {partnership: 0, cultural: 0}})` with no new audits emitted.
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (route handler) owns the tx via `runInTenantWithRollbackOnErr`
 * / the `erase-attendee-pii-deps` composition root in
 * `src/lib/events-admin-deps.ts`.
 */
import { ok, err, type Result } from '@/lib/result';
import { safeAuditEmit } from './_helpers/safe-audit-emit';
import type { TenantId } from '@/modules/members';
import type {
  EventId,
  RegistrationId,
} from '../../domain/branded-types';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type { F6AuditPort, AuditEmitError } from '../ports/audit-port';
import type {
  AdvisoryLockAcquirer,
  InvalidLockKeyError,
} from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import {
  registrationsRepoErrorMessage,
} from './_helpers/repo-error-message';
import {
  wrapAuditEmitFailure,
  wrapLockFailure,
} from './_helpers/error-wrappers';

export interface EraseAttendeePiiInput {
  readonly tenantId: TenantId;
  /** Path-param eventId — guarded against the registration's actual eventId. */
  readonly eventId: EventId;
  readonly registrationId: RegistrationId;
  readonly actorUserId: UserId;
  /** Admin-supplied reason text persisted to `pii_erasure_requested` payload. */
  readonly reasonText: string;
  readonly occurredAt: Date;
}

export interface EraseAttendeePiiOutput {
  readonly alreadyErased: boolean;
  readonly quotaReversals: {
    readonly partnership: number;
    readonly cultural: number;
  };
}

export type EraseAttendeePiiError =
  | { readonly kind: 'registration_not_found'; readonly registrationId: RegistrationId }
  | {
      readonly kind: 'event_path_mismatch';
      readonly pathEventId: EventId;
      readonly actualEventId: EventId;
    }
  | {
      readonly kind: 'events_repo_error';
      readonly message: string;
      readonly cause: EventsRepositoryError;
    }
  | {
      readonly kind: 'registrations_repo_error';
      readonly message: string;
      readonly cause: RegistrationsRepositoryError;
    }
  | {
      readonly kind: 'lock_acquisition_failed';
      readonly message: string;
      readonly cause: Error;
    }
  | {
      readonly kind: 'lock_key_invariant_violation';
      readonly message: string;
      readonly cause: InvalidLockKeyError;
    }
  | {
      readonly kind: 'audit_emit_failed';
      readonly message: string;
      readonly cause: AuditEmitError;
    };

export interface EraseAttendeePiiDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
  readonly audit: F6AuditPort;
}

/**
 * Extract the last 4 characters of the attendee email for forensic
 * correlation in the `pii_erasure_requested` audit payload. Per
 * data-model.md FR-032a: the audit row MUST NOT carry the full email
 * post-erasure (would defeat the purpose) — only enough to correlate
 * support tickets / DPO requests with the audit row.
 */
function attendeeEmailLastFour(email: string): string {
  return email.slice(-4);
}

export async function eraseAttendeePii(
  input: EraseAttendeePiiInput,
  deps: EraseAttendeePiiDeps,
): Promise<Result<EraseAttendeePiiOutput, EraseAttendeePiiError>> {
  const requestStartedAt = input.occurredAt.getTime();

  // (1) Load registration. If null → idempotency check via prior audit.
  const regLookup = await deps.registrationsRepo.findById(
    input.tenantId,
    input.registrationId,
  );
  if (!regLookup.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(regLookup.error),
      cause: regLookup.error,
    });
  }
  const registration = regLookup.value;
  if (!registration) {
    // Idempotency probe — if a prior `pii_erasure_completed` audit
    // exists for this registrationId, this is a retry. Return ok.
    const priorErasure = await deps.audit.findPriorErasureCompletion(
      input.tenantId,
      input.registrationId,
    );
    if (!priorErasure.ok) {
      return err(wrapAuditEmitFailure(priorErasure.error));
    }
    if (priorErasure.value) {
      return ok({
        alreadyErased: true,
        quotaReversals: { partnership: 0, cultural: 0 },
      });
    }
    return err({
      kind: 'registration_not_found',
      registrationId: input.registrationId,
    });
  }

  // (2) Path-mismatch guard — registration's eventId MUST match the
  // path's eventId. Returned BEFORE any mutation (mirrors relink R-CRIT
  // post-load guard).
  if (String(registration.eventId) !== String(input.eventId)) {
    return err({
      kind: 'event_path_mismatch',
      pathEventId: input.eventId,
      actualEventId: registration.eventId,
    });
  }

  // (3) Emit `pii_erasure_requested` audit FIRST — request is durably
  // recorded even if the subsequent delete somehow throws.
  const requestedEmit = await safeAuditEmit(deps.audit, {
    eventType: 'pii_erasure_requested',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    summary: `admin erase requested: registration ${input.registrationId}`,
    payload: {
      severity: 'error',
      actorUserId: input.actorUserId,
      registrationId: input.registrationId,
      reasonText: input.reasonText,
      attendeeEmailLastFour: attendeeEmailLastFour(
        String(registration.attendee.email),
      ),
    },
  });
  if (!requestedEmit.ok) {
    return err(wrapAuditEmitFailure(requestedEmit.error));
  }

  // (4) If counted, acquire advisory lock + emit per-scope credit-back
  // audits (reuse `quota_credit_back_archive` event type for the
  // "scope flag retracted" semantic — same as event-wide archive).
  let partnershipReversals = 0;
  let culturalReversals = 0;

  const wasPartnership = registration.quotaEffect.countedAgainstPartnership;
  const wasCultural = registration.quotaEffect.countedAgainstCulturalQuota;
  const memberId = registration.match.matchedMemberId;

  if ((wasPartnership || wasCultural) && memberId !== null) {
    try {
      await deps.advisoryLockAcquirer.acquire(
        buildQuotaLockKey(input.tenantId, memberId, registration.eventId),
      );
    } catch (e) {
      return err(wrapLockFailure(e));
    }

    if (wasPartnership) {
      const r = await safeAuditEmit(deps.audit, {
        eventType: 'quota_credit_back_archive',
        tenantId: input.tenantId,
        actorType: 'admin',
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `partnership credit-back via PII erasure: registration ${input.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: input.registrationId,
          memberId,
          scope: 'partnership',
          allotmentAfter: 0, // see archive-event.ts SUGG-2; for erasure path the cache-lookup is overkill at SweCham scale (1 row at a time)
        },
      });
      if (!r.ok) {
        return err(wrapAuditEmitFailure(r.error));
      }
      partnershipReversals += 1;
    }

    if (wasCultural) {
      const r = await safeAuditEmit(deps.audit, {
        eventType: 'quota_credit_back_archive',
        tenantId: input.tenantId,
        actorType: 'admin',
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `cultural credit-back via PII erasure: registration ${input.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: input.registrationId,
          memberId,
          scope: 'cultural',
          allotmentAfter: 0,
        },
      });
      if (!r.ok) {
        return err(wrapAuditEmitFailure(r.error));
      }
      culturalReversals += 1;
    }
  }

  // (5) Hard-delete the row. Returns the deleted aggregate (or null if
  // RLS hid it — shouldn't happen here because findById already
  // returned a real row above, but the port impl carries the same
  // defensive path).
  const deleteResult = await deps.registrationsRepo.hardDelete(
    input.tenantId,
    input.registrationId,
  );
  if (!deleteResult.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(deleteResult.error),
      cause: deleteResult.error,
    });
  }

  // (6) Macro `pii_erasure_completed` audit.
  // R6.W / Round 5 staff-review R005 closure — capture REAL Date.now()
  // at completion instead of re-reading `input.occurredAt` (the same
  // source as `requestStartedAt`). Without this, `completedWithinSeconds-
  // OfRequest` was always 0, breaking the PDPA §30 / GDPR Art. 17
  // latency-of-erasure metric (SC-012).
  const completedSeconds = Math.max(
    0,
    Math.round((Date.now() - requestStartedAt) / 1000),
  );
  const completedEmit = await safeAuditEmit(deps.audit, {
    eventType: 'pii_erasure_completed',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    summary: `admin erase completed: registration ${input.registrationId}; reversals=p${partnershipReversals}/c${culturalReversals}`,
    payload: {
      severity: 'info',
      actorUserId: input.actorUserId,
      registrationId: input.registrationId,
      quotaReversals: {
        partnership: partnershipReversals,
        cultural: culturalReversals,
      },
      completedWithinSecondsOfRequest: completedSeconds,
    },
  });
  if (!completedEmit.ok) {
    return err(wrapAuditEmitFailure(completedEmit.error));
  }

  return ok({
    alreadyErased: false,
    quotaReversals: {
      partnership: partnershipReversals,
      cultural: culturalReversals,
    },
  });
}
