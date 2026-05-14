/**
 * T030 — `QuotaAccountingPort` Application port (F6).
 *
 * Computes the matched member's plan + remaining ticket allotments per
 * FR-015–FR-018 + research.md R5. The Infrastructure adapter
 * (`drizzle-quota-accounting-adapter.ts`, Phase 6 T086) bridges to:
 *   - F2 `getMemberPlanForBucket(memberId)` via `@/modules/plans`
 *     barrel — returns the member's current plan + tier-bucketed
 *     allotments (partnership-per-event tickets + cultural-annual
 *     allotment).
 *   - F6 `event_registrations` SELECT count(*) — computed-on-read
 *     consumption count per data-model.md § 8.
 *
 * Quota usage is NOT stored anywhere; it's computed on every ingest
 * via SUM() over the registration rows' `counted_against_*` flags.
 * Serialised against concurrent races by the advisory lock per
 * research.md R5 — the lock is acquired at the USE-CASE layer
 * (`apply-quota-effect.ts` Phase 6 T085), not inside this port.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId, MemberId } from '@/modules/members';
import type { EventId } from '../../domain/branded-types';

/**
 * Plan-derived allotments for a single (member, event, fiscal-year)
 * tuple. Either field is null when the plan does not grant the
 * corresponding benefit (e.g., a Standard-tier member has no
 * partnership allotment → `partnershipAllotment === 0`).
 */
export interface PlanAllotments {
  /**
   * Partnership-per-event ticket allotment. Decrements per
   * registration on an event flagged `is_partner_benefit=true`.
   */
  readonly partnershipPerEvent: number;
  /**
   * Cultural-event annual allotment for the current fiscal year.
   * Decrements per registration on an event flagged
   * `is_cultural_event=true`. Fiscal year wraps per the tenant
   * timezone (Asia/Bangkok for SweCham — env.tenant.timezone).
   */
  readonly culturalPerYear: number;
  /**
   * Phase 6 staff-review-4 round-6 PERF-05 closure — F2 plan tier
   * slug (e.g., `'diamond'`, `'platinum'`, `'gold'`, `'premium'`,
   * `'large'`, `'small'`) for OTel counter labelling
   * (`eventcreate_quota_*_decremented_total{plan_tier}`). Optional +
   * nullable because legacy data + plans without a recognised tier
   * classifier may return null/undefined — counter falls back to
   * `plan_tier='unknown'` in that case. Derived in the Infrastructure
   * adapter from the `membership_plans.plan_id` value. Optional (not
   * required) so existing test fixtures + future plan loaders without
   * tier metadata typecheck cleanly.
   */
  readonly planTier?: string | null;
}

/**
 * Consumed-quota count for a single (member, event/year) bucket,
 * computed from `event_registrations` flag SUMs.
 */
export interface ConsumedQuota {
  /**
   * Count of registrations counted against the partnership allotment
   * for THIS event (per-event scope).
   */
  readonly partnershipConsumedForEvent: number;
  /**
   * Count of registrations counted against the cultural annual
   * allotment for the fiscal year THIS event falls within
   * (per-year scope).
   */
  readonly culturalConsumedForYear: number;
}

export interface QueryAllotmentsInput {
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly eventId: EventId;
  readonly fiscalYear: number;
}

export type QuotaAccountingError =
  | { readonly kind: 'member_not_found'; readonly memberId: MemberId }
  | { readonly kind: 'plan_not_found'; readonly memberId: MemberId }
  | { readonly kind: 'db_error'; readonly message: string };

export interface QuotaAccountingPort {
  /**
   * Looks up the plan-granted allotments + the currently-consumed count
   * for a (member, event, fiscal-year) bucket. The use-case decides
   * counted_against flags based on (consumed < allotment).
   */
  queryAllotments(
    input: QueryAllotmentsInput,
  ): Promise<
    Result<
      { readonly allotments: PlanAllotments; readonly consumed: ConsumedQuota },
      QuotaAccountingError
    >
  >;
}
