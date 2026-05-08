/**
 * F8 Phase 6 Wave A1 — `AtRiskScore` Domain entity (FR-029 canonical formula).
 *
 * 8-factor at-risk score formula per spec
 * `specs/011-renewal-reminders/spec.md` § FR-029 + F6-readiness fallback
 * per FR-029a + proportional bands per FR-030. The audit payload contract
 * `active_max: 70 | 100` at
 * `specs/011-renewal-reminders/contracts/audit-port.md` line 297 is the
 * canonical max-score reference.
 *
 * **Wave A1 alignment note** (resolved at maintainer Plan-Mode Q&A
 * 2026-05-08): the Wave D shipped Domain (T038 GREEN) used a different
 * factor set sourced from F1+F3+F4+F5+F8 (inactivity / payment-failures /
 * email-unverified / past-grace / email-engagement). Wave A1 re-aligns
 * to FR-029 verbatim — single canonical source of truth — at the cost
 * of widening factor coverage to F2+F4+F6+F7. Wave D's shipped formula
 * is preserved in git history.
 *
 * **Sub-finding** (surfaced at Wave A1): summing the 8 FR-029 weights
 * gives 115 points (F6-active) which clips to 100 per FR-029
 * `min(100, sum_of_active_factor_points)`. Per audit-port contract
 * `active_max: 70 | 100`, the F6-inactive max MUST be 70. With the
 * three F6-dependent factors removed (events_12mo +25, events_3mo +10,
 * cultural_ticket +10 — totalling 45 points), the F6-independent sum
 * is exactly 70 (e_blast +15, invoices_overdue +25, days_since_payment
 * +10, days_since_contact +5, tier_downgrade +15). This implies that
 * **`cultural_ticket_quota_under_50pct` is also F6-dependent** (event-
 * ticket data sources from EventCreate, parallel to event-attendance
 * factors). Spec FR-029 only marks the two events_attended factors with
 * `(skipped if F6 module not active — see FR-029a)`; the cultural-
 * ticket annotation is an implicit consequence required by the
 * arithmetic. Defer formal spec-text amendment to a follow-up
 * `/speckit.clarify` round if maintainer prefers a different reading.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { ok, type Result } from '@/lib/result';
import {
  type RiskBand,
  bandForScoreProportional,
} from './value-objects/risk-band';

// ---------------------------------------------------------------------------
// FR-029 factor weight table — canonical, single source of truth
// ---------------------------------------------------------------------------

/**
 * FR-029 factor weights. Per `/speckit.clarify` Session 2026-05-03 round
 * 3 Q5: weights are locked at this single canonical formula across all
 * tenants; per-tenant tunability is OOS-15 deferred until ≥6 tenants on
 * platform.
 */
export const AT_RISK_FACTOR_WEIGHTS = {
  /** F6-dependent — Events attended last 12 months == 0 → +25 */
  events_attended_last_12mo_zero: 25,
  /** F6-dependent — Events attended last 3 months == 0 (with >0 in 12mo) → +10 */
  events_attended_last_3mo_zero: 10,
  /** F6-independent — E-Blast quota used <30% → +15 */
  e_blast_quota_under_30pct: 15,
  /** F6-dependent (event-ticket data) — Cultural-ticket quota used <50% → +10 */
  cultural_ticket_quota_under_50pct: 10,
  /** F6-independent — Invoices overdue count >0 → +25 (binary, NOT per-invoice) */
  invoices_overdue_count_gt_zero: 25,
  /** F6-independent — Days since last payment >180 → +10 */
  days_since_last_payment_gt_180: 10,
  /** F6-independent — Days since contact-record update >365 → +5 */
  days_since_contact_update_gt_365: 5,
  /** F6-independent — Tier downgraded in last 12 months → +15 */
  tier_downgraded_last_12mo: 15,
} as const;

/** Max score with F6 active — sum is 115, clipped to 100 per FR-029 `min(100, sum)`. */
export const F6_ACTIVE_MAX = 100 as const;

/**
 * Max score with F6 inactive — sum of F6-independent factors only
 * (15+25+10+5+15 = 70). Matches audit-port contract
 * `active_max: 70 | 100` literal.
 */
export const F6_INACTIVE_MAX = 70 as const;

/**
 * Set of factor keys that source from F6 (event-attendance data + event-
 * ticket quota). When `eventAttendeesAvailable === false` the scorer
 * skips these factors entirely and flags `eventAttendanceFactorSkipped:
 * true` so the audit trail shows the FR-029a fallback was active.
 */
const F6_DEPENDENT_FACTORS: ReadonlySet<keyof typeof AT_RISK_FACTOR_WEIGHTS> =
  new Set([
    'events_attended_last_12mo_zero',
    'events_attended_last_3mo_zero',
    'cultural_ticket_quota_under_50pct',
  ]);

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * 8 input signals for FR-029 scoring. All optional — the formula
 * tolerates missing factors by skipping them (contributes 0). The
 * Application-layer adapter (Phase 6 Wave B `compute-at-risk-score.ts`)
 * gathers these from F2+F3+F4+F6+F7 cross-module bridges.
 */
export interface AtRiskFactors {
  /**
   * Tenure in days. Members below `ctx.minTenureDays` (default 30 from
   * tenant_renewal_settings, FR-035) skip scoring entirely.
   */
  readonly tenureDays?: number;

  // F6-dependent factors — skipped when `eventAttendeesAvailable === false`

  /** F6 — Events attended in last 12 months. 0 ⇒ +25 (FR-029 line 1). */
  readonly eventsAttendedLast12Months?: number;
  /** F6 — Events attended in last 3 months. 0 with `events_12mo > 0` ⇒ +10. */
  readonly eventsAttendedLast3Months?: number;
  /**
   * F6 — Cultural-event-ticket quota used (0–100 percentage). <50 ⇒ +10
   * (FR-029 line 4). F6-dependent because ticket data sources from
   * EventCreate.
   */
  readonly culturalTicketQuotaPctUsed?: number;

  // F6-independent factors

  /** F7 — E-Blast quota used (0–100 percentage). <30 ⇒ +15. */
  readonly eBlastQuotaPctUsed?: number;
  /** F4 — Count of currently-overdue invoices. >0 ⇒ +25 (binary). */
  readonly invoicesOverdueCount?: number;
  /** F4 — Days since the last paid invoice. >180 ⇒ +10. */
  readonly daysSinceLastPayment?: number;
  /** F3 — Days since any contact-record update. >365 ⇒ +5. */
  readonly daysSinceContactUpdate?: number;
  /** F2 audit-log — Whether the member's tier was downgraded in last 12mo. */
  readonly tierDowngradedLast12Months?: boolean;
}

export interface AtRiskComputeContext {
  /** Per-tenant min-tenure threshold (default 30 from tenant_renewal_settings). */
  readonly minTenureDays: number;
  /**
   * F6 readiness gate per FR-029a. When false, the three F6-dependent
   * factors (events_12mo, events_3mo, cultural_ticket) are skipped + the
   * `eventAttendanceFactorSkipped: true` flag is set.
   */
  readonly eventAttendeesAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** Per-factor contribution. Sum across contributions ⇒ raw score (then clipped). */
export interface FactorContribution {
  readonly factor: keyof typeof AT_RISK_FACTOR_WEIGHTS;
  readonly points: number;
}

export interface AtRiskScoreResult {
  /** Final score in [0, 100]. Always clipped per FR-029 `min(100, sum)`. */
  readonly score: number;
  /** Band derived via `bandForScoreProportional(score, activeMax)` (FR-030). */
  readonly band: RiskBand;
  /** Per-factor contributions used to derive the score. */
  readonly contributions: readonly FactorContribution[];
  /** True when min-tenure gate skipped scoring entirely (FR-035). */
  readonly skippedBelowMinTenure: boolean;
  /** True when F6 fallback was active (events + cultural-ticket factors skipped). */
  readonly eventAttendanceFactorSkipped: boolean;
  /** Active max for the F6 mode in effect (100 active / 70 inactive). */
  readonly activeMax: typeof F6_ACTIVE_MAX | typeof F6_INACTIVE_MAX;
}

// ---------------------------------------------------------------------------
// Compute function
// ---------------------------------------------------------------------------

/**
 * Compute the at-risk score per FR-029. Always returns `ok` — score
 * saturates at the [0, 100] bound and band derivation is total over the
 * valid score range.
 *
 * Result is structured so callers can persist `score`, `band`, AND
 * `contributions` JSONB to `members.risk_score_*` columns (data-model.md
 * § 3.1; migration 0094).
 */
export function computeAtRiskScore(
  factors: AtRiskFactors,
  ctx: AtRiskComputeContext,
): Result<AtRiskScoreResult, never> {
  const eventAttendanceFactorSkipped = !ctx.eventAttendeesAvailable;
  const activeMax = ctx.eventAttendeesAvailable
    ? F6_ACTIVE_MAX
    : F6_INACTIVE_MAX;

  // Min-tenure gate (FR-035) — members newer than threshold skip scoring.
  if (
    factors.tenureDays !== undefined &&
    factors.tenureDays < ctx.minTenureDays
  ) {
    return ok({
      score: 0,
      band: 'healthy',
      contributions: [],
      skippedBelowMinTenure: true,
      eventAttendanceFactorSkipped,
      activeMax,
    });
  }

  const contributions: FactorContribution[] = [];
  const f6Active = ctx.eventAttendeesAvailable;

  const add = (factor: keyof typeof AT_RISK_FACTOR_WEIGHTS): void => {
    if (!f6Active && F6_DEPENDENT_FACTORS.has(factor)) return;
    contributions.push({
      factor,
      points: AT_RISK_FACTOR_WEIGHTS[factor],
    });
  };

  // ---------------------------------------------------------------------
  // F6-dependent factors (events + cultural-ticket)
  // ---------------------------------------------------------------------

  // FR-029 line 1: events 12mo == 0 → +25
  if (
    factors.eventsAttendedLast12Months !== undefined &&
    factors.eventsAttendedLast12Months === 0
  ) {
    add('events_attended_last_12mo_zero');
  } else if (
    // FR-029 line 2: events 3mo == 0 (with >0 in 12mo) → +10
    factors.eventsAttendedLast3Months !== undefined &&
    factors.eventsAttendedLast3Months === 0 &&
    factors.eventsAttendedLast12Months !== undefined &&
    factors.eventsAttendedLast12Months > 0
  ) {
    add('events_attended_last_3mo_zero');
  }

  // FR-029 line 4: cultural-ticket quota <50% → +10
  if (
    factors.culturalTicketQuotaPctUsed !== undefined &&
    factors.culturalTicketQuotaPctUsed < 50
  ) {
    add('cultural_ticket_quota_under_50pct');
  }

  // ---------------------------------------------------------------------
  // F6-independent factors
  // ---------------------------------------------------------------------

  // FR-029 line 3: e-blast quota <30% → +15
  if (
    factors.eBlastQuotaPctUsed !== undefined &&
    factors.eBlastQuotaPctUsed < 30
  ) {
    add('e_blast_quota_under_30pct');
  }

  // FR-029 line 5: invoices overdue >0 → +25 (binary)
  if (
    factors.invoicesOverdueCount !== undefined &&
    factors.invoicesOverdueCount > 0
  ) {
    add('invoices_overdue_count_gt_zero');
  }

  // FR-029 line 6: days since last payment >180 → +10
  if (
    factors.daysSinceLastPayment !== undefined &&
    factors.daysSinceLastPayment > 180
  ) {
    add('days_since_last_payment_gt_180');
  }

  // FR-029 line 7: days since contact update >365 → +5
  if (
    factors.daysSinceContactUpdate !== undefined &&
    factors.daysSinceContactUpdate > 365
  ) {
    add('days_since_contact_update_gt_365');
  }

  // FR-029 line 8: tier downgraded in last 12mo → +15
  if (factors.tierDowngradedLast12Months === true) {
    add('tier_downgraded_last_12mo');
  }

  // Sum + clamp to [0, 100] per FR-029.
  const rawSum = contributions.reduce((acc, c) => acc + c.points, 0);
  const score = Math.max(0, Math.min(F6_ACTIVE_MAX, rawSum));

  // Band derivation per FR-030 — proportional to activeMax.
  const bandResult = bandForScoreProportional(score, activeMax);
  // Score is in [0, activeMax] by construction so this branch is
  // unreachable; the typed return path stays explicit for code clarity.
  /* v8 ignore next */
  const band: RiskBand = bandResult.ok ? bandResult.value : 'healthy';

  return ok({
    score,
    band,
    contributions,
    skippedBelowMinTenure: false,
    eventAttendanceFactorSkipped,
    activeMax,
  });
}
