/**
 * F8 Phase 8 T209 — `completeEscalationTask` use-case.
 *
 * Admin clicks "Done" on an open escalation task per FR-044 + AS2.
 * Optional outcome note (≤1000 chars per Domain invariant +
 * `renewal_escalation_tasks.outcome_note` CHECK). Transitions the task
 * `open` → `done`, captures `closed_at` + `closed_by_user_id`, emits
 * `escalation_task_completed` atomically.
 *
 * RBAC (FR-052a): admin role only. The route handler enforces this
 * before invocation; the use-case validates the role anyway as
 * defence-in-depth (zod literal).
 *
 * Audit: emits `escalation_task_completed` (typed payload added Phase
 * 8 T213). Atomic with the UPDATE per Constitution Principle VIII —
 * an audit emit failure rolls the transition back.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import { logUnexpectedError } from './_lib/log-unexpected-error';
import {
  parseTaskId,
  type TaskId,
} from '../../domain/renewal-escalation-task';
import { EscalationTaskNotFoundError } from '../ports/renewal-escalation-task-repo';
import type { CycleId } from '../../domain/renewal-cycle';
import type { MemberId } from '@/modules/members';
import type { UserId } from '@/modules/auth/domain/branded';

export const completeEscalationTaskInputSchema = z.object({
  tenantId: z.string().min(1),
  taskId: z.string().uuid(),
  /** Optional free-text outcome note. */
  outcomeNote: z.string().trim().max(1000).optional(),
  // Round 5 I-9 close — UUID brand promise: `actor_user_id` is cast to
  // `UserId` at the audit-emit boundary; the schema MUST narrow to the
  // brand's structural shape so the cast is justified.
  actorUserId: z.string().uuid(),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type CompleteEscalationTaskInput = z.infer<
  typeof completeEscalationTaskInputSchema
>;

export interface CompleteEscalationTaskOutput {
  readonly taskId: TaskId;
  readonly closedAt: string;
}

export type CompleteEscalationTaskError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'task_not_open' }
  | { readonly kind: 'server_error'; readonly message: string };

export async function completeEscalationTask(
  deps: RenewalsDeps,
  rawInput: CompleteEscalationTaskInput,
): Promise<
  Result<CompleteEscalationTaskOutput, CompleteEscalationTaskError>
> {
  const inputResult = parseInput(
    completeEscalationTaskInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const idParse = parseTaskId(input.taskId);
  if (!idParse.ok) {
    return err({ kind: 'invalid_input', message: 'invalid task id' });
  }
  const taskId = idParse.value;

  const existing = await deps.escalationTaskRepo.findById(
    input.tenantId,
    taskId,
  );
  if (existing === null) return err({ kind: 'task_not_found' });
  if (existing.status !== 'open') {
    return err({ kind: 'task_not_open' });
  }

  const closedAt = new Date().toISOString();
  const trimmedNote =
    input.outcomeNote !== undefined && input.outcomeNote.length > 0
      ? input.outcomeNote
      : undefined;

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      await deps.escalationTaskRepo.transitionStatus(
        tx,
        input.tenantId,
        taskId,
        {
          to: 'done',
          closedAt,
          closedByUserId: input.actorUserId,
          ...(trimmedNote !== undefined ? { outcomeNote: trimmedNote } : {}),
        },
      );

      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_completed' as const,
            payload: {
              task_id: taskId,
              task_type: existing.taskType,
              member_id: existing.memberId as MemberId,
              cycle_id: (existing.cycleId ?? null) as CycleId | null,
              outcome_note: trimmedNote ?? null,
              actor_user_id: input.actorUserId as UserId,
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: 'admin',
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
          },
        );
      } catch (e) {
        // R8 IMP-B close — demoted to logger.warn (breadcrumb only).
        // The outer catch's logger.error is the canonical Sentry-
        // alerting incident; inner ERROR-severity caused double-noise
        // because the same exception bubbled out and re-logged.
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), taskId },
          '[complete-escalation-task] audit emit failed inside tx — rolling back (breadcrumb)',
        );
        // R10 T277g close — F8-A2 alarm rolls up via this counter.
        renewalsMetrics.escalationTaskAuditEmitFailed(
          input.tenantId,
          'completed',
        );
        throw e;
      }

      return ok({ taskId, closedAt });
    });
  } catch (e) {
    // Round 5 I-1 close — `transitionStatus` throws this when the
    // partial-unique `WHERE status='open'` clause loses the TOCTOU
    // race (another admin already closed the task between findById
    // and the UPDATE). Map to 409 task_not_open so the UI shows a
    // clear "already-closed by another admin" toast instead of a
    // generic 500.
    if (e instanceof EscalationTaskNotFoundError) {
      return err({ kind: 'task_not_open' });
    }
    // R6 C-2 + R8 S-3 close — log the underlying exception BEFORE
    // wrapping it into a server_error Result. The shared helper
    // centralises the log tag ('[<use-case>] unexpected error →
    // server_error') and the err+ctx shape across all 4 escalation
    // use-cases.
    logUnexpectedError('complete-escalation-task', e, {
      tenantId: input.tenantId,
      taskId: input.taskId,
      correlationId: input.correlationId,
    });
    return err({
      kind: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
