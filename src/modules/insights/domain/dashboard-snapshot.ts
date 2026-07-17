/**
 * F9 DashboardSnapshot VO (US1 / FR-001/002/004/005 / data-model § 1).
 *
 * The typed, derived projection stored as `dashboard_metrics_cache.metrics`
 * (JSONB). Never authoritative — safe to rebuild from source modules. The
 * activity feed is NOT part of the snapshot (it is a separate LIVE query so a
 * just-occurred event is visible without waiting for the next refresh — FR-003
 * / research R1).
 *
 * Money is carried as a satang STRING (JSONB has no bigint); the presentation
 * layer formats per-locale (THB primary, FR-034). Pure Domain — no framework.
 */
import type { LocaleText } from '@/modules/plans';
import type { SmartInsight } from './smart-insight';

/** Headline membership counts (FR-001). */
export interface MembershipCounts {
  readonly total: number;
  readonly active: number;
  readonly atRisk: number;
  readonly overdue: number;
}

/** "Needs attention" actionable counts (FR-002) — each links to a filtered list. */
export interface NeedsAttention {
  readonly broadcastsAwaitingApproval: number;
  readonly overdueInvoices: number;
  readonly atRiskMembers: number;
}

/** One month of the 12-month revenue trend (FR-001a). `satang` is a decimal string. */
export interface RevenueTrendPoint {
  readonly month: string; // 'YYYY-MM' (tenant tz)
  readonly satang: string;
}

/** One month of the member-growth trend (FR-001a) — cumulative members joined. */
export interface MemberGrowthPoint {
  readonly month: string; // 'YYYY-MM' (tenant tz)
  readonly cumulative: number;
}

/** One slice of the active-membership tier breakdown (067). */
export interface TierDistributionSlice {
  readonly tierKey: string; // plan slug, or 'unassigned'
  /** Plan display name in every stored locale (F2 `plan_name`) — the chart
   * picks the viewer's locale at render, falling back to the always-present
   * `en`. For the `unassigned` bucket this is `{ en: 'unassigned' }`, a
   * sentinel the presentation replaces with a translated label (never shown
   * verbatim). */
  readonly label: LocaleText;
  readonly count: number;
}

/** One bucket of the invoice-status distribution (067). */
export interface InvoiceStatusBucket {
  readonly bucket: 'paid' | 'unpaid' | 'overdue';
  readonly satang: string; // net/outstanding amount, decimal string
  readonly count: number;
}

/** Invoice-status distribution — buckets + drafts, excluded from the buckets themselves (067). */
export interface InvoiceStatusDistribution {
  readonly buckets: readonly InvoiceStatusBucket[];
  readonly draftCount: number;
}

export interface DashboardSnapshot {
  readonly counts: MembershipCounts;
  /** Year-to-date PAID revenue in satang, serialized as a decimal string. */
  readonly ytdPaidRevenueSatang: string;
  /** Count of members with ≥1 quantifiable benefit under-delivered (FR-001). */
  readonly underDeliveredBenefitCount: number;
  readonly needsAttention: NeedsAttention;
  /** 12-month monthly paid-revenue trend, oldest→newest (FR-001a). */
  readonly revenueTrend: readonly RevenueTrendPoint[];
  /** 12-month cumulative member-growth trend, oldest→newest (FR-001a). */
  readonly memberGrowth: readonly MemberGrowthPoint[];
  /** Starter insight set, already filtered of dismissals (FR-004). */
  readonly topInsights: readonly SmartInsight[];
  /** Active-membership breakdown by plan tier (067). */
  readonly tierDistribution: readonly TierDistributionSlice[];
  /** Invoice-status distribution — paid/unpaid/overdue buckets + drafts (067). */
  readonly invoiceStatus: InvoiceStatusDistribution;
  /** "As of" time (FR-005) — ISO 8601 UTC; presentation renders per-locale. */
  readonly computedAt: string;
}

/** Empty snapshot for a fresh/zero-data tenant — friendly empty state (FR-006). */
export function emptySnapshot(computedAt: string): DashboardSnapshot {
  return {
    counts: { total: 0, active: 0, atRisk: 0, overdue: 0 },
    ytdPaidRevenueSatang: '0',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [],
    memberGrowth: [],
    topInsights: [],
    tierDistribution: [],
    invoiceStatus: { buckets: [], draftCount: 0 },
    computedAt,
  };
}
