/**
 * T085 — `applyQuotaEffect` use-case (F6 Application).
 *
 * The "decide quota counted_against flags" step of the strict-tx ingest
 * pipeline (FR-015 / FR-016 / FR-017 / FR-018). Called from
 * `ingestWebhookAttendee` AFTER the event row is upserted and the
 * attendee is matched, BEFORE the registration row is inserted — the
 * returned `quotaEffect` is spliced into the registration insert by
 * the caller.
 *
 * Algorithm (per research.md R5 canonical order):
 *
 *   1. Short-circuit: if `payment_status === 'refunded'` or BOTH
 *      `is_partner_benefit` and `is_cultural_event` are false, the row
 *      contributes nothing to quota — return `{false, false}` without
 *      acquiring the lock or hitting the plan repo (perf optimisation
 *      + avoids spurious advisory locks on irrelevant ingests).
 *
 *   2. Acquire the per-(tenant, member, event) Postgres advisory lock
 *      (auto-released at tx-end). Disjoint namespace `eventcreate-quota:`
 *      from F4 `invoicing:` / F5 `payments:` / F7 `broadcasts:` /
 *      F8 `renewals:` — zero cross-feature contention. Order: RLS
 *      tenant-binding MUST be set by the caller BEFORE this use-case
 *      runs (per F6 di.ts pattern); the lock acquisition happens
 *      INSIDE the tenant-scoped session.
 *
 *   3. Load plan allotments + currently-consumed counts via the
 *      injected `QuotaAccountingPort`. The port composes F2 plan repo
 *      + F3 member snapshot + F6 registrations count-by-member; this
 *      use-case does not depend on the F2/F3 details.
 *
 *   4. Decide per-scope:
 *      - partnership flag = isPartnerBenefit AND consumed.partnership <
 *        allotments.partnership
 *      - cultural flag    = isCulturalEvent AND consumed.cultural <
 *        allotments.cultural
 *
 *   5. Emit one audit per active scope:
 *      - partnership branch:
 *        - quota_partnership_decremented when room → before/after counts
 *        - quota_over_quota_warning      when full
 *      - cultural branch (mirror)
 *
 *   6. Return the decided flags to the caller (registration insert
 *      happens in the caller's next step).
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (ingest-webhook-attendee) owns the strict-tx + audit wiring.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId, MemberId } from '@/modules/members';
import type {
  EventId,
  RegistrationId,
} from '../../domain/branded-types';
import type { QuotaEffect } from '../../domain/event-registration';
import type { PaymentStatus } from '../../domain/value-objects/payment-status';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
} from '../ports/quota-accounting-port';
import type { F6AuditPort, ActorType } from '../ports/audit-port';
import {
  asLockKey,
  type AdvisoryLockAcquirer,
  type LockKey,
} from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';

export interface ApplyQuotaEffectInput {
  readonly tenantId: TenantId;
  readonly matchedMemberId: MemberId;
  readonly eventId: EventId;
  readonly registrationId: RegistrationId;
  readonly eventFlags: {
    readonly isPartnerBenefit: boolean;
    readonly isCulturalEvent: boolean;
  };
  /**
   * Calendar year of the event's `start_date` in Asia/Bangkok wall
   * time. Derive at the caller via `deriveFiscalYear(event.startDate.toISOString(), 1)`
   * (FR-016 specifies "calendar year of the event start date" — for
   * SweCham fiscal-year-start-month=1, fiscal == calendar).
   */
  readonly fiscalYear: number;
  readonly paymentStatus: PaymentStatus;
  /**
   * Audit envelope inputs. Plumbed by the caller so the emitted
   * `quota_*` rows attribute correctly to the actor (zapier webhook,
   * CSV import, admin toggle/relink, etc.).
   */
  readonly actorType: ActorType;
  readonly actorUserId: UserId | null;
  readonly occurredAt: Date;
}

export interface ApplyQuotaEffectOutput {
  readonly quotaEffect: QuotaEffect;
  /**
   * The full set of audit event types this call emitted IN-TX. Surfaced
   * so the caller / integration tests can introspect what was audited
   * without re-querying the audit_log table.
   */
  readonly emittedAuditEventTypes: ReadonlyArray<
    | 'quota_partnership_decremented'
    | 'quota_cultural_decremented'
    | 'quota_over_quota_warning'
  >;
}

export type ApplyQuotaEffectError =
  | { readonly kind: 'lock_acquisition_failed'; readonly message: string }
  | { readonly kind: 'quota_lookup_failed'; readonly cause: QuotaAccountingError }
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

export interface ApplyQuotaEffectDeps {
  readonly quotaAccountingPort: QuotaAccountingPort;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
  readonly audit: F6AuditPort;
}

/**
 * Tenant-scoped Postgres advisory-lock key per research.md R5. Exported
 * for test introspection (concurrency tests assert lock contention).
 *
 * **I-6 wave-5 batch-3** — returns the branded `LockKey` type so callers
 * cannot accidentally pass an unvalidated string to
 * `AdvisoryLockAcquirer.acquire`. Validation runs through `asLockKey`
 * which rejects typos like `eventcreate_quota:` (underscore) vs the
 * canonical `eventcreate-quota:` (hyphen).
 */
export function buildQuotaLockKey(
  tenantId: TenantId,
  memberId: MemberId,
  eventId: EventId,
): LockKey {
  return asLockKey(`eventcreate-quota:${tenantId}:${memberId}:${eventId}`);
}

/**
 * Neutral quota effect — used by the short-circuit branches and as the
 * canonical default for non-matched / non-quota-relevant ingests.
 */
export const NEUTRAL_QUOTA_EFFECT: QuotaEffect = {
  countedAgainstPartnership: false,
  countedAgainstCulturalQuota: false,
};

export async function applyQuotaEffect(
  input: ApplyQuotaEffectInput,
  deps: ApplyQuotaEffectDeps,
): Promise<Result<ApplyQuotaEffectOutput, ApplyQuotaEffectError>> {
  // (1) Short-circuit refunded / non-benefit ingests BEFORE touching
  // the lock or the plan repo.
  if (input.paymentStatus === 'refunded') {
    return ok({
      quotaEffect: NEUTRAL_QUOTA_EFFECT,
      emittedAuditEventTypes: [],
    });
  }
  if (
    !input.eventFlags.isPartnerBenefit &&
    !input.eventFlags.isCulturalEvent
  ) {
    return ok({
      quotaEffect: NEUTRAL_QUOTA_EFFECT,
      emittedAuditEventTypes: [],
    });
  }

  // (2) Advisory lock — auto-released at tx-end.
  try {
    await deps.advisoryLockAcquirer.acquire(
      buildQuotaLockKey(input.tenantId, input.matchedMemberId, input.eventId),
    );
  } catch (e) {
    return err({
      kind: 'lock_acquisition_failed',
      message: (e as Error)?.message ?? 'unknown',
    });
  }

  // (3) Plan allotments + consumed counts.
  const lookup = await deps.quotaAccountingPort.queryAllotments({
    tenantId: input.tenantId,
    memberId: input.matchedMemberId,
    eventId: input.eventId,
    fiscalYear: input.fiscalYear,
  });
  if (!lookup.ok) {
    return err({ kind: 'quota_lookup_failed', cause: lookup.error });
  }
  const { allotments, consumed } = lookup.value;

  // (4) Decide flags per scope.
  const partnershipRoom =
    input.eventFlags.isPartnerBenefit &&
    consumed.partnershipConsumedForEvent < allotments.partnershipPerEvent;
  const culturalRoom =
    input.eventFlags.isCulturalEvent &&
    consumed.culturalConsumedForYear < allotments.culturalPerYear;

  const quotaEffect: QuotaEffect = {
    countedAgainstPartnership: partnershipRoom,
    countedAgainstCulturalQuota: culturalRoom,
  };

  // (5) Emit audit(s) — one per active scope.
  const emittedAuditEventTypes: Array<
    | 'quota_partnership_decremented'
    | 'quota_cultural_decremented'
    | 'quota_over_quota_warning'
  > = [];

  if (input.eventFlags.isPartnerBenefit) {
    if (partnershipRoom) {
      const before =
        allotments.partnershipPerEvent - consumed.partnershipConsumedForEvent;
      const after = before - 1;
      const r = await deps.audit.emit({
        eventType: 'quota_partnership_decremented',
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `partnership ticket consumed for event ${input.eventId} by member ${input.matchedMemberId}; remaining ${after}/${allotments.partnershipPerEvent}`,
        payload: {
          severity: 'info',
          registrationId: input.registrationId,
          memberId: input.matchedMemberId,
          eventId: input.eventId,
          perEventAllotmentBefore: before,
          perEventAllotmentAfter: after,
        },
      });
      if (!r.ok) {
        return err({
          kind: 'audit_emit_failed',
          message:
            'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
        });
      }
      emittedAuditEventTypes.push('quota_partnership_decremented');
    } else {
      const r = await deps.audit.emit({
        eventType: 'quota_over_quota_warning',
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `partnership over-quota: registration ${input.registrationId} persisted with counted_against_partnership=false (member ${input.matchedMemberId} has used all ${allotments.partnershipPerEvent} tickets for event ${input.eventId})`,
        payload: {
          severity: 'warn',
          registrationId: input.registrationId,
          memberId: input.matchedMemberId,
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
      emittedAuditEventTypes.push('quota_over_quota_warning');
    }
  }

  if (input.eventFlags.isCulturalEvent) {
    if (culturalRoom) {
      const before =
        allotments.culturalPerYear - consumed.culturalConsumedForYear;
      const after = before - 1;
      const r = await deps.audit.emit({
        eventType: 'quota_cultural_decremented',
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `cultural ticket consumed in FY ${input.fiscalYear} for member ${input.matchedMemberId}; remaining ${after}/${allotments.culturalPerYear}`,
        payload: {
          severity: 'info',
          registrationId: input.registrationId,
          memberId: input.matchedMemberId,
          eventId: input.eventId,
          fiscalYear: input.fiscalYear,
          annualAllotmentBefore: before,
          annualAllotmentAfter: after,
        },
      });
      if (!r.ok) {
        return err({
          kind: 'audit_emit_failed',
          message:
            'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
        });
      }
      emittedAuditEventTypes.push('quota_cultural_decremented');
    } else {
      const r = await deps.audit.emit({
        eventType: 'quota_over_quota_warning',
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
        summary: `cultural over-quota: registration ${input.registrationId} persisted with counted_against_cultural_quota=false (member ${input.matchedMemberId} has used all ${allotments.culturalPerYear} tickets in FY ${input.fiscalYear})`,
        payload: {
          severity: 'warn',
          registrationId: input.registrationId,
          memberId: input.matchedMemberId,
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
      emittedAuditEventTypes.push('quota_over_quota_warning');
    }
  }

  return ok({ quotaEffect, emittedAuditEventTypes });
}
