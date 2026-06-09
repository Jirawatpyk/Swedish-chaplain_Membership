/**
 * `dispatchOneCycle` — single per-cycle decision tree shared by the
 * cron entry (`dispatchRenewalCycle`) and the admin entry
 * (`sendReminderNow`) per FR-018 single-source-of-truth requirement.
 *
 * Decision tree: 13 gates (first match wins). The canonical list lives
 * inline as `// Gate N — …` comments next to the runtime checks below
 * — keeping a single source of truth so a future gate addition can't
 * drift between the header narrative and the executable logic. Skip
 * reasons emitted by the gates: see the `SKIP_REASONS` const tuple.
 *
 * Channel branch (after gate 12 idempotency insert):
 *   - email — gateway.sendRenewalEmail → success: transition + audit
 *     `renewal_reminder_sent`; 4xx → `renewal_reminder_send_failed_permanent`;
 *     5xx → `renewal_reminder_send_failed` (`retry-failed-reminders.ts`
 *     handles the FR-010a 24h retry budget).
 *   - task — escalationTaskRepo.insertIfAbsent + audit `escalation_task_created`.
 *
 * Atomic state+audit per Constitution Principle VIII: all reminder-event
 * status transitions + audit emits happen inside `runInTenant` tx. The
 * external gateway call happens BEFORE the tx is opened (gateways are
 * non-transactional); on success/failure the persistence + audit are
 * wrapped in a fresh tx. Uncaught throws between `insertIfAbsent` and
 * the success-tx are caught by `defensivelyMarkFailedForRetry` (J2-B2)
 * so a failed `pending` row never orphans.
 *
 * Located in `_lib/` (helper / coordinator location), but several
 * symbols ARE re-exported via the F8 barrel (`SKIP_REASONS`,
 * `SkipReason`, `DispatchContext`, `DispatchOneCycleOutcome`,
 * `RETRY_BUDGET_HOURS`, `DispatchFailureKind`). The directory naming
 * follows the project convention of "use-case orchestration helpers
 * live under `_lib/`" — it does NOT imply private/non-exported.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { renewalsMetrics } from '@/lib/metrics';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../../infrastructure/renewals-deps';
import { buildRenewalCtaUrl } from './build-renewal-redeem-link-url';
import {
  findDueStepsForDate,
} from '../../../domain/tenant-renewal-schedule-policy';
import { asCycleId } from '../../../domain/renewal-cycle';
import { asTaskId } from '../../../domain/renewal-escalation-task';
import type {
  ReminderStep,
} from '../../../domain/value-objects/reminder-step';
import type { DispatchCandidate } from '../../ports/dispatch-candidate-repo';
import { ReminderEventNotFoundError } from '../../ports/renewal-reminder-event-repo';
import { isPermanentGatewayError } from '../../ports/renewal-gateway';
import type { RenewalActorRole } from '../../ports/renewal-audit-emitter';
import { pauseRemindersAfterOutreach } from '../pause-reminders-after-outreach';
import type { MemberId } from '@/modules/members';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * FR-010a retry budget window (in hours). Transient gateway failures
 * get `retry_until = dispatched_at + RETRY_BUDGET_HOURS`. The
 * `retry-failed-reminders.ts` use-case is the consumer — it re-attempts
 * within this window (Pass 1) and transitions the event to permanent
 * failure beyond it (Pass 2 — `renewal_reminder_send_failed_permanent`
 * audit + `manual_outreach_required` escalation task).
 */
export const RETRY_BUDGET_HOURS = 24 as const;

/**
 * The 13 skip reasons emitted by the dispatcher. Single audit event
 * `renewal_reminder_skipped` carries `{reason}` payload. Distinct from
 * `renewal_reminder_deferred_read_only` + `renewal_skipped_no_joined_at`
 * (their own events for backward compatibility with FR-012 audit-trail
 * granularity).
 */
export const SKIP_REASONS = [
  'feature_flag_disabled',
  'read_only_mode',
  'cycle_terminal',
  'member_archived',
  'no_joined_at',
  'member_opted_out',
  'email_unverified',
  'tenant_misconfigured',
  'not_due_today',
  'multi_year_non_final_year',
  'outreach_in_progress',
  'no_primary_contact',
  'already_sent',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * J6-H7 — compile-time count check pinning the const tuple length so a
 * typo or accidental drop in `SKIP_REASONS` becomes a build error.
 * Mirrors the `_AssertF8AuditEventCount` pattern in renewal-audit-emitter.ts.
 * Bump the literal when intentionally adding/removing a skip reason.
 */
type _AssertSkipReasonCount = (typeof SKIP_REASONS)['length'] extends 13
  ? true
  : 'SKIP_REASONS count mismatch — expected 13';
const _assertSkipReasonCount: _AssertSkipReasonCount = true;
void _assertSkipReasonCount;

export interface DispatchContext {
  readonly tenantId: string;
  /** Null for cron actor; UUID for admin "Send reminder now" caller. */
  readonly actorUserId: string | null;
  /**
   * J9-M15: narrowed `RenewalActorRole` to the two F8-dispatch-eligible
   * actors. Sourced from the shared union in `renewal-audit-emitter.ts`
   * so adding a future role propagates here at compile time.
   */
  readonly actorRole: Extract<RenewalActorRole, 'cron' | 'admin'>;
  readonly correlationId: string;
  readonly requestId: string | null;
  /** Injectable now-clock for tests. Default: real-time on each call. */
  readonly nowIso: string;
}

/**
 * J9-M17 + Round 4 IMP-9 + Round 5 SUG-4 — closed set of gateway-
 * error classifiers used by the audit emit (`failure_kind` field on
 * `renewal_reminder_send_failed` /
 * `renewal_reminder_send_failed_permanent`). Type-linked to
 * `SendRenewalEmailError['kind']` (R4 back-port of the R3 IMP-7
 * pattern from `tier_upgrade_pending_member_notify_failed`) plus
 * `dispatcher_crash` (J2-B2 synthetic for uncaught throws).
 *
 * Round 5 SUG-4 design note: this alias lives in `_lib/` (next to
 * its primary consumer dispatch-one-cycle) but the audit-emitter
 * port also imports it. A future refactor MAY relocate it to a
 * port-co-located file (e.g. a new `application/ports/dispatch-
 * failure-kind.ts`) so the audit-emitter port depends only on
 * other ports — kept here for now to avoid the relocation churn
 * in a late-cycle review pass.
 *
 * Drift prevention: when a future arm is added to `SendRenewalEmail
 * Error`, the `['kind']` lookup propagates automatically through this
 * alias and into the audit shape — no hand-mirrored literal union to
 * keep in sync. Forensic queries on `failure_kind` rely on this
 * closed set; previously the audit shape had `failure_kind: string`
 * which would silently accept typos like `'gateway_500'`.
 *
 * Outcome.reason still carries free-form text (provider error message)
 * because the legacy wire format mixes literal-kind + message text in
 * the same field — splitting that would be a contract break for
 * downstream toast UI strings.
 */
import type { SendRenewalEmailError } from '../../ports/renewal-gateway';
export type DispatchFailureKind =
  | SendRenewalEmailError['kind']
  | 'dispatcher_crash';

export type DispatchOneCycleOutcome =
  | {
      readonly kind: 'sent';
      readonly reminderEventId: string;
      readonly deliveryId: string;
      readonly dispatchedAt: string;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: SkipReason;
      /** Optional metadata included in the audit payload (e.g. `latest_outreach_at`). */
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: 'task_created';
      readonly taskId: string;
      /**
       * J9-M16 (deferred): `taskType` stays `string` because schedule-
       * policy steps allow admins to author custom task types via the
       * editor's free-form input. Pinning to a closed literal union
       * would over-constrain the customer-facing flexibility. The
       * audit-payload shape pins the closed set for security-critical
       * triggers (e.g. `manual_outreach_required`) elsewhere.
       */
      readonly taskType: string;
      readonly reminderEventId: string;
    }
  | {
      readonly kind: 'failed_transient';
      readonly reminderEventId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'failed_permanent';
      readonly reminderEventId: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 063 — catch-up provenance threaded from Gate 8 into the success-path
 * audit. `caughtUp` is true when the step's due-day was strictly before
 * today (the daily cron missed the exact due-day and is recovering within
 * the bounded lookback). `stepDueDate` is the ISO date the step was
 * originally due (UTC day boundary) for forensic correlation.
 */
interface CatchUpInfo {
  readonly caughtUp: boolean;
  readonly stepDueDate: string;
}

/** `year_in_cycle = floor((now - period_from) / 365 days) + 1` per research.md:103. */
export function computeYearInCycle(periodFromIso: string, nowIso: string): number {
  const start = new Date(periodFromIso).getTime();
  const now = new Date(nowIso).getTime();
  const days = Math.floor((now - start) / MS_PER_DAY);
  // Year-in-cycle is 1-indexed. Negative results (now < period_from)
  // should not happen for active cycles; defensive clamp to 1.
  return Math.max(1, Math.floor(days / 365) + 1);
}

/** Total years in a multi-year cycle (cycleLengthMonths / 12). */
export function computeCycleYears(cycleLengthMonths: number): number {
  return Math.max(1, Math.round(cycleLengthMonths / 12));
}

// ---------------------------------------------------------------------------
// Skip-emit helper — emits `renewal_reminder_skipped` with reason payload.
// Returns the outcome shape for caller convenience.
// ---------------------------------------------------------------------------

async function emitSkipAudit(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
  reason: SkipReason,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { cycle, member } = candidate;
  // Special-case: read_only_mode emits a DISTINCT event per FR-012.
  if (reason === 'read_only_mode') {
    await deps.auditEmitter.emit(
      {
        type: 'renewal_reminder_deferred_read_only',
        payload: {
          cycle_id: cycle.cycleId,
          member_id: member.memberId as MemberId,
          tenant_id: ctx.tenantId,
        },
      },
      {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      },
    );
    return;
  }
  // Special-case: no_joined_at emits a DISTINCT event per spec.md Edge Case
  // ("Member with `joined_at IS NULL` ... Audit event `renewal_skipped_no_joined_at`").
  if (reason === 'no_joined_at') {
    await deps.auditEmitter.emit(
      {
        type: 'renewal_skipped_no_joined_at',
        payload: {
          cycle_id: cycle.cycleId,
          member_id: member.memberId as MemberId,
          tenant_id: ctx.tenantId,
        },
      },
      {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      },
    );
    return;
  }
  // Skip events that don't need audit emission (FR-012 — `already_sent`
  // is implicit from the prior reminder_event row already audited;
  // `not_due_today` and `feature_flag_disabled` are too noisy).
  if (
    reason === 'already_sent' ||
    reason === 'not_due_today' ||
    reason === 'feature_flag_disabled'
  ) {
    return;
  }
  // K7: explicit exhaustiveness check on the `SkipReason` union. The
  // remaining 8 reasons all flow through the generic
  // `renewal_reminder_skipped` audit emit. The `_remaining` switch
  // pins exhaustiveness — if a future `SkipReason` lands without
  // either an early-return special-case above OR explicit handling
  // here, this switch will fail at compile time.
  const _remaining:
    | 'cycle_terminal'
    | 'member_archived'
    | 'member_opted_out'
    | 'email_unverified'
    | 'tenant_misconfigured'
    | 'multi_year_non_final_year'
    | 'outreach_in_progress'
    | 'no_primary_contact' = reason;
  void _remaining;
  await deps.auditEmitter.emit(
    {
      type: 'renewal_reminder_skipped',
      payload: {
        cycle_id: cycle.cycleId,
        member_id: member.memberId as MemberId,
        reason,
        ...(metadata ?? {}),
      },
    },
    {
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    },
  );
  // Phase 9 / T231 — business-volume counter pairs with FR-012
  // skip-reason taxonomy. Reason label is the same SkipReason union
  // already pinned by the exhaustive switch above, so cardinality is
  // bounded.
  renewalsMetrics.remindersSkipped(reason);
}

// ---------------------------------------------------------------------------
// Main dispatch decision tree
// ---------------------------------------------------------------------------

export async function dispatchOneCycle(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
): Promise<DispatchOneCycleOutcome> {
  return withActiveSpan(
    renewalsTracer(),
    'dispatch_one_cycle',
    {
      'tenant.id': ctx.tenantId,
      'cycle.id': candidate.cycle.cycleId,
      'tier.bucket': candidate.cycle.tierAtCycleStart,
      'actor.role': ctx.actorRole,
    },
    async (span) => {
      const outcome = await dispatchOneCycleInner(deps, candidate, ctx);
      span.setAttribute('renewals.outcome_kind', outcome.kind);
      if (outcome.kind === 'skipped') {
        span.setAttribute('renewals.skip_reason', outcome.reason);
      }
      return outcome;
    },
  );
}

async function dispatchOneCycleInner(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
): Promise<DispatchOneCycleOutcome> {
  // `primaryContact` is consumed per-step inside `fireStep` (Gate 11).
  const { cycle, member, schedulePolicy } = candidate;

  // Gate 1 — feature flag.
  if (!env.features.f8Renewals) {
    return { kind: 'skipped', reason: 'feature_flag_disabled' };
  }
  // Gate 2 — read-only mode.
  if (env.flags.readOnlyMode) {
    await emitSkipAudit(deps, candidate, ctx, 'read_only_mode');
    return { kind: 'skipped', reason: 'read_only_mode' };
  }
  // Gate 3 — cycle terminal (defensive; the repo should already filter).
  if (
    cycle.status === 'completed' ||
    cycle.status === 'cancelled' ||
    cycle.status === 'lapsed'
  ) {
    await emitSkipAudit(deps, candidate, ctx, 'cycle_terminal');
    return { kind: 'skipped', reason: 'cycle_terminal' };
  }
  // Gate 4 — member archived.
  if (member.status === 'archived') {
    await emitSkipAudit(deps, candidate, ctx, 'member_archived');
    return { kind: 'skipped', reason: 'member_archived' };
  }
  // Gate 4.5 — member has no joined_at (data-hygiene defence per spec.md
  // Edge Case "Member with `joined_at IS NULL` (data hygiene from F3 /
  // Excel import)"). F3's `registration_date` is NOT NULL at the schema
  // level, but Excel-imported rows can carry empty strings; if F8
  // dispatcher reaches this gate with a missing joined_at the cycle's
  // expires_at math would be unreliable, so we emit the dedicated audit
  // event and abort dispatch. In practice this never fires because
  // cycles are not created for members lacking joined_at, but the gate
  // is the contracted backstop.
  if (!member.registrationDate || member.registrationDate.length === 0) {
    await emitSkipAudit(deps, candidate, ctx, 'no_joined_at');
    return { kind: 'skipped', reason: 'no_joined_at' };
  }
  // Gate 5 — member opted out (FR-016).
  if (member.renewalRemindersOptedOut) {
    await emitSkipAudit(deps, candidate, ctx, 'member_opted_out');
    return { kind: 'skipped', reason: 'member_opted_out' };
  }
  // Gate 6 — email unverified (FR-012a — bounce-threshold flag).
  if (member.emailUnverified) {
    await emitSkipAudit(deps, candidate, ctx, 'email_unverified');
    return { kind: 'skipped', reason: 'email_unverified' };
  }
  // Gate 7 — no schedule policy (rare — SweCham seed populates 5 rows).
  if (schedulePolicy === null) {
    await emitSkipAudit(deps, candidate, ctx, 'tenant_misconfigured');
    return { kind: 'skipped', reason: 'tenant_misconfigured' };
  }
  // Gate 8 — resolve the due (or recently-overdue) step(s) + bounded catch-up.
  //
  // 063 — was a STRICT day-equality match (`target === todayUtc`) which
  // silently dropped a reminder forever whenever the daily cron missed the
  // exact UTC day a step was due (Vercel reboot, READ_ONLY_MODE window,
  // infra outage). Now `findDueStepsForDate` returns every step whose
  // due-day is within `[todayUtc - REMINDER_CATCH_UP_LOOKBACK_DAYS, todayUtc]`
  // (most-recent first), so a short cron miss recovers while a long outage
  // does NOT blast a stale reminder (a step older than the lookback is
  // excluded — firing a T-90 when it is now T-30 is worse than skipping).
  //
  // Among the window candidates we fire the MOST-RECENT step NOT yet sent
  // for this (cycle, step, year_in_cycle), PLUS any sibling steps sharing
  // its due-day (see § same-target co-resolution below). This is
  // deliberately DIFFERENT from the admin reactivation ladder
  // (`reconcile-pending-reactivations.ts` `decideRemindersToFire`) which
  // fires EVERY crossed-unfired rung in a single pass. Here we fire only the
  // most-recent due-DAY per pass — the no-spam tradeoff for member
  // reminders: a member must never receive multiple catch-up emails for
  // DIFFERENT due-days in one cron run. Older unfired in-window steps with
  // an EARLIER due-day are dropped as stale on that pass; on the next daily
  // run they slide below the lookback and are permanently skipped. The
  // dropped step is always the older / less-urgent one, so urgency is
  // preserved. The Gate-12 idempotency index stays the double-send guard.
  // See spec.md:194 + FR-010 ("dispatch any reminder step whose offset_day
  // is due").
  //
  // 063 #1 — `yearInCycle` (run-date based) is the CYCLE-position year used
  // by Gate 9 (multi-year final-year gate) + the cron forensic year. It is
  // NOT a safe idempotency namespace: a catch-up step whose due-date fell in
  // the PRIOR quota year (the 365-day boundary lands inside the 7-day
  // lookback) would drift run-date-year 1→2, miss the prior send's row in
  // `firedKeys`, and mint a year-2 duplicate via Gate-12 `insertIfAbsent`
  // (no unique conflict) → a DOUBLE SEND. The idempotency year MUST be
  // anchored on each step's DUE-date (`stepYearInCycleOf`), so the catch-up
  // pass resolves the step to the SAME year the original send recorded.
  const yearInCycle = computeYearInCycle(cycle.periodFrom, ctx.nowIso);
  const windowSteps = findDueStepsForDate(
    schedulePolicy,
    new Date(cycle.expiresAt),
    new Date(ctx.nowIso),
  );
  if (windowSteps.length === 0) {
    // No step is due-or-overdue within the lookback (a future step, or a
    // step stale beyond the lookback). Silent no-op (not an audit event —
    // too noisy; FR-012).
    return { kind: 'skipped', reason: 'not_due_today' };
  }
  const anchorDayUtc = Math.floor(
    new Date(cycle.expiresAt).getTime() / MS_PER_DAY,
  );
  const todayUtcDay = Math.floor(new Date(ctx.nowIso).getTime() / MS_PER_DAY);
  // A step's due-DAY (UTC day index) is the cycle-expiry day + its offset.
  const stepDueDayUtcOf = (s: ReminderStep): number =>
    anchorDayUtc + s.offsetDays;
  // 063 #1 — STEP-anchored year_in_cycle: the year the step BELONGS to,
  // derived from its due-date (not the cron run-date). This is the
  // idempotency namespace (firedKeys dedup + Gate-12 insertIfAbsent).
  const stepYearInCycleOf = (s: ReminderStep): number =>
    computeYearInCycle(
      cycle.periodFrom,
      new Date(stepDueDayUtcOf(s) * MS_PER_DAY).toISOString(),
    );

  // 063 #4 — the per-cycle history read (`listForCycle`) is a DB round-trip
  // that previously fired for EVERY cycle with an in-window step (+N reads
  // on every shared-renewal-window day → cron 60s-budget risk). It is only
  // NEEDED when a CATCH-UP is actually possible — i.e. at least one window
  // step is OVERDUE (`target < todayUtc`). When the only due step is exactly
  // today (the common no-catch-up path) we SKIP the read entirely and let
  // Gate-12's `insertIfAbsent` (the unique index) be the dedup guard, as it
  // was before the catch-up landed. `firedKeys` stays empty on that path.
  const hasOverdueStep = windowSteps.some(
    (s) => stepDueDayUtcOf(s) < todayUtcDay,
  );
  let firedKeys = new Set<string>();
  if (hasOverdueStep) {
    // `listForCycle` is RLS-scoped (wraps its own runInTenant) so this read
    // stays tenant-isolated.
    const existing = await deps.reminderEventRepo.listForCycle(
      ctx.tenantId,
      asCycleId(cycle.cycleId),
    );
    firedKeys = new Set(existing.map((e) => `${e.stepId}::${e.yearInCycle}`));
  }

  // windowSteps is most-recent first → the first unfired one is the most
  // relevant step to send now. When EVERY in-window step is already fired
  // we deliberately fall back to the most-recent window step so Gate 12's
  // `insertIfAbsent` reports the FR-011 idempotency-hit (`already_sent`) —
  // preserving the existing replay-skip-reason contract (a same-day re-run
  // must report `already_sent`, not `not_due_today`). Idempotency check is
  // STEP-anchored (063 #1).
  const primaryStep: ReminderStep =
    windowSteps.find(
      (s) => !firedKeys.has(`${s.stepId}::${stepYearInCycleOf(s)}`),
    ) ?? windowSteps[0]!;

  // 063 #5 — same-target (same-offsetDay) co-resolution. Some tiers seed TWO
  // steps at the SAME offset_day (premium `t-60.email` + `t-60.task.phone_
  // call`; partnership `t-90.email` + `t-90.task.meeting_proposed`). They
  // are EQUALLY due — there is no reason to serialise them across passes.
  // The old one-step-per-pass logic fired only the most-recent and deferred
  // the sibling to the next pass; on the LAST window day the sibling would
  // slide below the lookback the next day → PERMANENTLY DROPPED (an admin
  // escalation task never created). We co-resolve: fire EVERY unfired step
  // sharing the primary step's due-day this pass.
  //
  // Scope: co-resolution runs only on the CATCH-UP path (`hasOverdueStep`)
  // where we already paid for `firedKeys`. On the hot today-exactly path a
  // same-target sibling is NOT a permanent drop (it fires next pass, which
  // is then a catch-up pass), so we keep the single-fire hot path (063 #4).
  const primaryTargetDay = stepDueDayUtcOf(primaryStep);
  const stepsToFire: ReminderStep[] = hasOverdueStep
    ? windowSteps.filter(
        (s) =>
          stepDueDayUtcOf(s) === primaryTargetDay &&
          (s === primaryStep ||
            !firedKeys.has(`${s.stepId}::${stepYearInCycleOf(s)}`)),
      )
    : [primaryStep];

  // Gate 10 — 7-day pause after admin outreach (FR-033). Per-CYCLE (member-
  // level) decision — run ONCE for the whole cycle before firing any step.
  const pauseResult = await pauseRemindersAfterOutreach(deps, {
    tenantId: ctx.tenantId,
    memberId: member.memberId,
  });
  if (!pauseResult.ok) {
    // J2-B6: pause-check returned err Result (Zod parse fail or
    // repo fault). Without this guard the previous code silently
    // fell through and dispatched the email — direct FR-033
    // violation (system reminder collides with admin's logged
    // outreach). Defensive: emit `renewal_reminder_skipped` with
    // `tenant_misconfigured` reason + structured metadata so ops
    // can triage. logger.error elevates this above other skips
    // because the input shape was rejected by our internal Zod
    // schema, indicating a real bug or schema drift upstream.
    logger.error(
      {
        cycleId: cycle.cycleId,
        memberId: member.memberId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        errKind: pauseResult.error.kind,
        errMessage: pauseResult.error.message,
      },
      'dispatchOneCycleInner: pause-check returned err — defensive skip to preserve FR-033 invariant',
    );
    await emitSkipAudit(deps, candidate, ctx, 'tenant_misconfigured', {
      gate: 'outreach_pause_check',
      err_kind: pauseResult.error.kind,
      step_id: primaryStep.stepId,
    });
    return { kind: 'skipped', reason: 'tenant_misconfigured' };
  }
  if (pauseResult.value.paused) {
    await emitSkipAudit(deps, candidate, ctx, 'outreach_in_progress', {
      latest_outreach_at: pauseResult.value.latestOutreachAt,
      expires_at: pauseResult.value.expiresAt,
      step_id: primaryStep.stepId,
    });
    return {
      kind: 'skipped',
      reason: 'outreach_in_progress',
      metadata: { latest_outreach_at: pauseResult.value.latestOutreachAt },
    };
  }

  // Fire each co-resolved step (Gates 9, 11, 12 + channel dispatch are
  // per-STEP). `dispatchOneCycle` returns a SINGLE outcome (the PRIMARY
  // step's — typically the most-recent / email); any same-target sibling
  // (typically the admin-escalation task) is fired as a fully-persisted
  // side-effect (its reminder_event row + escalation_task + audit ARE
  // written), but is NOT separately tallied in the cron summary counters.
  // This keeps the single-outcome contract (no blast radius on
  // `sendReminderNow` / the admin toast / the coordinator switch) while
  // guaranteeing neither same-target step is permanently dropped (063 #5).
  // Co-resolution is a rare path (only premium/partnership same-offset pairs
  // on a catch-up day), so the summary undercount is bounded + documented.
  let primaryOutcome: DispatchOneCycleOutcome | undefined;
  for (const step of stepsToFire) {
    const outcome = await fireStep(deps, candidate, ctx, {
      step,
      stepYearInCycle: stepYearInCycleOf(step),
      yearInCycleRunDate: yearInCycle,
      caughtUp: stepDueDayUtcOf(step) < todayUtcDay,
      stepDueDateIso: new Date(stepDueDayUtcOf(step) * MS_PER_DAY).toISOString(),
    });
    if (step === primaryStep) primaryOutcome = outcome;
  }
  // `primaryStep` is always a member of `stepsToFire`, so `primaryOutcome`
  // is always assigned. The fallback satisfies the type checker.
  return (
    primaryOutcome ?? { kind: 'skipped', reason: 'already_sent' }
  );
}

// ---------------------------------------------------------------------------
// Per-step fire — Gates 9 (multi-year), 11 (no primary contact), 12
// (idempotency) + the channel dispatch. Extracted so the cycle-level
// decision tree can co-resolve same-offsetDay step pairs (063 #5) by
// calling this once per step that shares the primary step's due-day.
// ---------------------------------------------------------------------------

interface FireStepArgs {
  readonly step: ReminderStep;
  /**
   * 063 #1 — STEP-anchored year_in_cycle (derived from the step's DUE-date)
   * — the idempotency namespace for Gate-12 `insertIfAbsent` + the
   * reminder_event / task `year_in_cycle`. Defends against a cross-quota-
   * year double-send when a catch-up step's due-date was in the prior year.
   */
  readonly stepYearInCycle: number;
  /**
   * Run-date `year_in_cycle` (cycle position). Used by Gate 9 (multi-year
   * final-year gate) — that gate asks "are we BEFORE the final year of the
   * multi-year cycle NOW?", which is genuinely a run-date question (an email
   * step's due-date always sits in the final year, so a step-anchored year
   * would defeat the gate). Kept distinct from `stepYearInCycle` on purpose.
   */
  readonly yearInCycleRunDate: number;
  readonly caughtUp: boolean;
  readonly stepDueDateIso: string;
}

async function fireStep(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
  args: FireStepArgs,
): Promise<DispatchOneCycleOutcome> {
  const { cycle, member, primaryContact } = candidate;
  const { step, stepYearInCycle, yearInCycleRunDate } = args;
  // Gate 9 — multi-year non-final year for email steps (Q4 / FR-010).
  const cycleYears = computeCycleYears(cycle.cycleLengthMonths);
  if (
    step.channel === 'email' &&
    cycleYears > 1 &&
    yearInCycleRunDate < cycleYears
  ) {
    await emitSkipAudit(deps, candidate, ctx, 'multi_year_non_final_year', {
      year_in_cycle: yearInCycleRunDate,
      cycle_years: cycleYears,
      step_id: step.stepId,
    });
    return { kind: 'skipped', reason: 'multi_year_non_final_year' };
  }
  // Gate 11 — email step + no primary contact (FR-019a graceful skip).
  if (step.channel === 'email' && primaryContact === null) {
    // Idempotently create a manual_outreach_required escalation task
    // so admin sees the queue. transitions inside a tx because we
    // also emit `escalation_task_created` + `renewal_reminder_skipped`
    // atomically (Principle VIII).
    return runInTenant(deps.tenant, async (tx) => {
      const taskId = asTaskId(randomUUID());
      const dueAt = new Date(ctx.nowIso).toISOString();
      const insert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
        tenantId: ctx.tenantId,
        taskId,
        memberId: member.memberId,
        cycleId: cycle.cycleId,
        taskType: 'manual_outreach_required',
        assignedToRole: 'admin',
        dueAt,
      });
      if (insert.created) {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_created',
            payload: {
              task_id: insert.row.taskId,
              task_type: 'manual_outreach_required',
              member_id: member.memberId as MemberId,
              cycle_id: cycle.cycleId,
              trigger_reason: 'no_primary_contact',
              step_id: step.stepId,
            },
          },
          {
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            summary: `manual_outreach_required task created for member ${member.memberId} (no primary contact)`,
          },
        );
      }
      // Always emit the skipped audit, even when the task was already
      // open (idempotency replay) — caller still wants the cron-pass
      // record.
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_reminder_skipped',
          payload: {
            cycle_id: cycle.cycleId,
            member_id: member.memberId as MemberId,
            reason: 'no_primary_contact',
            step_id: step.stepId,
            escalation_task_id: insert.row.taskId,
          },
        },
        {
          tenantId: ctx.tenantId,
          actorUserId: ctx.actorUserId,
          actorRole: ctx.actorRole,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        },
      );
      return {
        kind: 'skipped',
        reason: 'no_primary_contact',
        metadata: { escalation_task_id: insert.row.taskId },
      } satisfies DispatchOneCycleOutcome;
    });
  }
  // Gate 12 — idempotency. Insert reminder_event with status=pending.
  // If the unique idem index already has a row, `created=false` and
  // we treat the dispatch as a replay (no audit, no gateway call).
  // 063 #1 — the idempotency `yearInCycle` is the STEP-anchored year so a
  // catch-up pass on a cross-quota-year step resolves to the SAME (cycle,
  // step, year) the original send recorded → unique conflict → no duplicate.
  const reminderInsert = await runInTenant(deps.tenant, (tx) =>
    deps.reminderEventRepo.insertIfAbsent(tx, {
      tenantId: ctx.tenantId,
      cycleId: asCycleId(cycle.cycleId),
      stepId: step.stepId,
      yearInCycle: stepYearInCycle,
      channel: step.channel,
      ...(step.channel === 'email'
        ? { templateId: step.templateId }
        : { taskType: step.taskType }),
      ...(ctx.actorUserId !== null ? { actorUserId: ctx.actorUserId } : {}),
    }),
  );
  if (!reminderInsert.created) {
    return {
      kind: 'skipped',
      reason: 'already_sent',
      metadata: {
        existing_reminder_event_id: reminderInsert.row.reminderEventId,
        existing_dispatched_at: reminderInsert.row.dispatchedAt,
      },
    };
  }
  // Channel branch — email vs task. J2-B2: wrap both branches in a
  // try/catch + defensive cleanup. Any uncaught throw between the
  // `insertIfAbsent` above (row now at status='pending') and the
  // success-path `transitionStatus` would leave the row orphaned —
  // retry-pass filters `status='failed'`, dispatcher skips via
  // `already_sent`, so a 'pending' row never gets touched again.
  // `defensivelyMarkFailedForRetry` opens a fresh tx to flip
  // pending → failed with `retry_until = now+24h` so the retry pass
  // picks it up. Constitution Principle VIII state↔audit atomicity
  // preserved (the cleanup tx writes BOTH the status flip + the
  // `renewal_reminder_send_failed` audit in the same tx).
  const reminderEventId = reminderInsert.row.reminderEventId;
  // 063 — catch-up marker threaded into the success-path audit so the
  // forensic trail distinguishes an on-time send from a recovered one.
  const catchUp: CatchUpInfo = {
    caughtUp: args.caughtUp,
    stepDueDate: args.stepDueDateIso,
  };
  try {
    if (step.channel === 'email') {
      return await dispatchEmailStep(deps, candidate, ctx, step, reminderEventId, catchUp);
    }
    // Task channel — the `year_in_cycle` recorded on the audit is the
    // STEP-anchored year (063 #1) so it matches the reminder_event row.
    return await dispatchTaskStep(deps, candidate, ctx, step, reminderEventId, stepYearInCycle, catchUp);
  } catch (e) {
    return await defensivelyMarkFailedForRetry(
      deps,
      candidate,
      ctx,
      step,
      reminderEventId,
      e,
    );
  }
}

// ---------------------------------------------------------------------------
// J2-B2 — defensive cleanup for orphan pending rows
// ---------------------------------------------------------------------------

/**
 * Defensively transition a pending reminder_event row to `failed`
 * with `retry_until = now+24h` after the dispatcher crashed mid-flight
 * (gateway exception, inner-tx fault, etc). Ensures the row enters the
 * retry-pass queue rather than orphaning at `pending` forever.
 *
 * Contract: best-effort cleanup. If the cleanup tx itself fails (rare —
 * Neon connectivity loss), we log at error level and rely on the
 * exhaustion sweep (Wave I2e Pass 2) to eventually mark the row
 * permanently failed once retry_until expires.
 */
async function defensivelyMarkFailedForRetry(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
  dueStep: ReminderStep,
  reminderEventId: string,
  origError: unknown,
): Promise<DispatchOneCycleOutcome> {
  const { cycle, member } = candidate;
  const errMsg =
    origError instanceof Error ? origError.message : String(origError);
  const stack = origError instanceof Error ? origError.stack : undefined;
  const truncatedMsg = errMsg.slice(0, 400);
  const failureReason = `dispatcher_crash: ${truncatedMsg}`;
  const retryUntilIso = new Date(
    new Date(ctx.nowIso).getTime() + RETRY_BUDGET_HOURS * 60 * 60 * 1000,
  ).toISOString();

  logger.error(
    {
      err: errMsg,
      stack,
      cycleId: cycle.cycleId,
      memberId: member.memberId,
      reminderEventId,
      stepId: dueStep.stepId,
      channel: dueStep.channel,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
    },
    'dispatchOneCycle: dispatcher crashed mid-flight — defensively transitioning pending row to failed for retry pickup',
  );

  try {
    await runInTenant(deps.tenant, async (tx) => {
      try {
        await deps.reminderEventRepo.transitionStatus(tx, {
          tenantId: ctx.tenantId,
          reminderEventId,
          nextStatus: 'failed',
          failureReason,
          retryUntil: retryUntilIso,
        });
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_reminder_send_failed',
            payload: {
              cycle_id: cycle.cycleId,
              member_id: member.memberId as MemberId,
              step_id: dueStep.stepId,
              channel: dueStep.channel,
              template_id:
                dueStep.channel === 'email' ? dueStep.templateId : null,
              failure_kind: 'dispatcher_crash',
              failure_message: truncatedMsg,
            },
          },
          {
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            summary: `Dispatcher crashed for ${member.companyName} (${dueStep.stepId}); row transitioned to failed for retry within 24h`,
          },
        );
      } catch (innerErr) {
        if (innerErr instanceof ReminderEventNotFoundError) {
          // Row was already transitioned by another path (concurrent
          // worker, or a partial inner-tx success that committed before
          // the throw). Idempotent — no audit emit, no second update.
          logger.info(
            {
              reminderEventId,
              cycleId: cycle.cycleId,
              correlationId: ctx.correlationId,
            },
            'defensivelyMarkFailedForRetry: row no longer pending — concurrent transition won',
          );
          return;
        }
        throw innerErr;
      }
    });
  } catch (cleanupErr) {
    logger.error(
      {
        err:
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
        origErr: errMsg,
        cycleId: cycle.cycleId,
        memberId: member.memberId,
        reminderEventId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
      },
      'defensivelyMarkFailedForRetry: cleanup tx itself failed — row may orphan as pending; exhaustion sweep will eventually mark permanent',
    );
  }

  return {
    kind: 'failed_transient',
    reminderEventId,
    reason: failureReason.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Email step dispatch — gateway call + transition + audit
// ---------------------------------------------------------------------------

async function dispatchEmailStep(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
  step: ReminderStep & { channel: 'email' },
  reminderEventId: string,
  catchUp: CatchUpInfo,
): Promise<DispatchOneCycleOutcome> {
  const { cycle, member, primaryContact } = candidate;
  // Type narrowing — Gate 11 already guarantees primaryContact !== null
  // for email steps. Defensive null-check for compile-time correctness.
  if (primaryContact === null) {
    throw new Error(
      `dispatchEmailStep invariant: primaryContact null reached email branch — gate 11 regression`,
    );
  }
  // Resolve recipient locale: contact's preferred_language wins over
  // member.preferred_locale (contact-level is more specific). Fallback
  // to 'en' when both are null.
  const locale = primaryContact.preferredLanguage ?? member.preferredLocale ?? 'en';

  // External gateway call — outside tx (non-transactional).
  const gatewayResult = await deps.renewalGateway.sendRenewalEmail({
    tenantId: ctx.tenantId,
    cycleId: asCycleId(cycle.cycleId),
    stepId: step.stepId,
    templateId: step.templateId,
    recipient: {
      memberId: member.memberId,
      toEmail: primaryContact.email,
      toName: `${primaryContact.firstName} ${primaryContact.lastName}`.trim(),
      preferredLocale: locale,
    },
    templateVariables: {
      member_first_name: primaryContact.firstName,
      member_company_name: member.companyName,
      cycle_expires_at: cycle.expiresAt,
      tier_bucket: cycle.tierAtCycleStart,
      step_id: step.stepId,
      // S1-P0-4 + go-live #8: signed-token redeem-link (auto-sign-in) when the
      // token will still be valid at expiry, else the authenticated renewal page
      // for early reminders (T-60/T-90) whose redeem-link would expire first.
      renewal_link_url: buildRenewalCtaUrl(deps.tokenSigner, env.app.baseUrl, {
        tenantId: ctx.tenantId,
        memberId: member.memberId,
        cycleId: cycle.cycleId,
        now: new Date(ctx.nowIso),
        expiresAtIso: cycle.expiresAt,
      }),
      // S1-P1-3: footer opt-out link target.
      preferences_url: `${env.app.baseUrl}/portal/preferences/renewals`,
    },
    idempotencyKey: reminderEventId,
  });

  // Persist outcome — transition reminder_event + audit emit, atomic.
  return runInTenant(deps.tenant, async (tx) => {
    if (gatewayResult.ok) {
      await deps.reminderEventRepo.transitionStatus(tx, {
        tenantId: ctx.tenantId,
        reminderEventId,
        nextStatus: 'sent',
        dispatchedAt: gatewayResult.value.dispatchedAt,
        deliveryId: gatewayResult.value.deliveryId,
      });
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_reminder_sent',
          payload: {
            cycle_id: cycle.cycleId,
            member_id: member.memberId as MemberId,
            step_id: step.stepId,
            channel: 'email',
            template_id: step.templateId,
            delivery_id: gatewayResult.value.deliveryId,
            recipient_locale: locale,
            // 063 catch-up provenance — true when a missed-cron day was
            // recovered within the bounded lookback (spec.md:194 FR-010).
            caught_up: catchUp.caughtUp,
            step_due_date: catchUp.stepDueDate,
          },
        },
        {
          tenantId: ctx.tenantId,
          actorUserId: ctx.actorUserId,
          actorRole: ctx.actorRole,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          summary: `Reminder sent to ${member.companyName} (${step.stepId})`,
        },
      );
      // Phase 9 / T231 — business-volume counter (FR-010 dispatcher
      // cadence dashboard). `tier_bucket` is bounded 5-value enum,
      // `offset_day` is bounded by tier-bucket schedule policy
      // (~6 distinct values across all 5 tiers). `caught_up` is boolean
      // (2-value) — cardinality stays bounded.
      renewalsMetrics.remindersSent(cycle.tierAtCycleStart, step.offsetDays, catchUp.caughtUp);
      return {
        kind: 'sent',
        reminderEventId,
        deliveryId: gatewayResult.value.deliveryId,
        dispatchedAt: gatewayResult.value.dispatchedAt,
      };
    }
    // Failure path. Classification policy lives in renewal-gateway.ts
    // (`isPermanentGatewayError`) so the dispatcher + retry use-case
    // share one source of truth (J12 S7).
    const err = gatewayResult.error;
    const isPermanent = isPermanentGatewayError(err);
    const failureReason =
      err.kind === 'gateway_5xx' || err.kind === 'gateway_4xx'
        ? err.message
        : err.kind;
    // Wave I2e — FR-010a: transient failures get a 24h retry budget;
    // permanent failures get NULL (never re-attempted).
    const retryUntilIso = isPermanent
      ? null
      : new Date(
          new Date(ctx.nowIso).getTime() + RETRY_BUDGET_HOURS * 60 * 60 * 1000,
        ).toISOString();
    await deps.reminderEventRepo.transitionStatus(tx, {
      tenantId: ctx.tenantId,
      reminderEventId,
      nextStatus: 'failed',
      failureReason,
      retryUntil: retryUntilIso,
    });
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: isPermanent
          ? 'renewal_reminder_send_failed_permanent'
          : 'renewal_reminder_send_failed',
        payload: {
          cycle_id: cycle.cycleId,
          member_id: member.memberId as MemberId,
          step_id: step.stepId,
          channel: 'email',
          template_id: step.templateId,
          failure_kind: err.kind,
          failure_message: failureReason,
        },
      },
      {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        summary: `Reminder send ${isPermanent ? 'permanently failed' : 'failed (transient)'} for ${member.companyName} (${step.stepId})`,
      },
    );
    logger.warn(
      {
        cycleId: cycle.cycleId,
        memberId: member.memberId,
        stepId: step.stepId,
        failureKind: err.kind,
        failureMessage: failureReason,
        permanent: isPermanent,
      },
      'dispatchOneCycle: gateway send failed',
    );
    // Phase 9 / T231 — business-volume counter (FR-010a retry-budget
    // path). `err.kind` is the bounded `SendRenewalEmailError['kind']`
    // union — cardinality bounded by gateway error taxonomy.
    renewalsMetrics.remindersFailed(err.kind);
    return isPermanent
      ? {
          kind: 'failed_permanent' as const,
          reminderEventId,
          reason: failureReason,
        }
      : {
          kind: 'failed_transient' as const,
          reminderEventId,
          reason: failureReason,
        };
  });
}

// ---------------------------------------------------------------------------
// Task step dispatch — escalation_task creation + transition + audit
// ---------------------------------------------------------------------------

async function dispatchTaskStep(
  deps: RenewalsDeps,
  candidate: DispatchCandidate,
  ctx: DispatchContext,
  step: ReminderStep & { channel: 'task' },
  reminderEventId: string,
  yearInCycle: number,
  catchUp: CatchUpInfo,
): Promise<DispatchOneCycleOutcome> {
  const { cycle, member } = candidate;
  return runInTenant(deps.tenant, async (tx) => {
    const taskId = asTaskId(randomUUID());
    const insert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
      tenantId: ctx.tenantId,
      taskId,
      memberId: member.memberId,
      cycleId: cycle.cycleId,
      taskType: step.taskType,
      assignedToRole: step.assigneeRole,
      // Due date: today (cron run date). Admin queue surface (Wave I8)
      // shows overdue tasks via dueAt < NOW() filter.
      dueAt: new Date(ctx.nowIso).toISOString(),
    });
    // Transition reminder_event to `sent` (task-channel "sent" =
    // "task created" — there's no separate `task_created` reminder
    // status; the channel field disambiguates).
    await deps.reminderEventRepo.transitionStatus(tx, {
      tenantId: ctx.tenantId,
      reminderEventId,
      nextStatus: 'sent',
      dispatchedAt: ctx.nowIso,
    });
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'escalation_task_created',
        payload: {
          task_id: insert.row.taskId,
          task_type: step.taskType,
          member_id: member.memberId as MemberId,
          cycle_id: cycle.cycleId,
          year_in_cycle: yearInCycle,
          step_id: step.stepId,
          assignee_role: step.assigneeRole,
          idempotent_replay: !insert.created,
          // 063 catch-up provenance for task-channel steps.
          caught_up: catchUp.caughtUp,
          step_due_date: catchUp.stepDueDate,
        },
      },
      {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        summary: `Escalation task ${step.taskType} created for ${member.companyName} (year ${yearInCycle}/${computeCycleYears(cycle.cycleLengthMonths)})`,
      },
    );
    return {
      kind: 'task_created',
      taskId: insert.row.taskId,
      taskType: step.taskType,
      reminderEventId,
    };
  });
}
