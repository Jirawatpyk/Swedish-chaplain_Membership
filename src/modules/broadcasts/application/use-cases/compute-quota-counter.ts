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
import { logger } from '@/lib/logger';
import { Instant, LocalDateTime, ZonedDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import {
  getTenantTimezone,
  hasExplicitTenantTimezone,
  type IanaTimezone,
  type TenantContext,
} from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import {
  asQuotaCounter,
  zeroQuota,
  type QuotaCounter,
  type QuotaCounterError,
} from '../../domain/value-objects/quota-counter';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

/**
 * Calendar year in tenant timezone (FR-006/FR-007).
 *
 * Threads `tenantTz` through so quota-year math agrees with
 * `nextResetAtFor` at the year boundary for any tenant timezone.
 * `tenantTz` defaults to `Asia/Bangkok` for backwards compat with
 * existing callers/tests that pass only `now` (e.g. F7 unit tests
 * that don't have a tenant context handy).
 */
export function currentQuotaYear(
  now: Date,
  tenantTz: IanaTimezone | string = 'Asia/Bangkok',
): number {
  return ZonedDateTime.ofInstant(
    Instant.ofEpochMilli(now.getTime()),
    ZoneId.of(tenantTz),
  ).year();
}

/**
 * Start of next quota year expressed as UTC ISO 8601 (T127 contract field
 * `nextResetAt`). Quota year is the calendar year in `tenantTz`; the
 * reset boundary is `(quotaYear + 1)-01-01T00:00:00 [tenantTz]` projected
 * to UTC. Exported so the presentation helper can re-export it instead
 * of duplicating the js-joda math (single source of truth for the AS1
 * "Next reset 1 January YYYY" microcopy + the API contract field).
 */
export function nextResetAtFor(quotaYear: number, tenantTz: IanaTimezone | string): string {
  const zone = ZoneId.of(tenantTz);
  const localMidnight = LocalDateTime.of(quotaYear + 1, 1, 1, 0, 0, 0);
  const instant = localMidnight.atZone(zone).toInstant();
  return new Date(instant.toEpochMilli()).toISOString();
}

export type ComputeQuotaError =
  | { readonly kind: 'quota.member_not_found'; readonly memberId: MemberId }
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
  readonly memberId: MemberId;
}

export interface ComputeQuotaOutput {
  readonly counter: QuotaCounter;
  readonly quotaYear: number;
  readonly planCode: string;
  readonly planId: string;
  /** Start of next quota year in tenant tz, projected to UTC ISO 8601.
   *  Drives the benefits-page "Next reset 1 January 2027" microcopy
   *  (US3 AS1) and the contract field `nextResetAt` per
   *  contracts/broadcasts-api.md § 1.7. */
  readonly nextResetAt: string;
  /** IANA timezone identifier — drives the contract field
   *  `tenantTimezone` and lets the client format relative dates without
   *  guessing the tenant's locale. Branded type guarantees the value
   *  has been validated against the IANA tz registry. */
  readonly tenantTimezone: IanaTimezone;
}

export async function computeQuotaCounter(
  deps: ComputeQuotaDeps,
  input: ComputeQuotaInput,
): Promise<Result<ComputeQuotaOutput, ComputeQuotaError>> {
  const planLookup = await deps.plansBridge.getPlanForMember(
    deps.tenant,
    input.memberId,
  );

  // Early-return for member-not-found WITHOUT computing tenant-tz /
  // quota-year — neither value is needed on this path.
  if (!planLookup.ok && planLookup.error.kind === 'plan_lookup.member_not_found') {
    return err({
      kind: 'quota.member_not_found',
      memberId: input.memberId,
    });
  }

  // All remaining paths return ok and need the reset trio. Compute
  // once here so the F12 fallback warn fires on every path that
  // could be misconfigured.
  const tenantTimezone = getTenantTimezone(deps.tenant.slug);
  if (!hasExplicitTenantTimezone(deps.tenant.slug)) {
    logger.warn(
      { tenantSlug: deps.tenant.slug, fallback: tenantTimezone },
      'tenants.timezone.unknown_slug_fallback',
    );
  }
  const quotaYear = currentQuotaYear(deps.clock.now(), tenantTimezone);
  const reset = {
    quotaYear,
    nextResetAt: nextResetAtFor(quotaYear, tenantTimezone),
    tenantTimezone,
  } as const;

  if (!planLookup.ok) {
    // Member exists but plan-lookup non-fatal error — surface a zero
    // counter so the benefits page renders "0 of 0 remaining".
    return ok({ counter: zeroQuota(0), planCode: '', planId: '', ...reset });
  }

  const { planCode, planId, eblastPerYear: cap } = planLookup.value;
  if (cap === 0) {
    return ok({ counter: zeroQuota(0), planCode, planId, ...reset });
  }

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

  return ok({ counter: built.value, planCode, planId, ...reset });
}
