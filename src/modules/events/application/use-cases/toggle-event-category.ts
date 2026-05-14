/**
 * T087 — `toggleEventCategory` use-case (F6 Phase 6).
 *
 * Admin action that flips an event's `is_partner_benefit` or
 * `is_cultural_event` flag (FR-019) and re-evaluates EVERY matched
 * paid registration's quota effect under per-(tenant, member, event)
 * advisory locks — all in ONE database transaction so a partial
 * re-evaluation cannot leave drift across rows.
 *
 * Algorithm (one tx; per research.md R5 ordering):
 *
 *   1. Load the event via `eventsRepo.findById` — return `not_found`
 *      if missing; `event_archived` if `archivedAt !== null`
 *      (archived events are quota-neutral and cannot be re-flagged).
 *   2. If the requested newValue equals the current flag value → no-op
 *      `ok({ registrationsReevaluated: 0 })`. No audit emitted (no
 *      state change to record).
 *   3. UPDATE the event flag via `eventsRepo.setPartnerBenefit` /
 *      `setCulturalEvent`.
 *   4. SELECT every matched paid non-pseudonymised registration for
 *      this event, ORDER BY matched_member_id ASC (deadlock-safe
 *      advisory-lock acquisition order).
 *   5. For each registration:
 *        a. Acquire the per-(tenant, member, event) advisory lock —
 *           same namespace `eventcreate-quota:...` as `apply-quota-effect`
 *           so a concurrent ingest on the same key blocks until this
 *           re-evaluation commits.
 *        b. Recompute consumed via `quotaAccountingPort.queryAllotments`
 *           — the current row's flag is whatever was committed before
 *           this tx began.
 *        c. Decide the new flag for the relevant scope based on the
 *           updated event flag AND room (consumed < allotment).
 *        d. If the decided flag differs from the current row's flag,
 *           UPDATE via `registrationsRepo.setQuotaEffect` AND emit the
 *           corresponding audit (`quota_*_decremented` /
 *           `quota_over_quota_warning` for false→true,
 *           `quota_credit_back_archive` for true→false).
 *   6. Emit the macro `event_partner_benefit_toggled` /
 *      `event_cultural_event_toggled` audit with
 *      `registrationsReevaluated` = the count of rows that actually
 *      changed (NOT the total iterated count — re-evaluating a row
 *      whose new flag matches its old flag is a no-op).
 *
 * Quota-side audit policy:
 *   - When toggling OFF and a row's flag flips true→false, we emit
 *     `quota_credit_back_archive` with the appropriate scope. The
 *     name `_archive` is used because the F6 audit taxonomy reserves
 *     no separate `_category_toggle` variant (research.md does not
 *     enumerate one); `_archive` is semantically the closest sibling
 *     ("chamber decided this registration no longer counts").
 *   - When toggling ON and a row's flag flips false→true with room,
 *     emit `quota_partnership_decremented` / `quota_cultural_decremented`
 *     using the standard before/after counters.
 *   - When toggling ON but no room remains, emit
 *     `quota_over_quota_warning`.
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (route handler) owns the tx via `runInTenantTx`.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { EventId } from '../../domain/branded-types';
import type { EventAggregate } from '../../domain/event';
import type { QuotaEffect } from '../../domain/event-registration';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
} from '../ports/quota-accounting-port';
import type { F6AuditPort, AuditEmitError } from '../ports/audit-port';
import type {
  AdvisoryLockAcquirer,
  InvalidLockKeyError,
} from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
  quotaAccountingErrorMessage,
} from './_helpers/repo-error-message';
import { emitQuotaScopeAudit } from './_helpers/emit-quota-scope-audit';
import {
  wrapAuditEmitFailure,
  wrapLockFailure,
} from './_helpers/error-wrappers';

export type ToggleFlag = 'is_partner_benefit' | 'is_cultural_event';

export interface ToggleEventCategoryInput {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly flag: ToggleFlag;
  readonly newValue: boolean;
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
}

export interface ToggleEventCategoryOutput {
  readonly event: EventAggregate;
  readonly registrationsReevaluated: number;
  readonly previousValue: boolean;
  /**
   * The event flag's value AFTER the toggle. For a no-op call where
   * `previousValue === newValue`, this equals `previousValue` and
   * `registrationsReevaluated === 0`.
   */
  readonly nextValue: boolean;
}

/**
 * **IMP-5 wave-5 batch-3 + R2-TYPE-B + R3-CRIT-2 + R3-IMP-5 (round-12)** —
 * every variant carries a `cause` discriminator where applicable so route
 * handlers can surface the retry-eligibility context for SRE runbooks.
 *
 * `events_repo_error` and `registrations_repo_error` carry the full
 * underlying discriminated `<Repo>Error` as `cause`, in addition to the
 * pre-formatted `message`. Callers needing retry-vs-no-retry logic can
 * pattern-match on `cause.kind`:
 *   - `db_error` → transient, retry-eligible
 *   - `invariant_violation` → RLS / schema drift, page SREs
 *   - `pseudonymised_row_rejected` → never retry, drop row from set
 *   - `not_implemented` → compile-time-prevented stub callout
 *
 * `lock_acquisition_failed.cause: Error` — transient pg-driver error,
 * SRE retry runbook eligible. Non-Error throws are normalised at the
 * catch site (R3-CRIT-3) so pino's `err`-key serializer always sees
 * a real Error instance.
 *
 * `lock_key_invariant_violation.cause: InvalidLockKeyError` — programmer
 * error / schema drift, page on-call, DO NOT retry. Bucketed separately
 * from `lock_acquisition_failed` (R3-CRIT-2) so SRE retry filters
 * exclude it.
 *
 * `quota_lookup_failed.cause: QuotaAccountingError` — discriminator
 * for `db_error | member_not_found | plan_not_found`.
 *
 * `audit_emit_failed.cause: AuditEmitError` — `db_error |
 * enum_value_unknown` for the inner audit-port failure.
 *
 * Route handlers extract via the pino `err: ... .cause` log key (NOT
 * the legacy `cause:` key — pino auto-serializes `err` into
 * `{type, message, stack}`).
 */
export type ToggleEventCategoryError =
  | { readonly kind: 'event_not_found'; readonly eventId: EventId }
  | { readonly kind: 'event_archived'; readonly eventId: EventId }
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
      /**
       * R7 TEST-FR-05 closure — `message` field added for shape
       * consistency with sibling F6 use-case error variants (archive
       * + apply-quota-effect). Route handlers reading `error.message`
       * for RFC 7807 `detail` rendering now get a meaningful string.
       */
      readonly kind: 'quota_lookup_failed';
      readonly message: string;
      readonly cause: QuotaAccountingError;
    }
  | {
      readonly kind: 'audit_emit_failed';
      readonly message: string;
      readonly cause: AuditEmitError;
    };

export interface ToggleEventCategoryDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly quotaAccountingPort: QuotaAccountingPort;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
  readonly audit: F6AuditPort;
}

export async function toggleEventCategory(
  input: ToggleEventCategoryInput,
  deps: ToggleEventCategoryDeps,
): Promise<Result<ToggleEventCategoryOutput, ToggleEventCategoryError>> {
  // (1) Load event
  const eventLookup = await deps.eventsRepo.findById(input.tenantId, input.eventId);
  if (!eventLookup.ok) {
    return err({
      kind: 'events_repo_error',
      message: eventsRepoErrorMessage(eventLookup.error),
      cause: eventLookup.error,
    });
  }
  const eventBefore = eventLookup.value;
  if (!eventBefore) {
    return err({ kind: 'event_not_found', eventId: input.eventId });
  }
  if (eventBefore.archivedAt !== null) {
    return err({ kind: 'event_archived', eventId: input.eventId });
  }

  const previousValue =
    input.flag === 'is_partner_benefit'
      ? eventBefore.isPartnerBenefit
      : eventBefore.isCulturalEvent;

  // (2) No-op short-circuit
  if (previousValue === input.newValue) {
    return ok({
      event: eventBefore,
      registrationsReevaluated: 0,
      previousValue,
      nextValue: input.newValue,
    });
  }

  // (3) UPDATE the event flag
  const setFlagResult =
    input.flag === 'is_partner_benefit'
      ? await deps.eventsRepo.setPartnerBenefit(
          input.tenantId,
          input.eventId,
          input.newValue,
        )
      : await deps.eventsRepo.setCulturalEvent(
          input.tenantId,
          input.eventId,
          input.newValue,
        );
  if (!setFlagResult.ok) {
    return err({
      kind: 'events_repo_error',
      message: eventsRepoErrorMessage(setFlagResult.error),
      cause: setFlagResult.error,
    });
  }
  const eventAfter = setFlagResult.value;
  const fiscalYear = deriveFiscalYear(eventAfter.startDate.toISOString(), 1);

  // (4) Load all registrations eligible for re-evaluation
  const requotaList = await deps.registrationsRepo.listForRequota(
    input.tenantId,
    input.eventId,
  );
  if (!requotaList.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(requotaList.error),
      cause: requotaList.error,
    });
  }

  // (5) Per-registration re-evaluation
  let registrationsReevaluated = 0;
  for (const reg of requotaList.value) {
    const memberId = reg.match.matchedMemberId;
    // Guard: listForRequota filters NULL matched_member_id, but TS doesn't
    // know that. Defensive skip.
    if (memberId === null) continue;

    // (5a) Advisory lock — same namespace as apply-quota-effect.
    try {
      await deps.advisoryLockAcquirer.acquire(
        buildQuotaLockKey(input.tenantId, memberId, input.eventId),
      );
    } catch (e) {
      return err(wrapLockFailure(e));
    }

    const currentPartnership = reg.quotaEffect.countedAgainstPartnership;
    const currentCultural = reg.quotaEffect.countedAgainstCulturalQuota;

    // (5b+c) Decide new flags based on UPDATED event flags + computed
    // consumption. To avoid double-counting the current row in the SUM
    // query, we offset by the row's current `counted_against_*` value.
    let nextPartnership = currentPartnership;
    let nextCultural = currentCultural;
    let auditOnPartnership: 'decremented' | 'over_quota' | 'credit_back' | null = null;
    let auditOnCultural: 'decremented' | 'over_quota' | 'credit_back' | null = null;
    let allotmentAfterPartnership = 0;
    let allotmentAfterCultural = 0;

    // Partnership scope
    if (input.flag === 'is_partner_benefit') {
      if (eventAfter.isPartnerBenefit) {
        // Toggle ON: re-decide based on room
        const lookup = await deps.quotaAccountingPort.queryAllotments({
          tenantId: input.tenantId,
          memberId,
          eventId: input.eventId,
          fiscalYear,
        });
        if (!lookup.ok) {
          return err({
            kind: 'quota_lookup_failed',
            message: quotaAccountingErrorMessage(lookup.error),
            cause: lookup.error,
          });
        }
        // Subtract the row's own contribution so SUM excludes self
        const consumedExcludingSelf =
          lookup.value.consumed.partnershipConsumedForEvent -
          (currentPartnership ? 1 : 0);
        const room =
          consumedExcludingSelf < lookup.value.allotments.partnershipPerEvent;
        nextPartnership = room;
        if (room && !currentPartnership) {
          auditOnPartnership = 'decremented';
          allotmentAfterPartnership =
            lookup.value.allotments.partnershipPerEvent - consumedExcludingSelf - 1;
        } else if (!room && !currentPartnership) {
          auditOnPartnership = 'over_quota';
        } else if (!room && currentPartnership) {
          // Edge case (IMP-1 wave-5): the allotment shrank since this
          // row was originally counted. We keep `counted_against=true`
          // (toggling ON should never credit-back an already-counted
          // row) but the member is now ABOVE allotment. Emit
          // `quota_over_quota_warning` so the audit trail documents
          // the silent drift instead of leaving a phantom-consumed
          // slot with no explanation. SC-004 zero-error invariant is
          // preserved (no double-count, no missed decrement) — this
          // event-type is the canonical signal for "registration is
          // over the current allotment ceiling".
          auditOnPartnership = 'over_quota';
          nextPartnership = true; // keep counted, audit the drift
        }
        // If room && currentPartnership: already true, nothing to audit.
      } else {
        // Toggle OFF: every counted row flips to false
        nextPartnership = false;
        if (currentPartnership) {
          auditOnPartnership = 'credit_back';
          // After this credit-back, the partnership consumed count for
          // this (member, event) drops by 1. Recompute allotment-after
          // via lookup to surface in the audit payload.
          const lookup = await deps.quotaAccountingPort.queryAllotments({
            tenantId: input.tenantId,
            memberId,
            eventId: input.eventId,
            fiscalYear,
          });
          if (!lookup.ok) {
            return err({
            kind: 'quota_lookup_failed',
            message: quotaAccountingErrorMessage(lookup.error),
            cause: lookup.error,
          });
          }
          // Consumed BEFORE our credit-back still includes this row.
          // The allotment-after AFTER our credit-back is allotment - (consumed - 1).
          allotmentAfterPartnership =
            lookup.value.allotments.partnershipPerEvent -
            (lookup.value.consumed.partnershipConsumedForEvent - 1);
        }
      }
    }

    // Cultural scope
    if (input.flag === 'is_cultural_event') {
      if (eventAfter.isCulturalEvent) {
        const lookup = await deps.quotaAccountingPort.queryAllotments({
          tenantId: input.tenantId,
          memberId,
          eventId: input.eventId,
          fiscalYear,
        });
        if (!lookup.ok) {
          return err({
            kind: 'quota_lookup_failed',
            message: quotaAccountingErrorMessage(lookup.error),
            cause: lookup.error,
          });
        }
        const consumedExcludingSelf =
          lookup.value.consumed.culturalConsumedForYear -
          (currentCultural ? 1 : 0);
        const room =
          consumedExcludingSelf < lookup.value.allotments.culturalPerYear;
        nextCultural = room;
        if (room && !currentCultural) {
          auditOnCultural = 'decremented';
          allotmentAfterCultural =
            lookup.value.allotments.culturalPerYear - consumedExcludingSelf - 1;
        } else if (!room && currentCultural) {
          // Same edge case as partnership scope (IMP-1 wave-5). Audit
          // the drift, keep row counted.
          auditOnCultural = 'over_quota';
          nextCultural = true;
        } else if (!room && !currentCultural) {
          auditOnCultural = 'over_quota';
        }
      } else {
        nextCultural = false;
        if (currentCultural) {
          auditOnCultural = 'credit_back';
          const lookup = await deps.quotaAccountingPort.queryAllotments({
            tenantId: input.tenantId,
            memberId,
            eventId: input.eventId,
            fiscalYear,
          });
          if (!lookup.ok) {
            return err({
            kind: 'quota_lookup_failed',
            message: quotaAccountingErrorMessage(lookup.error),
            cause: lookup.error,
          });
          }
          allotmentAfterCultural =
            lookup.value.allotments.culturalPerYear -
            (lookup.value.consumed.culturalConsumedForYear - 1);
        }
      }
    }

    // (5d) Persist row UPDATE if anything changed
    const changed =
      nextPartnership !== currentPartnership ||
      nextCultural !== currentCultural;
    if (changed) {
      const nextEffect: QuotaEffect = {
        countedAgainstPartnership: nextPartnership,
        countedAgainstCulturalQuota: nextCultural,
      };
      const upd = await deps.registrationsRepo.setQuotaEffect(
        input.tenantId,
        reg.registrationId,
        nextEffect,
      );
      if (!upd.ok) {
        return err({
          kind: 'registrations_repo_error',
          message: registrationsRepoErrorMessage(upd.error),
          cause: upd.error,
        });
      }
      registrationsReevaluated += 1;
    }

    // (5e) Audit emission — runs REGARDLESS of `changed`.
    //
    // **CRIT-R2-1 fix (wave-6)**: previously the audit emit block was
    // gated behind `if (changed)`. This silently dropped the
    // `quota_over_quota_warning` for the IMP-1 edge case (toggle ON +
    // row already counted + plan allotment shrank → row stays counted,
    // `nextPartnership === currentPartnership`, `changed === false`,
    // no audit fired). The comment claimed "documents the silent
    // drift" but the audit was never emitted — comment + code drift.
    //
    // Hoisting the emit OUT of `if (changed)` ensures the over-quota
    // signal is always recorded in the 5-year audit trail, regardless
    // of whether the row's flag bits flipped. The `decremented` and
    // `credit_back` branches only fire when `changed` is true (their
    // semantic precondition is that the row's flag actually moved),
    // but `over_quota` fires whenever the scope detects drift — even
    // if no UPDATE was needed.
    const baseAudit = {
      tenantId: input.tenantId,
      actorType: 'admin' as const,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
    };

    // REFACTOR H3 — unified per-scope helper. The helper accepts ANY
    // of the 3 actions; we only invoke it when the decision branches
    // assigned a non-null action AND the action's precondition holds.
    if (
      auditOnPartnership !== null &&
      (auditOnPartnership === 'over_quota' || changed)
    ) {
      const emitResult = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'partnership',
        action: auditOnPartnership,
        registrationId: reg.registrationId,
        memberId,
        eventId: input.eventId,
        allotmentAfter: allotmentAfterPartnership,
        fiscalYear,
      });
      if (!emitResult.ok) return err(emitResult.error);
    }
    if (
      auditOnCultural !== null &&
      (auditOnCultural === 'over_quota' || changed)
    ) {
      const emitResult = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'cultural',
        action: auditOnCultural,
        registrationId: reg.registrationId,
        memberId,
        eventId: input.eventId,
        allotmentAfter: allotmentAfterCultural,
        fiscalYear,
      });
      if (!emitResult.ok) return err(emitResult.error);
    }
  }

  // (6) Macro toggle audit
  const macroResult = await deps.audit.emit({
    eventType:
      input.flag === 'is_partner_benefit'
        ? 'event_partner_benefit_toggled'
        : 'event_cultural_event_toggled',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    summary: `event ${input.eventId} ${input.flag} ${previousValue}→${input.newValue} by admin ${input.actorUserId}; ${registrationsReevaluated} registrations re-evaluated`,
    payload:
      input.flag === 'is_partner_benefit'
        ? {
            severity: 'info',
            actorUserId: input.actorUserId,
            eventId: input.eventId,
            flagName: 'is_partner_benefit',
            flagBefore: previousValue,
            flagAfter: input.newValue,
            registrationsReevaluated,
          }
        : {
            severity: 'info',
            actorUserId: input.actorUserId,
            eventId: input.eventId,
            flagName: 'is_cultural_event',
            flagBefore: previousValue,
            flagAfter: input.newValue,
            registrationsReevaluated,
          },
  });
  if (!macroResult.ok) {
    return err(wrapAuditEmitFailure(macroResult.error));
  }

  return ok({
    event: eventAfter,
    registrationsReevaluated,
    previousValue,
    nextValue: input.newValue,
  });
}
