/**
 * F9 US4 `computeBenefitUsage` use-case (T064 / FR-019–FR-023).
 *
 * Builds a member's per-membership-year benefit consumption-vs-entitlement
 * view, live (no cache — it is cheap + always-fresh per member). Composes:
 *   - MemberPlanSource → the member's (planId, planYear) (404 on miss).
 *   - PlanSource       → entitlements + active/unlimited benefits from the
 *                        plan's benefit matrix (null → empty view).
 *   - BroadcastSource  → E-Blasts sent this year + last-sent date (AS-1).
 *   - EventSource      → cultural tickets used this year + last-used date.
 *
 * Membership year = calendar year in the tenant timezone (FR-023). The UTC
 * millisecond bounds of that year are derived here (Application owns tz) and
 * fed to the pure domain `yearElapsedPct`; js-joda handles the tz boundary so
 * a member viewing at 23:00 ICT on 31-Dec sees the *current* year (consistent
 * with F7 `compute-quota-counter`). Prior-year consumption is excluded by the
 * `membershipYear` argument threaded into each consumption read.
 *
 * Application layer: orchestrates Domain + ports; no ORM/HTTP/React imports
 * (Constitution Principle III). js-joda is a pure date library (already used
 * by F4/F7 Application use-cases).
 */
import { Instant, ZoneId, ZonedDateTime } from '@js-joda/core';
import '@js-joda/timezone';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import {
  buildBenefitUsage,
  yearElapsedPct,
  type ActiveBenefit,
  type BenefitUsage,
  type QuantifiableBenefit,
} from '../../domain/benefit-usage';
import { tenantYearBoundsUtcMs } from '../tenant-year';
import type {
  BroadcastConsumptionSource,
  EventConsumptionSource,
  MemberPlanSource,
  PlanSource,
} from '../ports/source-ports';
import type { ClockPort } from '../ports/clock-port';

export interface ComputeBenefitUsageDeps {
  readonly memberPlanSource: MemberPlanSource;
  readonly planSource: PlanSource;
  readonly broadcastSource: Pick<BroadcastConsumptionSource, 'getEblastConsumption'>;
  readonly eventSource: EventConsumptionSource;
  readonly clock: ClockPort;
  readonly tenantTimezone: string;
}

export interface ComputeBenefitUsageInput {
  readonly memberId: string;
}

export type ComputeBenefitUsageError =
  | { readonly code: 'member_not_found' }
  | { readonly code: 'compute_failed'; readonly cause?: unknown };

export async function computeBenefitUsage(
  ctx: TenantContext,
  input: ComputeBenefitUsageInput,
  deps: ComputeBenefitUsageDeps,
): Promise<Result<BenefitUsage, ComputeBenefitUsageError>> {
  try {
    const identity = await deps.memberPlanSource.findPlanIdentity(ctx, input.memberId);
    if (identity === null) {
      return err({ code: 'member_not_found' });
    }
    // `identity.planYear` is the member's plan-record year (the entitlement
    // source); `membershipYear` below is the current tenant-tz calendar year
    // (the consumption window, FR-023). For a current-year plan these coincide;
    // plan-record/calendar-year divergence (anniversary-based plans) is
    // explicitly out of scope for F9 (FR-023 note).

    // Calendar-year bounds in the tenant timezone (FR-023). The same window is
    // used by the event consumption adapter — shared via tenantYearBoundsUtcMs
    // so the two layers cannot drift (review-run I-9).
    const now = deps.clock.now();
    const membershipYear = ZonedDateTime.ofInstant(
      Instant.ofEpochMilli(now.getTime()),
      ZoneId.of(deps.tenantTimezone),
    ).year();
    const { startMs, endMs } = tenantYearBoundsUtcMs(membershipYear, deps.tenantTimezone);
    const elapsedYearPct = yearElapsedPct(now.getTime(), startMs, endMs);

    const entitlements = await deps.planSource.getEntitlements(
      ctx,
      identity.planId,
      identity.planYear,
    );
    const active: ActiveBenefit[] = (entitlements?.activeBenefits ?? []).map(
      (key) => ({ key }),
    );

    // Missing plan/year → empty benefit view. Return BEFORE the consumption
    // reads: a transient fault on a read whose result would be discarded must
    // not turn the documented empty-view path into a 500 (review-run R#6).
    if (entitlements === null) {
      return ok(
        buildBenefitUsage({ membershipYear, elapsedYearPct, quantifiable: [], active }),
      );
    }

    // Fetch consumption only for benefits the plan actually grants
    // (entitlement > 0) — a 0-grant benefit is omitted, and its source is not
    // read at all (no wasted query, no spurious fail-loud surface).
    const [eblast, cultural] = await Promise.all([
      entitlements.eblastPerYear > 0
        ? deps.broadcastSource.getEblastConsumption(ctx, input.memberId, membershipYear)
        : Promise.resolve(null),
      entitlements.culturalTicketsPerYear > 0
        ? deps.eventSource.getCulturalConsumption(ctx, input.memberId, membershipYear)
        : Promise.resolve(null),
    ]);

    const quantifiable: QuantifiableBenefit[] = [];
    if (eblast !== null) {
      quantifiable.push({
        key: 'eblast',
        used: eblast.used,
        entitlement: entitlements.eblastPerYear,
        lastUsedAt: eblast.lastUsedAt,
      });
    }
    if (cultural !== null) {
      quantifiable.push({
        key: 'cultural_tickets',
        used: cultural.used,
        entitlement: entitlements.culturalTicketsPerYear,
        lastUsedAt: cultural.lastUsedAt,
      });
    }

    return ok(
      buildBenefitUsage({ membershipYear, elapsedYearPct, quantifiable, active }),
    );
  } catch (e) {
    // Log `errKind` only — a raw Neon/source error message can carry SQL params
    // / table names (forbidden-fields hygiene). The caller maps compute_failed
    // → 500 without leaking internals.
    logger.error(
      { tenantId: ctx.slug, errKind: errKind(e) },
      'insights.compute_benefit_usage.failed',
    );
    return err({ code: 'compute_failed', cause: e });
  }
}
