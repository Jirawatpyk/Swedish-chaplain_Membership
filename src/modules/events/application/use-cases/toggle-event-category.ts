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
import type { TenantId, MemberId } from '@/modules/members';
import type { EventId } from '../../domain/branded-types';
import type { EventAggregate } from '../../domain/event';
import type { QuotaEffect } from '../../domain/event-registration';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import type { EventsRepository } from '../ports/events-repository';
import type { RegistrationsRepository } from '../ports/registrations-repository';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
} from '../ports/quota-accounting-port';
import type { F6AuditPort } from '../ports/audit-port';
import type { AdvisoryLockAcquirer } from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
} from './_helpers/repo-error-message';

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

export type ToggleEventCategoryError =
  | { readonly kind: 'event_not_found'; readonly eventId: EventId }
  | { readonly kind: 'event_archived'; readonly eventId: EventId }
  | { readonly kind: 'events_repo_error'; readonly message: string }
  | { readonly kind: 'registrations_repo_error'; readonly message: string }
  | { readonly kind: 'lock_acquisition_failed'; readonly message: string }
  | { readonly kind: 'quota_lookup_failed'; readonly cause: QuotaAccountingError }
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

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
      return err({
        kind: 'lock_acquisition_failed',
        message: (e as Error)?.message ?? 'unknown',
      });
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
          return err({ kind: 'quota_lookup_failed', cause: lookup.error });
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
            return err({ kind: 'quota_lookup_failed', cause: lookup.error });
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
          return err({ kind: 'quota_lookup_failed', cause: lookup.error });
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
            return err({ kind: 'quota_lookup_failed', cause: lookup.error });
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
        });
      }
      registrationsReevaluated += 1;

      // Emit per-scope audits inline so the audit row commits IN the
      // same tx — failure propagates upward and triggers rollback at
      // the route handler (FR-037).
      const baseAudit = {
        tenantId: input.tenantId,
        actorType: 'admin' as const,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
      };

      if (auditOnPartnership === 'decremented') {
        // CRIT-2 fix (wave-5): derive `perEventAllotmentBefore` from
        // `allotmentAfterPartnership + 1` instead of re-querying
        // `queryAllotments` AFTER `setQuotaEffect` already flipped
        // `counted_against_partnership=true`. The post-UPDATE SUM
        // would include this row, producing an off-by-one (low) for
        // `before`. The pre-UPDATE math at the decision branch
        // (`allotmentAfter = allotment - consumedExcludingSelf - 1`)
        // implies `before = allotmentAfter + 1` by construction.
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_partnership_decremented',
          summary: `partnership decremented via toggle: registration ${reg.registrationId} re-flagged after event toggle`,
          payload: {
            severity: 'info',
            registrationId: reg.registrationId,
            memberId,
            eventId: input.eventId,
            perEventAllotmentBefore: allotmentAfterPartnership + 1,
            perEventAllotmentAfter: allotmentAfterPartnership,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      } else if (auditOnPartnership === 'over_quota') {
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_over_quota_warning',
          summary: `partnership over-quota via toggle: registration ${reg.registrationId}`,
          payload: {
            severity: 'warn',
            registrationId: reg.registrationId,
            memberId,
            eventId: input.eventId,
            scope: 'partnership',
            allotmentAtIngest: 0,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      } else if (auditOnPartnership === 'credit_back') {
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_credit_back_archive',
          summary: `partnership credit-back via toggle OFF: registration ${reg.registrationId}`,
          payload: {
            severity: 'info',
            registrationId: reg.registrationId,
            memberId,
            scope: 'partnership',
            allotmentAfter: allotmentAfterPartnership,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      }

      if (auditOnCultural === 'decremented') {
        // CRIT-2 fix (wave-5) — see partnership counterpart above for
        // the off-by-one rationale. Cultural mirror uses the same
        // derivation: `before = allotmentAfter + 1`.
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_cultural_decremented',
          summary: `cultural decremented via toggle: registration ${reg.registrationId}`,
          payload: {
            severity: 'info',
            registrationId: reg.registrationId,
            memberId,
            eventId: input.eventId,
            fiscalYear,
            annualAllotmentBefore: allotmentAfterCultural + 1,
            annualAllotmentAfter: allotmentAfterCultural,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      } else if (auditOnCultural === 'over_quota') {
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_over_quota_warning',
          summary: `cultural over-quota via toggle: registration ${reg.registrationId}`,
          payload: {
            severity: 'warn',
            registrationId: reg.registrationId,
            memberId,
            eventId: input.eventId,
            scope: 'cultural',
            allotmentAtIngest: 0,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      } else if (auditOnCultural === 'credit_back') {
        const r = await deps.audit.emit({
          ...baseAudit,
          eventType: 'quota_credit_back_archive',
          summary: `cultural credit-back via toggle OFF: registration ${reg.registrationId}`,
          payload: {
            severity: 'info',
            registrationId: reg.registrationId,
            memberId,
            scope: 'cultural',
            allotmentAfter: allotmentAfterCultural,
          },
        });
        if (!r.ok) {
          return err({
            kind: 'audit_emit_failed',
            message:
              'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
          });
        }
      }
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
    return err({
      kind: 'audit_emit_failed',
      message:
        'message' in macroResult.error
          ? macroResult.error.message
          : `audit error ${macroResult.error.kind}`,
    });
  }

  return ok({
    event: eventAfter,
    registrationsReevaluated,
    previousValue,
    nextValue: input.newValue,
  });
}

/**
 * Memberid-typed re-export so tests referencing `MemberId` through this
 * module's surface don't need a second import line. (Stylistic — F8 / F5
 * follow the same pattern in their use-case barrels.)
 */
export type { MemberId };
