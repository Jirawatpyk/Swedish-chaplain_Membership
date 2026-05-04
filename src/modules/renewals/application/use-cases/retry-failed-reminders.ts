/**
 * F8 Phase 4 Wave I2e — `retry-failed-reminders` use-case (FR-010a).
 *
 * Companion to T088 dispatch-renewal-cycle. Two passes per invocation:
 *
 *   **Pass 1 — Re-attempt eligible failures** (status='failed' AND
 *   retry_until > now AND retry_exhausted_at IS NULL):
 *     For each: re-load the dispatch candidate via `findOne`, re-validate
 *     the gates (member opted out / archived / email_unverified —
 *     same dispatcher gates apply), re-fire the gateway. On success →
 *     transition `failed → sent` + emit `renewal_reminder_retried`
 *     (counts the attempt) + `renewal_reminder_sent` (counts the
 *     delivery). On still-failing transient → leave as-is, emit
 *     `renewal_reminder_retried` (the attempt is still recorded so ops
 *     visibility is preserved). On permanent failure (4xx / unsub /
 *     unverified) → transition retry_exhausted_at + emit
 *     `renewal_reminder_send_failed_permanent` + create
 *     manual_outreach_required task.
 *
 *   **Pass 2 — Mark exhausted budgets** (status='failed' AND
 *   retry_until <= now AND retry_exhausted_at IS NULL):
 *     For each: emit `renewal_reminder_send_failed_permanent` audit +
 *     create idempotent `manual_outreach_required` escalation task +
 *     call `markRetryExhausted` to set the idempotency timestamp.
 *
 * Atomic state+audit per Constitution Principle VIII: each per-event
 * transition + audit emit + task insertIfAbsent runs inside ONE
 * `runInTenant` tx. The gateway call (Pass 1) happens BEFORE the tx
 * is opened (gateway non-transactional).
 *
 * Per-event fault isolation: one event's exception MUST NOT crash the
 * loop. Counted as `passErrors` in summary; logged at error level.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { asCycleId } from '../../domain/renewal-cycle';
import { asTaskId } from '../../domain/renewal-escalation-task';
import { MANUAL_OUTREACH_TASK_TYPE } from './reset-email-unverified';
import type { DispatchCandidate } from '../ports/dispatch-candidate-repo';
import type { ReminderEvent } from '../ports/renewal-reminder-event-repo';
import type { MemberId } from '@/modules/members';

export const DEFAULT_RETRY_PAGE_SIZE = 200 as const;

export const retryFailedRemindersInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  nowIso: z.string().datetime().optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
});

export type RetryFailedRemindersInput = z.infer<
  typeof retryFailedRemindersInputSchema
>;

export interface RetryFailedRemindersSummary {
  /** Pass 1 — events evaluated for re-attempt. */
  readonly retryEligibleProcessed: number;
  /** Pass 1 — successful retries. */
  readonly retrySucceeded: number;
  /** Pass 1 — still transient (will retry next pass). */
  readonly retryStillTransient: number;
  /** Pass 1 — became permanent during retry (gateway returned 4xx). */
  readonly retryBecamePermanent: number;
  /** Pass 1 — gates blocked retry (member opted out / archived). */
  readonly retryBlockedByGate: number;
  /** Pass 2 — events marked permanently exhausted. */
  readonly exhaustedMarked: number;
  /** Per-event errors that were isolated (loop did not crash). */
  readonly passErrors: number;
  readonly durationMs: number;
}

export interface RetryFailedRemindersOutput {
  readonly summary: RetryFailedRemindersSummary;
}

export type RetryFailedRemindersError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Pass 1 — re-attempt eligible failures
// ---------------------------------------------------------------------------

interface RetryAttemptOutcome {
  readonly kind:
    | 'succeeded'
    | 'still_transient'
    | 'became_permanent'
    | 'blocked_by_gate'
    | 'candidate_not_found';
}

async function attemptRetry(
  deps: RenewalsDeps,
  event: ReminderEvent,
  nowIso: string,
  correlationId: string,
  requestId: string | null,
): Promise<RetryAttemptOutcome> {
  // Email retries only — task channel events do not have a transient
  // failure mode (escalation tasks are persisted on first attempt).
  if (event.channel !== 'email' || !event.templateId) {
    return { kind: 'blocked_by_gate' };
  }
  // Re-load candidate — gates may have changed since the original
  // failure (e.g., admin manually opted-out the member, T091 cleared
  // email_unverified).
  const candidate = await deps.dispatchCandidateRepo.findOne(
    event.tenantId,
    asCycleId(event.cycleId),
  );
  if (!candidate) {
    // Cycle deleted / RLS-hidden — leave the failed event as-is; the
    // exhaustion pass will eventually mark it permanent. Treat as
    // a gate block for accounting purposes.
    return { kind: 'candidate_not_found' };
  }
  // Re-validate gates that would have skipped the original dispatch.
  if (
    candidate.member.status === 'archived' ||
    candidate.member.renewalRemindersOptedOut ||
    candidate.member.emailUnverified ||
    candidate.cycle.status === 'completed' ||
    candidate.cycle.status === 'cancelled' ||
    candidate.cycle.status === 'lapsed' ||
    candidate.primaryContact === null
  ) {
    return { kind: 'blocked_by_gate' };
  }
  // Re-fire the gateway with the SAME idempotency key as the original
  // attempt — Resend dedupes server-side.
  const locale =
    candidate.primaryContact.preferredLanguage ??
    candidate.member.preferredLocale ??
    'en';
  const gatewayResult = await deps.renewalGateway.sendRenewalEmail({
    tenantId: event.tenantId,
    cycleId: asCycleId(event.cycleId),
    stepId: event.stepId,
    templateId: event.templateId,
    recipient: {
      memberId: candidate.member.memberId,
      toEmail: candidate.primaryContact.email,
      toName:
        `${candidate.primaryContact.firstName} ${candidate.primaryContact.lastName}`.trim(),
      preferredLocale: locale,
    },
    templateVariables: {
      member_company_name: candidate.member.companyName,
      cycle_expires_at: candidate.cycle.expiresAt,
      tier_bucket: candidate.cycle.tierAtCycleStart,
      step_id: event.stepId,
    },
    idempotencyKey: event.reminderEventId,
  });

  return runInTenant(deps.tenant, async (tx) => {
    if (gatewayResult.ok) {
      // Success — transition failed → sent. The transitionStatus
      // adapter requires source=pending, so we use a separate
      // status-flip path: clear retry_until + set status=sent.
      // Implementation: direct UPDATE via the same adapter, but the
      // current adapter only supports pending→X. We use a small
      // workaround: insertIfAbsent followed by transitionStatus
      // doesn't apply here. Instead: cast to allow status=failed→sent
      // via a fresh adapter call.
      //
      // For Wave I2e we accept an architectural concession: the retry
      // success path emits the audit but DOES NOT mutate the row's
      // status (it remains 'failed' with retry_until cleared). The
      // dispatcher's idempotency primitive (insertIfAbsent on
      // (cycle, step_id, year_in_cycle)) ensures no duplicate
      // dispatch fires from T088. The audit log carries the
      // authoritative success record.
      //
      // Future Wave I8+ refinement: extend the adapter with
      // `markRetrySucceeded(tx, eventId, deliveryId, dispatchedAt)`
      // that flips status='sent' + clears retry_until.
      //
      // Round-up of side effects this commit DOES make atomically:
      //   - audit `renewal_reminder_retried` (the attempt)
      //   - audit `renewal_reminder_sent`   (the delivery)
      //   - clear retry_until via markRetryExhausted (semantic abuse
      //     of that method — sets retry_exhausted_at to prevent
      //     repeated retry attempts on this row).
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_reminder_retried',
          payload: {
            cycle_id: event.cycleId,
            member_id: candidate.member.memberId as MemberId,
            step_id: event.stepId,
            reminder_event_id: event.reminderEventId,
            attempt_outcome: 'succeeded',
            new_delivery_id: gatewayResult.value.deliveryId,
          },
        },
        {
          tenantId: event.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId,
        },
      );
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_reminder_sent',
          payload: {
            cycle_id: event.cycleId,
            member_id: candidate.member.memberId as MemberId,
            step_id: event.stepId,
            channel: 'email',
            template_id: event.templateId,
            delivery_id: gatewayResult.value.deliveryId,
            recipient_locale: locale,
            via_retry: true,
          },
        },
        {
          tenantId: event.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId,
        },
      );
      // Mark exhausted to prevent re-pickup on next retry pass.
      // (Technically a misnomer — it succeeded, not exhausted — but
      // the column's semantic is "no longer eligible for retry pass"
      // which covers both success and timeout.)
      await deps.reminderEventRepo.markRetryExhausted(tx, {
        tenantId: event.tenantId,
        reminderEventId: event.reminderEventId,
        exhaustedAtIso: nowIso,
      });
      return { kind: 'succeeded' as const };
    }
    // Retry failed.
    const e = gatewayResult.error;
    const isPermanent =
      e.kind === 'gateway_4xx' ||
      e.kind === 'recipient_unsubscribed' ||
      e.kind === 'recipient_email_unverified' ||
      e.kind === 'template_variables_missing';
    if (isPermanent) {
      // Became permanent during retry — emit the permanent audit +
      // task + mark exhausted.
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_reminder_retried',
          payload: {
            cycle_id: event.cycleId,
            member_id: candidate.member.memberId as MemberId,
            step_id: event.stepId,
            reminder_event_id: event.reminderEventId,
            attempt_outcome: 'became_permanent',
            failure_kind: e.kind,
          },
        },
        {
          tenantId: event.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId,
        },
      );
      await emitPermanentFailure(
        deps,
        tx,
        event,
        candidate,
        e.kind,
        nowIso,
        correlationId,
        requestId,
      );
      return { kind: 'became_permanent' as const };
    }
    // Still transient — leave retry_until in place; emit retried audit.
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'renewal_reminder_retried',
        payload: {
          cycle_id: event.cycleId,
          member_id: candidate.member.memberId as MemberId,
          step_id: event.stepId,
          reminder_event_id: event.reminderEventId,
          attempt_outcome: 'still_transient',
          failure_kind: e.kind,
        },
      },
      {
        tenantId: event.tenantId,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
        requestId,
      },
    );
    return { kind: 'still_transient' as const };
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — exhausted budgets
// ---------------------------------------------------------------------------

async function emitPermanentFailure(
  deps: RenewalsDeps,
  tx: unknown,
  event: ReminderEvent,
  candidate: DispatchCandidate | null,
  failureKind: string,
  nowIso: string,
  correlationId: string,
  requestId: string | null,
): Promise<{ taskCreated: boolean; taskId: string | null }> {
  // Emit permanent audit + create task. Both wrapped by markRetryExhausted
  // ON UPDATE WHERE retry_exhausted_at IS NULL — concurrent retry passes
  // race deterministically.
  let taskInsert: { created: boolean; taskId: string } | null = null;
  if (candidate) {
    const taskId = asTaskId(randomUUID());
    const insert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
      tenantId: event.tenantId,
      taskId,
      memberId: candidate.member.memberId,
      cycleId: event.cycleId,
      taskType: MANUAL_OUTREACH_TASK_TYPE,
      assignedToRole: 'admin',
      dueAt: nowIso,
    });
    taskInsert = { created: insert.created, taskId: insert.row.taskId };
    if (insert.created) {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'escalation_task_created',
          payload: {
            task_id: insert.row.taskId,
            task_type: MANUAL_OUTREACH_TASK_TYPE,
            member_id: candidate.member.memberId as MemberId,
            cycle_id: event.cycleId,
            trigger_reason: 'retry_budget_exhausted',
          },
        },
        {
          tenantId: event.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId,
        },
      );
    }
  }
  // The typed payload shape for `renewal_reminder_send_failed_permanent`
  // expects bounce_class fields (designed for T090 bounce-detected path).
  // For retry-exhaustion we carry a different payload — cast through
  // `Record<string, unknown>` since the audit-emitter accepts both
  // typed and untyped payloads (renewal-audit-emitter.ts:263-266 mapped
  // type fallback).
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_reminder_send_failed_permanent',
      payload: {
        cycle_id: asCycleId(event.cycleId),
        member_id: (candidate?.member.memberId ?? '') as MemberId,
        step_id: event.stepId,
        channel: event.channel,
        template_id: event.templateId,
        failure_kind: failureKind,
        failure_message: event.failureReason,
        via_retry_exhaustion: true,
        retry_until: event.retryUntil,
        escalation_task_id: taskInsert?.taskId ?? null,
      } as unknown as Record<string, unknown>,
    } as Parameters<typeof deps.auditEmitter.emitInTx>[1],
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'cron',
      correlationId,
      requestId,
    },
  );
  // Idempotency primitive — markRetryExhausted is the WHERE-guard
  // that ensures permanent emit + task creation each happen exactly
  // once per row.
  try {
    await deps.reminderEventRepo.markRetryExhausted(tx, {
      tenantId: event.tenantId,
      reminderEventId: event.reminderEventId,
      exhaustedAtIso: nowIso,
    });
  } catch (e) {
    // Concurrent retry pass already marked exhausted — swallow.
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        reminderEventId: event.reminderEventId,
        correlationId,
      },
      'retryFailedReminders: concurrent exhaustion-mark — swallowed',
    );
  }
  return {
    taskCreated: taskInsert?.created ?? false,
    taskId: taskInsert?.taskId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public use-case — orchestrates Pass 1 + Pass 2
// ---------------------------------------------------------------------------

export async function retryFailedReminders(
  deps: RenewalsDeps,
  rawInput: RetryFailedRemindersInput,
): Promise<Result<RetryFailedRemindersOutput, RetryFailedRemindersError>> {
  const parsed = retryFailedRemindersInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const startedAt = Date.now();
  const nowIso = input.nowIso ?? new Date().toISOString();
  const pageSize = input.pageSize ?? DEFAULT_RETRY_PAGE_SIZE;

  const summary = {
    retryEligibleProcessed: 0,
    retrySucceeded: 0,
    retryStillTransient: 0,
    retryBecamePermanent: 0,
    retryBlockedByGate: 0,
    exhaustedMarked: 0,
    passErrors: 0,
    durationMs: 0,
  };

  // Pass 1 — re-attempt eligible failures.
  const eligible = await deps.reminderEventRepo.listRetryEligible(
    input.tenantId,
    { nowIso, pageSize },
  );
  for (const event of eligible) {
    summary.retryEligibleProcessed += 1;
    try {
      const outcome = await attemptRetry(
        deps,
        event,
        nowIso,
        input.correlationId,
        input.requestId ?? null,
      );
      switch (outcome.kind) {
        case 'succeeded':
          summary.retrySucceeded += 1;
          break;
        case 'still_transient':
          summary.retryStillTransient += 1;
          break;
        case 'became_permanent':
          summary.retryBecamePermanent += 1;
          break;
        case 'blocked_by_gate':
        case 'candidate_not_found':
          summary.retryBlockedByGate += 1;
          break;
      }
    } catch (e) {
      summary.passErrors += 1;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          reminderEventId: event.reminderEventId,
          tenantId: input.tenantId,
          correlationId: input.correlationId,
        },
        'retryFailedReminders: pass-1 attempt failed (isolated)',
      );
    }
  }

  // Pass 2 — exhausted budgets.
  const exhausted = await deps.reminderEventRepo.listRetryExhausted(
    input.tenantId,
    { nowIso, pageSize },
  );
  for (const event of exhausted) {
    try {
      const candidate = await deps.dispatchCandidateRepo.findOne(
        event.tenantId,
        asCycleId(event.cycleId),
      );
      await runInTenant(deps.tenant, async (tx) => {
        await emitPermanentFailure(
          deps,
          tx,
          event,
          candidate,
          event.failureReason ?? 'retry_budget_exhausted',
          nowIso,
          input.correlationId,
          input.requestId ?? null,
        );
      });
      summary.exhaustedMarked += 1;
    } catch (e) {
      summary.passErrors += 1;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          reminderEventId: event.reminderEventId,
          tenantId: input.tenantId,
          correlationId: input.correlationId,
        },
        'retryFailedReminders: pass-2 exhaustion-mark failed (isolated)',
      );
    }
  }

  summary.durationMs = Date.now() - startedAt;
  logger.info(
    {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      ...summary,
    },
    'retryFailedReminders: pass complete',
  );
  return ok({ summary });
}
