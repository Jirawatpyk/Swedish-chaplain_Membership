/**
 * F8 Phase 4 Wave I2b · T091 — `reset-email-unverified` use-case.
 *
 * F1 verification-flow callback: when a member completes the
 * `email_verification_succeeded` flow (e.g., admin manually re-verified,
 * or member confirmed a new MX record), F8 must:
 *
 *   1. Clear `members.email_unverified=FALSE` + `email_unverified_at=NULL`
 *      so the dispatcher (T088) resumes normal email reminders on the
 *      next cron pass.
 *   2. Close any open `manual_outreach_required` escalation tasks for
 *      the member (across ALL of their cycles — see D2) so admin's
 *      queue clears automatically.
 *   3. Emit `escalation_task_completed` audit per closed task.
 *
 * Atomic state+audit per Constitution Principle VIII:
 *   - Opens `runInTenant(ctx, tx => …)` so the member-flag UPDATE +
 *     each task `transitionStatus` + each audit `emitInTx` commit
 *     together (or all roll back).
 *   - `transitionStatus` UPDATE has `WHERE status='open'` — concurrent
 *     transitions deterministically produce one winner; the loser
 *     throws `EscalationTaskNotFoundError` which we CATCH defensively
 *     (idempotent reset semantics — a task already closed by another
 *     path is fine; we just don't double-audit it).
 *
 * Idempotency: clearing an already-false flag is a no-op silent return.
 * Re-invoking T091 after the first call closes 0 tasks and clears the
 * already-false flag — safe to retry.
 *
 * NOT exposed via REST — internal F1-webhook callback (T102 wires it
 * via the F8 barrel). No cross-tenant probe audit because F1 has
 * already verified the member exists in F1's auth surface by the time
 * this fires.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { EscalationTaskNotFoundError } from '../ports/renewal-escalation-task-repo';
// Type-only import for branded MemberId — keeps Application layer free
// of cross-module runtime coupling.
import type { MemberId } from '@/modules/members';

/**
 * The fixed task-type closed by this use-case. F8 reserves
 * `manual_outreach_required` for "member's email bounced, admin needs
 * to reach them another way" — a verified email cancels the need.
 */
export const MANUAL_OUTREACH_TASK_TYPE = 'manual_outreach_required' as const;

export const resetEmailUnverifiedInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /**
   * F1's identity — typically the member's own user_id (self-service
   * verification) OR a system actor when triggered by background job.
   * Recorded as `closed_by_user_id` on each closed task and as
   * `actor_user_id` on each audit row.
   */
  actorUserId: z.string().min(1),
  actorRole: z.enum(['admin', 'member', 'system']),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type ResetEmailUnverifiedInput = z.infer<
  typeof resetEmailUnverifiedInputSchema
>;

export interface ResetEmailUnverifiedOutput {
  /**
   * `true` when the member row existed AND email_unverified flipped
   * from true→false. `false` when row was missing OR flag was already
   * false (idempotent no-op return).
   */
  readonly cleared: boolean;
  readonly closedTaskIds: ReadonlyArray<string>;
  readonly closedTaskCount: number;
}

export type ResetEmailUnverifiedError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export async function resetEmailUnverified(
  deps: RenewalsDeps,
  rawInput: ResetEmailUnverifiedInput,
): Promise<
  Result<ResetEmailUnverifiedOutput, ResetEmailUnverifiedError>
> {
  const parsed = resetEmailUnverifiedInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  // Pre-fetch open tasks OUTSIDE the tx — index-served read; the list
  // is used only to decide which tasks to attempt closing inside the
  // tx. The transitionStatus UPDATE inside the tx re-checks
  // `status='open'` so a concurrently-closed task doesn't cause us to
  // emit a stale audit.
  const openTasks = await deps.escalationTaskRepo.listOpenForMemberByType(
    input.tenantId,
    input.memberId,
    MANUAL_OUTREACH_TASK_TYPE,
  );

  // Atomic: member-flag UPDATE + each task transition + audit emit.
  return runInTenant(deps.tenant, async (tx) => {
    const flagResult = await deps.memberRenewalFlagsRepo.clearEmailUnverified(
      tx,
      input.tenantId,
      input.memberId,
    );
    const cleared =
      flagResult.affectedRows > 0 && flagResult.previouslyUnverified;

    const closedTaskIds: string[] = [];
    for (const task of openTasks) {
      try {
        await deps.escalationTaskRepo.transitionStatus(
          tx,
          input.tenantId,
          task.taskId,
          {
            to: 'done',
            closedAt: new Date().toISOString(),
            closedByUserId: input.actorUserId,
            outcomeNote: 'email_re_verified_by_f1',
          },
        );
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_completed',
            payload: {
              task_id: task.taskId,
              task_type: task.taskType,
              member_id: task.memberId as MemberId,
              closed_by_actor_role: input.actorRole,
              closure_reason: 'email_re_verified_by_f1',
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
            summary: `Closed manual_outreach_required task ${task.taskId} after email re-verification`,
          },
        );
        closedTaskIds.push(task.taskId);
      } catch (e) {
        if (e instanceof EscalationTaskNotFoundError) {
          // Concurrently closed by another path (admin manual mark-done,
          // duplicate F1 webhook, etc.) — safe to swallow per
          // idempotent-reset semantics. Log at WARN so a sudden spike
          // is observable.
          logger.warn(
            {
              taskId: task.taskId,
              memberId: input.memberId,
              correlationId: input.correlationId,
            },
            'resetEmailUnverified: task already closed by concurrent path (swallowed)',
          );
          continue;
        }
        // Unexpected error — propagate to roll back the entire tx
        // (member-flag update + any prior task transitions).
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            taskId: task.taskId,
            memberId: input.memberId,
            correlationId: input.correlationId,
          },
          'resetEmailUnverified: unexpected task transition error',
        );
        throw e;
      }
    }

    return ok({
      cleared,
      closedTaskIds,
      closedTaskCount: closedTaskIds.length,
    });
  });
}
