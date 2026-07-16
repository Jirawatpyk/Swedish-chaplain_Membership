/**
 * 066 Round-2 §3.2(2) — per-cycle DUE-TRACK dispatch.
 *
 * A deliberately thin sibling of `dispatchOneCycle` for the two code-const
 * due-anchored warning steps (`due+7.email` / `due+30.email`). Reuses the
 * SAME primitives — Gate-12 `insertIfAbsent` idempotency, the
 * `dispatchEmailStep` send/transition/audit tail, `emitSkipAudit`, and the
 * `defensivelyMarkFailedForRetry` crash net — so the forensic trail
 * (`renewal_reminder_sent` / `renewal_reminder_skipped` / failure events)
 * and the retry pass treat due-track events identically to ladder events.
 *
 * Gate differences vs the ladder (each is a design §3.2(2) decision):
 *  - Gate 5 (`renewalRemindersOptedOut`) is BYPASSED — these are
 *    contractual/bylaw dunning notices, not marketing (FR-016 scope).
 *  - Gate 7 (schedule policy) does not apply — the track is tier-less and
 *    code-defined; a tenant cannot delete it (the §3.2(3) dormancy guard
 *    depends on these steps existing).
 *  - NO 7-day staleness window — a due step stays fireable until sent
 *    (`findDueTrackStepsDue` has no upper bound; the guard blocks
 *    termination until the warning exists, so a late warning is still a
 *    pre-termination warning).
 *  - No-spam policy preserved: only the MOST-SEVERE unsent due step fires
 *    per pass (mirror of Gate 8's one-due-day-per-pass rule). A cold start
 *    on a bill already 30+ days past due sends ONLY `due+30.email`; the
 *    gentle `due+7.email` is superseded, never sent after the firm one.
 * Gates kept: feature flag, read-only, cycle re-check, member archived,
 * no_joined_at, email_unverified, unreconciled-invoice (Gate 7.5),
 * no_primary_contact.
 */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import type { RenewalsDeps } from '../../../infrastructure/renewals-deps';
import { asCycleId } from '../../../domain/renewal-cycle';
import { findDueTrackStepsDue } from '../../../domain/due-track';
import type { ReminderStepEmail } from '../../../domain/value-objects/reminder-step';
import type { DueTrackCandidate } from '../../ports/dispatch-candidate-repo';
import {
  computeYearInCycle,
  dispatchEmailStep,
  defensivelyMarkFailedForRetry,
  emitSkipAudit,
  type CatchUpInfo,
  type DispatchContext,
  type DispatchOneCycleOutcome,
} from './dispatch-one-cycle';
import { pauseRemindersAfterOutreach } from '../pause-reminders-after-outreach';

const MS_PER_DAY = 86_400_000;

/**
 * Sentinel `templateId` for due-track reminder events. The email gateway
 * routes on the `due+N.email` step id (its due-track branch) and never
 * parses a tier out of this value; it lands on the reminder_event row +
 * the `renewal_reminder_sent` audit payload as the track's provenance
 * marker.
 */
export const DUE_TRACK_TEMPLATE_ID = 'due-track';

export async function dispatchDueTrackCycle(
  deps: RenewalsDeps,
  candidate: DueTrackCandidate,
  ctx: DispatchContext,
): Promise<DispatchOneCycleOutcome> {
  const { cycle, member, primaryContact } = candidate;

  // Gate 1 — feature flag (same flag as the ladder; the due track is part
  // of the F8 dispatcher).
  if (!env.features.f8Renewals) {
    return { kind: 'skipped', reason: 'feature_flag_disabled' };
  }
  // Gate 2 — read-only mode.
  if (env.flags.readOnlyMode) {
    await emitSkipAudit(deps, candidate, ctx, 'read_only_mode');
    return { kind: 'skipped', reason: 'read_only_mode' };
  }
  // Gate 3 — the candidate query only selects `awaiting_payment`, but the
  // page is read outside any lock; re-check defensively.
  if (cycle.status !== 'awaiting_payment') {
    await emitSkipAudit(deps, candidate, ctx, 'cycle_terminal');
    return { kind: 'skipped', reason: 'cycle_terminal' };
  }
  // Gate 4 — member archived.
  if (member.status === 'archived') {
    await emitSkipAudit(deps, candidate, ctx, 'member_archived');
    return { kind: 'skipped', reason: 'member_archived' };
  }
  // Gate 4.5 — data-hygiene backstop (parity with the ladder).
  if (!member.registrationDate || member.registrationDate.length === 0) {
    await emitSkipAudit(deps, candidate, ctx, 'no_joined_at');
    return { kind: 'skipped', reason: 'no_joined_at' };
  }
  // Gate 5 — DELIBERATELY ABSENT (opt-out bypass; see module docblock).
  // Gate 6 — email unverified: we cannot dunning-email an unverified
  // address; the member stays suspended (dormancy guard defers) and the
  // lapse route's escalation task makes the blocked cohort admin-visible.
  if (member.emailUnverified) {
    await emitSkipAudit(deps, candidate, ctx, 'email_unverified');
    return { kind: 'skipped', reason: 'email_unverified' };
  }
  // Gate 7.5 — unreconciled paid membership invoice: the "unpaid" bill
  // anchoring this track may in fact be PAID but not yet reconciled onto
  // the cycle — dunning on it would be wrong AND loud staff alarm applies
  // (same operational-alarm semantics as the ladder's Gate 7.5).
  if (ctx.unreconciledMemberIds.has(member.memberId)) {
    logger.error(
      {
        cycleId: cycle.cycleId,
        memberId: member.memberId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
      },
      'dispatchDueTrackCycle: member has an unreconciled paid membership invoice — skipping due-track dunning, staff must reconcile',
    );
    await emitSkipAudit(deps, candidate, ctx, 'unreconciled_paid_membership_invoice');
    return { kind: 'skipped', reason: 'unreconciled_paid_membership_invoice' };
  }
  // Gate 10 — 7-day pause after admin outreach (FR-033; T4-review M2).
  // Applies to the due track too: a dunning email colliding with an
  // admin's logged personal outreach damages trust, and delaying it is
  // termination-safe (the §3.2(3) dormancy guard blocks the terminate
  // until the warning eventually lands).
  const pauseResult = await pauseRemindersAfterOutreach(deps, {
    tenantId: ctx.tenantId,
    memberId: member.memberId,
  });
  if (!pauseResult.ok) {
    logger.error(
      {
        cycleId: cycle.cycleId,
        memberId: member.memberId,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        errKind: pauseResult.error.kind,
        errMessage: pauseResult.error.message,
      },
      'dispatchDueTrackCycle: pause-check returned err — defensive skip to preserve FR-033 invariant',
    );
    await emitSkipAudit(deps, candidate, ctx, 'tenant_misconfigured', {
      gate: 'outreach_pause_check',
      err_kind: pauseResult.error.kind,
    });
    return { kind: 'skipped', reason: 'tenant_misconfigured' };
  }
  if (pauseResult.value.paused) {
    await emitSkipAudit(deps, candidate, ctx, 'outreach_in_progress', {
      latest_outreach_at: pauseResult.value.latestOutreachAt,
      expires_at: pauseResult.value.expiresAt,
    });
    return {
      kind: 'skipped',
      reason: 'outreach_in_progress',
      metadata: { latest_outreach_at: pauseResult.value.latestOutreachAt },
    };
  }
  // Gate 11 — no primary contact: nothing to email. No escalation task
  // here (unlike the ladder's fireStep) — the dormancy guard defers the
  // termination and the lapse route creates the admin-visible
  // `termination_warning_blocked` task for exactly this cohort.
  if (primaryContact === null) {
    await emitSkipAudit(deps, candidate, ctx, 'no_primary_contact');
    return { kind: 'skipped', reason: 'no_primary_contact' };
  }

  // Step resolution — most-severe unsent step per pass (see docblock).
  const dueSteps = findDueTrackStepsDue(candidate.billDueDate, ctx.nowIso);
  const step = dueSteps[dueSteps.length - 1];
  if (!step) {
    return { kind: 'skipped', reason: 'not_due_today' };
  }
  const stepDueMs =
    Date.parse(`${candidate.billDueDate}T00:00:00.000Z`) +
    step.offsetDays * MS_PER_DAY;
  const stepDueIso = new Date(stepDueMs).toISOString();
  // Idempotency year = the STEP's own due-day year (the 063 #1 lesson) —
  // stable across run dates and >365d-stuck cycles.
  const stepYearInCycle = computeYearInCycle(cycle.periodFrom, stepDueIso);

  // Gate 12 — idempotency (same unique index + replay semantics as the
  // ladder).
  const reminderInsert = await runInTenant(deps.tenant, (tx) =>
    deps.reminderEventRepo.insertIfAbsent(tx, {
      tenantId: ctx.tenantId,
      cycleId: asCycleId(cycle.cycleId),
      stepId: step.stepId,
      yearInCycle: stepYearInCycle,
      channel: 'email',
      templateId: DUE_TRACK_TEMPLATE_ID,
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
  const reminderEventId = reminderInsert.row.reminderEventId;
  const emailStep: ReminderStepEmail = {
    stepId: step.stepId,
    offsetDays: step.offsetDays,
    channel: 'email',
    templateId: DUE_TRACK_TEMPLATE_ID,
  };
  const catchUp: CatchUpInfo = {
    // A due step fired after its due-day is a recovered send (the track is
    // staleness-exempt, so this is routine after any cron gap).
    caughtUp: Date.parse(ctx.nowIso) - stepDueMs >= MS_PER_DAY,
    stepDueDate: stepDueIso,
  };
  try {
    return await dispatchEmailStep(
      deps,
      candidate,
      ctx,
      emailStep,
      reminderEventId,
      catchUp,
    );
  } catch (e) {
    return await defensivelyMarkFailedForRetry(
      deps,
      candidate,
      ctx,
      emailStep,
      reminderEventId,
      e,
    );
  }
}
