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
 * Barrel-backing + gaps (per the 2026-05-25 barrel survey — drives T017):
 *   - MemberSource       → members barrel `directorySearchWithCount`
 *     (riskBand/status filters + riskScore/riskScoreBand). countByStatus has
 *     NO direct export → adapter composes (or promote `countMembersByStatus`).
 *   - PlanSource         → plans barrel `getPlan` (returns `benefit_matrix`).
 *   - BroadcastConsumptionSource → broadcasts barrel `computeQuotaCounter`
 *     (returns used/cap). "awaiting approval" count has NO export →
 *     promote `countBroadcastsAwaitingApproval` at US1.
 *   - EventConsumptionSource → events barrel `getEventAttendeesByMember`
 *     (filter cultural locally) or promote a count use-case at US4.
 *   - InvoiceSource      → invoicing barrel `listInvoices` + pure
 *     `deriveOverdue`. YTD-paid-revenue SUM + overdue COUNT have NO export →
 *     promote `getYtdPaidRevenue` / `countOverdueInvoices` at US1.
 *
 * NOTE: method set is grounded in spec FR-001/002/019/021 + data-model R1/R2.
 * US1/US4 may add reads here as `computeDashboardSnapshot` / `computeBenefitUsage`
 * pin their exact needs; that is the intended evolution point for these ports.
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

/** Quantifiable benefit entitlements read from a plan's benefit matrix (FR-019). */
export interface BenefitEntitlements {
  readonly eblastPerYear: number;
  readonly culturalTicketsPerYear: number;
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

export interface BroadcastConsumptionSource {
  /** Count of E-Blasts a member has consumed (sent) in the membership year (FR-019). */
  countEblastConsumed(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<number>;
  /** Count of broadcasts awaiting admin approval for the tenant (FR-002 needs-attention). */
  countAwaitingApproval(ctx: TenantContext): Promise<number>;
}

export interface EventConsumptionSource {
  /** Count of cultural/event tickets a member consumed in the membership year (FR-019). */
  countCulturalTicketsConsumed(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<number>;
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
