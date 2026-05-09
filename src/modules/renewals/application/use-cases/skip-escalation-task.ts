/**
 * F8 Phase 8 T210 — `skipEscalationTask` use-case.
 *
 * Admin clicks "Skip" on an open escalation task per FR-044 + AS2 (skip
 * variant). REQUIRED reason (1..500 chars per Domain invariant +
 * `renewal_escalation_tasks.skipped_reason` CHECK). Transitions the
 * task `open` → `skipped`, captures `closed_at` + `closed_by_user_id`,
 * emits `escalation_task_skipped` atomically.
 *
 * RBAC (FR-052a): admin role only. Defence-in-depth zod literal.
 *
 * Audit: emits `escalation_task_skipped` (typed payload added Phase 8
 * T213). Atomic with the UPDATE per Constitution Principle VIII.
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

export const skipEscalationTaskInputSchema = z.object({
  tenantId: z.string().min(1),
  taskId: z.string().uuid(),
  /** REQUIRED reason. */
  skippedReason: z.string().trim().min(1).max(500),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type SkipEscalationTaskInput = z.infer<
  typeof skipEscalationTaskInputSchema
>;

export interface SkipEscalationTaskOutput {
  readonly taskId: TaskId;
  readonly closedAt: string;
}

export type SkipEscalationTaskError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'task_not_open' }
  | { readonly kind: 'server_error'; readonly message: string };

export async function skipEscalationTask(
  deps: RenewalsDeps,
  rawInput: SkipEscalationTaskInput,
): Promise<Result<SkipEscalationTaskOutput, SkipEscalationTaskError>> {
  const inputResult = parseInput(skipEscalationTaskInputSchema, rawInput);
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

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      await deps.escalationTaskRepo.transitionStatus(
        tx,
        input.tenantId,
        taskId,
        {
          to: 'skipped',
          closedAt,
          closedByUserId: input.actorUserId,
          skippedReason: input.skippedReason,
        },
      );

      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_skipped' as const,
            payload: {
              task_id: taskId,
              task_type: existing.taskType,
              member_id: existing.memberId as MemberId,
              cycle_id: (existing.cycleId ?? null) as CycleId | null,
              skipped_reason: input.skippedReason,
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
          '[skip-escalation-task] audit emit failed inside tx — rolling back',
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
