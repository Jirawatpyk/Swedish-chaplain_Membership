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

export interface DashboardSnapshot {
  readonly counts: MembershipCounts;
  /** Year-to-date PAID revenue in satang, serialized as a decimal string. */
  readonly ytdPaidRevenueSatang: string;
  /** Count of members with ≥1 quantifiable benefit under-delivered (FR-001). */
  readonly underDeliveredBenefitCount: number;
  readonly needsAttention: NeedsAttention;
  /** Starter insight set, already filtered of dismissals (FR-004). */
  readonly topInsights: readonly SmartInsight[];
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
    topInsights: [],
    computedAt,
  };
}
