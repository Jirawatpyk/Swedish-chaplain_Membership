/**
 * T067 — `compute-quota-counter.ts` Application use-case (F7).
 *
 * Derives the per-member quota view from:
 *   - F2 plan lookup (cap = `benefit_matrix.eblast_per_year`)
 *   - F7 broadcast counts (`reserved` = submitted/approved; `used` = sent
 *     in current quota year)
 *
 * Quota year is the calendar year in Asia/Bangkok (FR-006/FR-007 — F7
 * does NOT use F4's fiscal year because broadcasts have no statutory
 * tax-document constraint). js-joda handles the timezone boundary so
 * a member submitting at 23:00 ICT on 31-Dec consumes the *current*
 * calendar year's quota (not the next year's UTC slot).
 */
import { ok, err, type Result } from '@/lib/result';
import { Instant, ZonedDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import type { TenantContext } from '@/modules/tenants';
import {
  asQuotaCounter,
  zeroQuota,
  type QuotaCounter,
  type QuotaCounterError,
} from '../../domain/value-objects/quota-counter';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

const ASIA_BANGKOK = ZoneId.of('Asia/Bangkok');

/** Calendar year in Asia/Bangkok timezone (FR-006/FR-007). */
export function currentQuotaYear(now: Date): number {
  return ZonedDateTime.ofInstant(
    Instant.ofEpochMilli(now.getTime()),
    ASIA_BANGKOK,
  ).year();
}

export type ComputeQuotaError =
  | { readonly kind: 'quota.member_not_found'; readonly memberId: string }
  | {
      readonly kind: 'quota.invariant_violation';
      readonly cause: QuotaCounterError;
    };

export interface ComputeQuotaDeps {
  readonly tenant: TenantContext;
  readonly plansBridge: PlansBridgePort;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly clock: { now(): Date };
}

export interface ComputeQuotaInput {
  readonly memberId: string;
}

export interface ComputeQuotaOutput {
  readonly counter: QuotaCounter;
  readonly quotaYear: number;
  readonly planCode: string;
  readonly planId: string;
}

export async function computeQuotaCounter(
  deps: ComputeQuotaDeps,
  input: ComputeQuotaInput,
): Promise<Result<ComputeQuotaOutput, ComputeQuotaError>> {
  const planLookup = await deps.plansBridge.getPlanForMember(
    deps.tenant,
    input.memberId,
  );

  if (!planLookup.ok) {
    if (planLookup.error.kind === 'plan_lookup.member_not_found') {
      return err({
        kind: 'quota.member_not_found',
        memberId: input.memberId,
      });
    }
    // Member exists but plan has 0 entitlement — still surface a counter
    // so the benefits page can render "0 of 0 remaining" rather than
    // crashing. Cap = 0; reserved/used = 0.
    return ok({
      counter: zeroQuota(0),
      quotaYear: currentQuotaYear(deps.clock.now()),
      planCode: '',
      planId: '',
    });
  }

  const cap = planLookup.value.eblastPerYear;
  if (cap === 0) {
    return ok({
      counter: zeroQuota(0),
      quotaYear: currentQuotaYear(deps.clock.now()),
      planCode: planLookup.value.planCode,
      planId: planLookup.value.planId,
    });
  }

  const quotaYear = currentQuotaYear(deps.clock.now());
  const counts = await deps.broadcastsRepo.countForMemberQuota(
    deps.tenant.slug,
    input.memberId,
    quotaYear,
  );

  const built = asQuotaCounter({
    used: counts.sent,
    reserved: counts.submittedOrApproved,
    cap,
  });
  if (!built.ok) {
    return err({ kind: 'quota.invariant_violation', cause: built.error });
  }

  return ok({
    counter: built.value,
    quotaYear,
    planCode: planLookup.value.planCode,
    planId: planLookup.value.planId,
  });
}
