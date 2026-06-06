/**
 * 057 portal redesign §4.1 — pure dashboard stat derivations.
 *
 * Framework-free (Constitution Principle III: presentation-pure helpers stay
 * dependency-light). Turns the existing F4/F8/F9 read outputs into plain,
 * serialisable view-models the dashboard sections render. No async, no DB,
 * no React — fully unit-testable.
 *
 * The 30-day "renew due" threshold is the single source consumed by BOTH the
 * Membership stat card AND the Quick-actions Renew CTA (spec §4.1: "same
 * threshold as the Membership card; hide/disable when not due").
 */
import {
  daysUntilExpiry,
  isOverdue,
  isTerminalCycleStatus,
  type RenewalCycle,
} from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';

/** Visual emphasis for a stat chip — never colour-alone (a text label always pairs it). */
export type StatVariant = 'neutral' | 'warning' | 'destructive';

/** Days-to-expiry at/under which the Renew CTA + Membership "due" variant fire. */
export const RENEW_DUE_THRESHOLD_DAYS = 30;

export interface MembershipStat {
  /** `empty` = first-run (no cycle); `active` = far off; `due`/`overdue` = act. */
  readonly kind: 'empty' | 'active' | 'due' | 'overdue';
  readonly variant: StatVariant;
  /** Days to expiry (negative = overdue), or null when no cycle / malformed. */
  readonly daysRemaining: number | null;
  /** Cycle status passed through for the card sub-line, or null. */
  readonly status: RenewalCycle['status'] | null;
  readonly expiryIso: string | null;
}

export function deriveMembershipStat(
  cycle: RenewalCycle | null,
  now: Date,
): MembershipStat {
  if (cycle === null) {
    return { kind: 'empty', variant: 'neutral', daysRemaining: null, status: null, expiryIso: null };
  }
  const raw = daysUntilExpiry(cycle, now);
  const days = Number.isFinite(raw) ? raw : null;
  const status = cycle.status;
  if (isOverdue(cycle, now)) {
    return { kind: 'overdue', variant: 'destructive', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  if (days !== null && days <= RENEW_DUE_THRESHOLD_DAYS && !isTerminalCycleStatus(status)) {
    return { kind: 'due', variant: 'warning', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  // Far off OR terminal-but-not-overdue → show membership status, not a stale countdown.
  return { kind: 'active', variant: 'neutral', daysRemaining: days, status, expiryIso: cycle.expiresAt };
}

/** True when the Renew CTA should show (same window as the Membership "due"/"overdue"). */
export function isRenewDue(cycle: RenewalCycle | null, now: Date): boolean {
  if (cycle === null) return false;
  if (isOverdue(cycle, now)) return true;
  if (isTerminalCycleStatus(cycle.status)) return false;
  const raw = daysUntilExpiry(cycle, now);
  return Number.isFinite(raw) && raw <= RENEW_DUE_THRESHOLD_DAYS;
}

/** The minimal invoice shape the outstanding stat needs (decoupled from the F4 domain row). */
export interface OutstandingInvoiceInput {
  readonly status: string;
  /** Invoice total in satang, or null for drafts (excluded anyway). */
  readonly totalSatang: bigint | null;
  /** ISO YYYY-MM-DD due date, or null. */
  readonly dueDate: string | null;
}

export interface OutstandingStat {
  readonly kind: 'owing' | 'clear';
  readonly totalSatang: bigint;
  readonly count: number;
  /** Earliest due date among owed invoices (lexicographic on YYYY-MM-DD), or null. */
  readonly earliestDueDate: string | null;
}

/** Statuses that represent an unpaid balance the member can pay online. */
const OWED_STATUSES = new Set(['issued']);

export function deriveOutstandingStat(
  invoices: readonly OutstandingInvoiceInput[],
): OutstandingStat {
  let totalSatang = 0n;
  let count = 0;
  let earliestDueDate: string | null = null;
  for (const inv of invoices) {
    if (!OWED_STATUSES.has(inv.status) || inv.totalSatang === null) continue;
    totalSatang += inv.totalSatang;
    count += 1;
    if (inv.dueDate !== null && (earliestDueDate === null || inv.dueDate < earliestDueDate)) {
      earliestDueDate = inv.dueDate;
    }
  }
  return {
    kind: count > 0 ? 'owing' : 'clear',
    totalSatang,
    count,
    earliestDueDate,
  };
}

/** Percentage-point gap at/above which a SINGLE benefit counts as under-used (mirrors FR-021). */
export const PER_BENEFIT_UNDER_USE_GAP_PCT = 25;

export interface BenefitsStat {
  /** `empty` = first-run (no benefits); `under-use` = ≥1 lagging; `on-track` otherwise. */
  readonly kind: 'empty' | 'under-use' | 'on-track';
  readonly variant: StatVariant;
  readonly underUseCount: number;
}

/**
 * Under-use HIGHLIGHT (spec §4.1 + review S-1) — a COUNT of benefits lagging
 * the elapsed year, NOT the aggregate %. A benefit is under-used when its
 * (used ÷ entitlement) %-point gap below the elapsed-year % is ≥ 25 (same
 * threshold the F9 aggregate uses). Active-only plans (no quantifiable
 * benefit) are always "on-track".
 */
export function deriveBenefitsStat(usage: BenefitUsage): BenefitsStat {
  const hasContent = usage.quantifiable.length > 0 || usage.active.length > 0;
  if (!hasContent) {
    return { kind: 'empty', variant: 'neutral', underUseCount: 0 };
  }
  let underUseCount = 0;
  for (const b of usage.quantifiable) {
    if (b.entitlement <= 0) continue;
    const consumedPct = (b.used / b.entitlement) * 100;
    if (usage.elapsedYearPct - consumedPct >= PER_BENEFIT_UNDER_USE_GAP_PCT) {
      underUseCount += 1;
    }
  }
  return underUseCount > 0
    ? { kind: 'under-use', variant: 'warning', underUseCount }
    : { kind: 'on-track', variant: 'neutral', underUseCount: 0 };
}
