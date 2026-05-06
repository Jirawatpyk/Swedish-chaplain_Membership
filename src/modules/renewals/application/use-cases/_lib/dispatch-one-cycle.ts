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
 * Private file (`_lib/`) — NOT exported via the F8 barrel.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../../infrastructure/renewals-deps';
import { findStepForDate } from '../../../domain/tenant-renewal-schedule-policy';
import { asCycleId } from '../../../domain/renewal-cycle';
import { asTaskId } from '../../../domain/renewal-escalation-task';
import type {
  ReminderStep,
} from '../../../domain/value-objects/reminder-step';
import type { DispatchCandidate } from '../../ports/dispatch-candidate-repo';
import { ReminderEventNotFoundError } from '../../ports/renewal-reminder-event-repo';
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
 * J9-M17 — closed set of gateway-error classifiers used by the audit
 * emit (`failure_kind` field on `renewal_reminder_send_failed` /
 * `renewal_reminder_send_failed_permanent`). Mirrors
 * `SendRenewalEmailError.kind` plus `dispatcher_crash` (J2-B2 synthetic
 * for uncaught throws). Forensic queries on `failure_kind` rely on
 * this closed set; previously the audit shape had `failure_kind: string`
 * which would silently accept typos like `'gateway_500'`.
 *
 * Outcome.reason still carries free-form text (provider error message)
 * because the legacy wire format mixes literal-kind + message text in
 * the same field — splitting that would be a contract break for
 * downstream toast UI strings.
 */
export type DispatchFailureKind =
  | 'gateway_5xx'
  | 'gateway_4xx'
  | 'recipient_unsubscribed'
  | 'recipient_email_unverified'
  | 'template_variables_missing'
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
  const { cycle, member, primaryContact, schedulePolicy } = candidate;

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
  // Gate 8 — step not due today (silent no-op; not an audit event).
  const dueStep: ReminderStep | null = findStepForDate(
    schedulePolicy,
    new Date(cycle.expiresAt),
    new Date(ctx.nowIso),
  );
  if (!dueStep) {
    return { kind: 'skipped', reason: 'not_due_today' };
  }
  // Gate 9 — multi-year non-final year for email steps (Q4 / FR-010).
  const yearInCycle = computeYearInCycle(cycle.periodFrom, ctx.nowIso);
  const cycleYears = computeCycleYears(cycle.cycleLengthMonths);
  if (
    dueStep.channel === 'email' &&
    cycleYears > 1 &&
    yearInCycle < cycleYears
  ) {
    await emitSkipAudit(deps, candidate, ctx, 'multi_year_non_final_year', {
      year_in_cycle: yearInCycle,
      cycle_years: cycleYears,
      step_id: dueStep.stepId,
    });
    return { kind: 'skipped', reason: 'multi_year_non_final_year' };
  }
  // Gate 10 — 7-day pause after admin outreach (FR-033).
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
      step_id: dueStep.stepId,
    });
    return { kind: 'skipped', reason: 'tenant_misconfigured' };
  }
  if (pauseResult.value.paused) {
    await emitSkipAudit(deps, candidate, ctx, 'outreach_in_progress', {
      latest_outreach_at: pauseResult.value.latestOutreachAt,
      expires_at: pauseResult.value.expiresAt,
      step_id: dueStep.stepId,
    });
    return {
      kind: 'skipped',
      reason: 'outreach_in_progress',
      metadata: { latest_outreach_at: pauseResult.value.latestOutreachAt },
    };
  }
  // Gate 11 — email step + no primary contact (FR-019a graceful skip).
  if (dueStep.channel === 'email' && primaryContact === null) {
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
              step_id: dueStep.stepId,
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
            step_id: dueStep.stepId,
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
  const reminderInsert = await runInTenant(deps.tenant, (tx) =>
    deps.reminderEventRepo.insertIfAbsent(tx, {
      tenantId: ctx.tenantId,
      cycleId: asCycleId(cycle.cycleId),
      stepId: dueStep.stepId,
      yearInCycle,
      channel: dueStep.channel,
      ...(dueStep.channel === 'email'
        ? { templateId: dueStep.templateId }
        : { taskType: dueStep.taskType }),
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
  try {
    if (dueStep.channel === 'email') {
      return await dispatchEmailStep(deps, candidate, ctx, dueStep, reminderEventId);
    }
    return await dispatchTaskStep(deps, candidate, ctx, dueStep, reminderEventId, yearInCycle);
  } catch (e) {
    return await defensivelyMarkFailedForRetry(
      deps,
      candidate,
      ctx,
      dueStep,
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
      // J1-B1: populate CTA target. Uses the member portal landing
      // (`/portal/account`) until the signed-token renewal route lands;
      // a blank href would leave every dispatched email with a broken
      // CTA button, defeating the reminder's primary purpose.
      renewal_link_url: `${env.app.baseUrl}/portal/account`,
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
      return {
        kind: 'sent',
        reminderEventId,
        deliveryId: gatewayResult.value.deliveryId,
        dispatchedAt: gatewayResult.value.dispatchedAt,
      };
    }
    // Failure path. 4xx = permanent, 5xx + recipient-unsubscribed/unverified = boundary cases.
    const err = gatewayResult.error;
    const isPermanent =
      err.kind === 'gateway_4xx' ||
      err.kind === 'recipient_unsubscribed' ||
      err.kind === 'recipient_email_unverified' ||
      err.kind === 'template_variables_missing';
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
