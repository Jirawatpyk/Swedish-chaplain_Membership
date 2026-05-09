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
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import {
  parseTaskId,
  type TaskId,
} from '../../domain/renewal-escalation-task';
import type { CycleId } from '../../domain/renewal-cycle';
import type { MemberId } from '@/modules/members';
import type { UserId } from '@/modules/auth/domain/branded';

export const completeEscalationTaskInputSchema = z.object({
  tenantId: z.string().min(1),
  taskId: z.string().uuid(),
  /** Optional free-text outcome note. */
  outcomeNote: z.string().trim().max(1000).optional(),
  actorUserId: z.string().min(1),
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
        logger.error(
          { err: e instanceof Error ? e.message : String(e), taskId },
          '[complete-escalation-task] audit emit failed inside tx — rolling back',
        );
        throw e;
      }

      return ok({ taskId, closedAt });
    });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
