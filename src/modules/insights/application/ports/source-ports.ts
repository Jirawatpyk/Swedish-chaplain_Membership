/**
 * F9 source-reader ports (T016).
 *
 * The read contracts the `insights` module needs from the 5 source modules.
 * Each is implemented (T017, wired at US1/US4) by an adapter that calls the
 * respective module's PUBLIC BARREL — never a deep/foreign-table import
 * (Constitution Principle III). These ports are the F9-owned "what we need"
 * contract; the adapter maps them onto "what the barrel provides".
 *
 * Pure interfaces — no framework/ORM imports. `ctx: TenantContext` (the
 * Domain-only branded tenant type) scopes every read; the adapter threads it
 * into the source barrel's call convention. All reads are tenant-bound.
 *
 * Barrel-backing (how each port is implemented in infrastructure/sources/*):
 *   - MemberSource / MemberPlanSource → members barrel
 *     (`directorySearchWithCount`, `drizzleMemberRepo.findById`).
 *   - PlanSource         → F2 `planRepo.findOne` (returns `benefit_matrix`).
 *   - BroadcastConsumptionSource → broadcasts barrel `makeBroadcastApprovalCounter`
 *     (awaiting count) + `computeQuotaCounter` (E-Blast used/cap).
 *   - EventConsumptionSource → events barrel `getEventAttendeesByMember`
 *     (cultural filtered + year-scoped locally).
 *   - InvoiceSource      → invoicing barrel (YTD/overdue/monthly revenue reads).
 *
 * Method set is grounded in spec FR-001/002/019/021 + data-model R1/R2.
 */
import type { TenantContext } from '@/modules/tenants';
import type { RiskBand } from '../../domain/engagement-score';

/** Membership counts by lifecycle status for the dashboard headline (FR-001). */
export interface MemberStatusCounts {
  readonly active: number;
  readonly inactive: number;
  readonly archived: number;
}

/** A member surfaced by the at-risk insight / dashboard (FR-002/004). */
export interface AtRiskMemberRef {
  readonly memberId: string;
  readonly companyName: string;
  /** The at-risk band (a healthy member is never surfaced here). */
  readonly riskScoreBand: Exclude<RiskBand, 'healthy'>;
}

/**
 * Member-join distribution for the growth trend (FR-001a). `baseline` = members
 * who joined BEFORE the first window month; `byMonth` = join counts keyed by
 * `YYYY-MM` for months inside the window. The caller builds the cumulative
 * series as `baseline + Σ byMonth[≤ month]`.
 */
export interface MemberJoinDistribution {
  readonly baseline: number;
  readonly byMonth: Readonly<Record<string, number>>;
}

export interface MemberSource {
  /** Counts by status for the current tenant (FR-001 headline counts). */
  countByStatus(ctx: TenantContext): Promise<MemberStatusCounts>;
  /** Count of members whose risk band is warning/at-risk/critical (FR-001/002). */
  countAtRisk(ctx: TenantContext): Promise<number>;
  /** Bounded list of at-risk members for the `at_risk_followup` insight (FR-004). */
  listAtRisk(ctx: TenantContext, limit: number): Promise<readonly AtRiskMemberRef[]>;
  /** Member-join distribution for the growth trend (FR-001a), tenant-tz months. */
  joinDistribution(
    ctx: TenantContext,
    monthKeys: readonly string[],
    timeZone: string,
  ): Promise<MemberJoinDistribution>;
}

/**
 * Quantifiable benefit entitlements + the non-quantified active benefits read
 * from a plan's benefit matrix (FR-019/FR-020). `activeBenefits` are stable
 * i18n suffixes (`benefits.active.<key>`) for unlimited/active-only benefits
 * (e.g. `all_employee_event_discount`, `directory_listing`) — they carry no
 * numeric ratio and are excluded from the under-use aggregate.
 */
export interface BenefitEntitlements {
  readonly eblastPerYear: number;
  readonly culturalTicketsPerYear: number;
  readonly activeBenefits: readonly string[];
}

export interface PlanSource {
  /**
   * Entitlements for a member's plan in a given membership year. Returns null
   * when the plan/year is not found (caller renders an empty benefit view).
   */
  getEntitlements(
    ctx: TenantContext,
    planId: string,
    planYear: number,
  ): Promise<BenefitEntitlements | null>;
}

/**
 * A member's plan identity for the current membership year — the (planId,
 * planYear) pair needed to resolve entitlements (FR-019/FR-023). Null when the
 * member does not exist or belongs to another tenant (RLS miss).
 */
export interface MemberPlanIdentity {
  readonly planId: string;
  readonly planYear: number;
}

export interface MemberPlanSource {
  findPlanIdentity(
    ctx: TenantContext,
    memberId: string,
  ): Promise<MemberPlanIdentity | null>;
}

/**
 * A member's consumption of one quantifiable benefit within a membership year:
 * the count used + the most-recent use timestamp (ISO 8601 UTC, or null when
 * unused this year) for the "last used" microcopy (FR-019 / AS-1).
 */
export interface BenefitConsumption {
  readonly used: number;
  readonly lastUsedAt: string | null;
}

export interface BroadcastConsumptionSource {
  /**
   * E-Blasts a member has sent in the membership year + last-sent date
   * (FR-019/AS-1). NOTE: the only implementation derives the count from the F7
   * quota counter, which scopes to the **current** tenant-tz year — it cannot
   * scope to a *past* `membershipYear`. F9 only ever views the current year
   * (FR-023), so this is correct today; a future historical-year view must add
   * a year-scoped count path rather than relying on this method.
   */
  getEblastConsumption(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<BenefitConsumption>;
  /** Count of broadcasts awaiting admin approval for the tenant (FR-002 needs-attention). */
  countAwaitingApproval(ctx: TenantContext): Promise<number>;
}

export interface EventConsumptionSource {
  /** Cultural/event tickets a member consumed in the membership year + last-used date (FR-019). */
  getCulturalConsumption(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<BenefitConsumption>;
}

export interface InvoiceSource {
  /** Year-to-date PAID revenue in satang for the tenant's calendar year (FR-001). */
  getYtdPaidRevenueSatang(ctx: TenantContext, year: number): Promise<bigint>;
  /** Count of overdue invoices for the tenant (FR-002 needs-attention). */
  countOverdue(ctx: TenantContext): Promise<number>;
  /**
   * Monthly PAID revenue (satang) bucketed by the tenant-tz month a paid
   * invoice was settled, for the 12-month revenue trend (FR-001a). Returns a
   * map keyed by `YYYY-MM`; months with no paid invoices are simply absent
   * (the caller fills 0).
   */
  getMonthlyPaidRevenueSatang(
    ctx: TenantContext,
    monthKeys: readonly string[],
    timeZone: string,
  ): Promise<Readonly<Record<string, bigint>>>;
}
