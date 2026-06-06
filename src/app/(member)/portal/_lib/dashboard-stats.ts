/**
 * 057 portal redesign §4.1 — pure dashboard stat derivations.
 *
 * Framework-free (Constitution Principle III: presentation-pure helpers stay
 * dependency-light). Turns the existing F4/F8/F9 read outputs into plain,
 * serialisable view-models the dashboard sections render. No async, no DB,
 * no React — fully unit-testable.
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

export interface MembershipStat {
  /**
   * `empty` = first-run (no cycle); `active` = far off / still-covered;
   * `due`/`overdue` = act on a non-terminal cycle; `lapsed` = terminal
   * (completed/lapsed/cancelled) AND coverage has ended → must renew;
   * `error` = the renewal read failed (transient) — distinct from `empty`
   * so a DB-throw is never shown as the "Welcome aboard" first-run state.
   */
  readonly kind: 'empty' | 'active' | 'due' | 'overdue' | 'lapsed' | 'error';
  readonly variant: StatVariant;
  /** Days to expiry (negative = overdue), or null when no cycle / malformed / error. */
  readonly daysRemaining: number | null;
  /** Cycle status passed through for the card sub-line, or null. */
  readonly status: RenewalCycle['status'] | null;
  readonly expiryIso: string | null;
}

/**
 * Sentinel the read layer passes when the underlying renewal read FAILED
 * (Result `!ok`) — as opposed to `null`, which means a genuine no-cycle
 * (first-run) member. Keeping the two distinct stops a transient DB-throw
 * from masquerading as "Welcome aboard" and hiding an overdue signal (F4).
 */
export type RenewalCycleReadInput = RenewalCycle | null | 'error';

export function deriveMembershipStat(
  cycle: RenewalCycleReadInput,
  now: Date,
): MembershipStat {
  if (cycle === 'error') {
    return { kind: 'error', variant: 'warning', daysRemaining: null, status: null, expiryIso: null };
  }
  if (cycle === null) {
    return { kind: 'empty', variant: 'neutral', daysRemaining: null, status: null, expiryIso: null };
  }
  const raw = daysUntilExpiry(cycle, now);
  const days = Number.isFinite(raw) ? raw : null;
  const status = cycle.status;
  if (isOverdue(cycle, now)) {
    return { kind: 'overdue', variant: 'destructive', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  // F11 — a TERMINAL cycle (completed/lapsed/cancelled) whose expiry is in
  // the past has no live coverage. `isOverdue` returns false for terminal
  // statuses and the `due` branch excludes them, so previously these fell
  // through to `active` and rendered "Active — in good standing", which
  // MISINFORMS. Surface a destructive "membership lapsed / renew" instead.
  // (A terminal cycle still within its period — expiry in the future —
  // stays `active`: the member is paid up and covered.)
  if (isTerminalCycleStatus(status) && days !== null && days < 0) {
    return { kind: 'lapsed', variant: 'destructive', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  if (days !== null && days <= 30 && !isTerminalCycleStatus(status)) {
    return { kind: 'due', variant: 'warning', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  // Far off OR terminal-but-still-covered → show membership status, not a stale countdown.
  return { kind: 'active', variant: 'neutral', daysRemaining: days, status, expiryIso: cycle.expiresAt };
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
  /**
   * `clear` = nothing owed; `due` = owing but none past-due (net-N window,
   * warning/neutral — NOT alarming); `overdue` = ≥1 issued invoice past its
   * due date (destructive). Splitting `due` vs `overdue` stops the stat from
   * shouting red during the normal payment window (F5).
   */
  readonly kind: 'clear' | 'due' | 'overdue';
  readonly totalSatang: bigint;
  readonly count: number;
  /** Subset of `count`/`totalSatang` that is strictly past due. */
  readonly overdueCount: number;
  readonly overdueSatang: bigint;
  /** Earliest due date among owed invoices (lexicographic on YYYY-MM-DD), or null. */
  readonly earliestDueDate: string | null;
}

/** Statuses that represent an unpaid balance the member can pay online. */
const OWED_STATUSES = new Set(['issued']);

/**
 * Derive the outstanding-balance stat.
 *
 * @param invoices the member's issued (owed) invoices, decoupled shape.
 * @param todayBkk Bangkok-local "today" as YYYY-MM-DD. An issued invoice is
 *   overdue when its `dueDate` is STRICTLY before today (same rule as the F4
 *   `computeIsOverdue` derivation — `dueDate === today` is still within the
 *   member's Bangkok business day to pay). Null `dueDate` → never overdue.
 */
export function deriveOutstandingStat(
  invoices: readonly OutstandingInvoiceInput[],
  todayBkk: string,
): OutstandingStat {
  let totalSatang = 0n;
  let count = 0;
  let overdueSatang = 0n;
  let overdueCount = 0;
  let earliestDueDate: string | null = null;
  for (const inv of invoices) {
    if (!OWED_STATUSES.has(inv.status) || inv.totalSatang === null) continue;
    totalSatang += inv.totalSatang;
    count += 1;
    if (inv.dueDate !== null && (earliestDueDate === null || inv.dueDate < earliestDueDate)) {
      earliestDueDate = inv.dueDate;
    }
    // YYYY-MM-DD strings compare lexicographically == chronologically.
    if (inv.dueDate !== null && todayBkk > inv.dueDate) {
      overdueSatang += inv.totalSatang;
      overdueCount += 1;
    }
  }
  const kind: OutstandingStat['kind'] =
    count === 0 ? 'clear' : overdueCount > 0 ? 'overdue' : 'due';
  return { kind, totalSatang, count, overdueCount, overdueSatang, earliestDueDate };
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
