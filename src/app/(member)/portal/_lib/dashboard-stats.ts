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
  deriveMembershipAccess,
  isTerminalCycleStatus,
  type MembershipAccessReason,
  type RenewalCycle,
} from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';

/** Visual emphasis for a stat chip — never colour-alone (a text label always pairs it). */
export type StatVariant = 'neutral' | 'warning' | 'destructive';

export interface MembershipStat {
  /**
   * `empty` = first-run (no cycle); `active` = far off / still-covered / paid
   * up (`completed`); `due` = act soon on a non-terminal, not-yet-invoiced
   * cycle; `suspended` = benefits paused (059-membership-suspension) — an
   * unpaid invoice is outstanding (`reason: 'unpaid'`) or a payment is being
   * verified (`reason: 'pending_review'`); `lapsed` = an ENDED-terminal
   * cycle (`lapsed`/`cancelled`, NOT `completed`) whose coverage has ended →
   * membership itself is terminated; `error` = the renewal read failed
   * (transient) — distinct from `empty` so a DB-throw is never shown as the
   * "Welcome aboard" first-run state.
   *
   * `overdue` is RETAINED on the union for type back-compat with existing
   * consumers (`membership-stat-section.tsx`) but is no longer PRODUCED by
   * `deriveMembershipStat` — the condition it used to capture (a non-
   * terminal cycle past its expiry) is now fully absorbed into `suspended`
   * per the 059 TSCC policy change ("grace no longer retains access").
   */
  readonly kind: 'empty' | 'active' | 'due' | 'overdue' | 'lapsed' | 'suspended' | 'error';
  readonly variant: StatVariant;
  /** Days to expiry (negative = overdue), or null when no cycle / malformed / error. */
  readonly daysRemaining: number | null;
  /** Cycle status passed through for the card sub-line, or null. */
  readonly status: RenewalCycle['status'] | null;
  readonly expiryIso: string | null;
  /**
   * 059-membership-suspension — the `deriveMembershipAccess` sub-reason,
   * load-bearing for `suspended`/`lapsed` copy (distinguishing "unpaid" from
   * "payment received, pending review" from "grace expired" from
   * "cancelled"). `null` for every other kind.
   */
  readonly reason: MembershipAccessReason | null;
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
    return { kind: 'error', variant: 'warning', daysRemaining: null, status: null, expiryIso: null, reason: null };
  }
  if (cycle === null) {
    return { kind: 'empty', variant: 'neutral', daysRemaining: null, status: null, expiryIso: null, reason: null };
  }
  const raw = daysUntilExpiry(cycle, now);
  const days = Number.isFinite(raw) ? raw : null;
  const status = cycle.status;

  // 059-membership-suspension — `deriveMembershipAccess` is now the SINGLE
  // dispatch key (full / suspended / terminated), replacing the old
  // isOverdue → isMembershipLapsed → due-threshold chain. Both `isOverdue`
  // and the old lapsed-producing branch are subsumed here: every case they
  // used to catch is now classified by the Domain predicate FIRST.
  const access = deriveMembershipAccess(cycle, now);

  if (access.access === 'suspended') {
    // Benefits paused — an unpaid invoice is outstanding, or a payment is
    // pending admin review. AMBER (warning), never red — this is not an
    // accusation, the member remains a member (§ User-facing surfaces).
    return {
      kind: 'suspended',
      variant: 'warning',
      daysRemaining: days,
      status,
      expiryIso: cycle.expiresAt,
      reason: access.reason,
    };
  }

  if (access.access === 'terminated') {
    // Membership itself has ended (grace expired, or an admin-cancelled
    // period that has run out) — reuses the pre-existing `lapsed` kind/copy
    // (mailto contact-support CTA), now carrying the specific reason.
    return {
      kind: 'lapsed',
      variant: 'destructive',
      daysRemaining: days,
      status,
      expiryIso: cycle.expiresAt,
      reason: access.reason,
    };
  }

  // access.access === 'full' — UNCHANGED active/due/empty logic (057 R2
  // CRITICAL: a `completed` cycle past its expiry MUST stay good-standing,
  // never re-prompted for payment — guaranteed here because
  // `deriveMembershipAccess` only returns `full` for a non-terminal cycle
  // when it is NOT expired, for `completed` regardless of date, or for a
  // cancelled/lapsed cycle whose period has not yet ended). The old E2
  // "malformed date on a non-terminal cycle → error" guard is now
  // unreachable by construction: `deriveMembershipAccess` treats an
  // unparseable `expiresAt` on a non-terminal cycle as EXPIRED, which
  // resolves to `suspended` above — so `full` + non-terminal status always
  // carries a parseable, future `days` value here.
  if (days !== null && days <= 30 && !isTerminalCycleStatus(status)) {
    return { kind: 'due', variant: 'warning', daysRemaining: days, status, expiryIso: cycle.expiresAt, reason: null };
  }
  // Far off, completed (paid up), or a cancelled/lapsed cycle still within
  // its period → show membership status, not a stale countdown.
  return { kind: 'active', variant: 'neutral', daysRemaining: days, status, expiryIso: cycle.expiresAt, reason: null };
}

/** The minimal invoice shape the outstanding stat needs (decoupled from the F4 domain row). */
export interface OutstandingInvoiceInput {
  readonly status: string;
  /** Invoice total in satang, or null for drafts (excluded anyway). */
  readonly totalSatang: bigint | null;
  /** ISO YYYY-MM-DD due date, or null. */
  readonly dueDate: string | null;
  /**
   * 059-membership-suspension — the invoice id + subject discriminator, so
   * the smart-CTA helper (`resolveSuspendedCtaTarget`) can find an unpaid
   * MEMBERSHIP invoice (as opposed to an event-ticket invoice) to link to,
   * without a second DB read (reuses the same `deriveOutstandingStat` data
   * the Outstanding-balance card already loads).
   */
  readonly id: string;
  readonly invoiceSubject: 'membership' | 'event';
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
  /**
   * `empty` = first-run (no benefits); `under-use` = ≥1 lagging; `on-track`
   * otherwise; `error` = the benefit read failed (transient) — distinct from
   * `empty` so a compute failure is never shown as "No benefits yet" (Defer 1).
   */
  readonly kind: 'empty' | 'under-use' | 'on-track' | 'error';
  readonly variant: StatVariant;
  readonly underUseCount: number;
  /**
   * 063 UX — the keys of the under-used quantifiable benefits, in
   * `usage.quantifiable` order (e.g. `['eblast']`). Lets the dashboard card
   * NAME the single lagging benefit ("E-Blasts under-used") instead of a bare
   * "1 benefit under-used". Empty for every non-`under-use` kind.
   */
  readonly underUsedKeys: readonly string[];
}

/**
 * What the read layer passes for the benefits stat:
 *  - a real `BenefitUsage` value — derive under-use vs on-track;
 *  - `null` — a BENIGN "no plan / member has no benefit basis"
 *    (`computeBenefitUsage` err `member_not_found`), rendered as the neutral
 *    `empty` state, NOT a warning (D1 review finding C);
 *  - `'error'` — a genuine compute FAILURE (`compute_failed` / a throw),
 *    rendered as the distinct transient-failure `error` state so a real
 *    failure is not shown as "No benefits yet" (Defer 1 D1 code review).
 *
 * Distinguishing `null` from `'error'` stops a plan-less member from seeing a
 * misleading "Benefits unavailable" warning on every render.
 */
export type BenefitUsageReadInput = BenefitUsage | 'error' | null;

/**
 * Under-use HIGHLIGHT (spec §4.1 + review S-1) — a COUNT of benefits lagging
 * the elapsed year, NOT the aggregate %. A benefit is under-used when its
 * (used ÷ entitlement) %-point gap below the elapsed-year % is ≥ 25 (same
 * threshold the F9 aggregate uses). Active-only plans (no quantifiable
 * benefit) are always "on-track".
 *
 * Accepts the `'error'` sentinel (a genuine compute failure) → kind:'error',
 * and `null` (a benign no-plan `member_not_found`) → kind:'empty' (neutral).
 */
export function deriveBenefitsStat(usage: BenefitUsageReadInput): BenefitsStat {
  if (usage === 'error') {
    return { kind: 'error', variant: 'warning', underUseCount: 0, underUsedKeys: [] };
  }
  // `null` = benign "no benefit basis" (member_not_found) — neutral empty, not
  // a warning. Falls through to the same empty result as a content-less VO.
  if (usage === null) {
    return { kind: 'empty', variant: 'neutral', underUseCount: 0, underUsedKeys: [] };
  }
  const hasContent = usage.quantifiable.length > 0 || usage.active.length > 0;
  if (!hasContent) {
    return { kind: 'empty', variant: 'neutral', underUseCount: 0, underUsedKeys: [] };
  }
  // 063 UX — collect the KEYS of the lagging benefits (not just a count) so the
  // dashboard card can name the single one. Order follows `usage.quantifiable`.
  const underUsedKeys: string[] = [];
  for (const b of usage.quantifiable) {
    if (b.entitlement <= 0) continue;
    const consumedPct = (b.used / b.entitlement) * 100;
    if (usage.elapsedYearPct - consumedPct >= PER_BENEFIT_UNDER_USE_GAP_PCT) {
      underUsedKeys.push(b.key);
    }
  }
  return underUsedKeys.length > 0
    ? {
        kind: 'under-use',
        variant: 'warning',
        underUseCount: underUsedKeys.length,
        underUsedKeys,
      }
    : { kind: 'on-track', variant: 'neutral', underUseCount: 0, underUsedKeys: [] };
}
