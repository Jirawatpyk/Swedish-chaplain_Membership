/**
 * F8 Phase 8 T211 — `reassignEscalationTask` use-case.
 *
 * Admin reassigns the `assigned_to_user_id` of an open escalation task
 * per FR-044 + AS3. Captures the previous assignee for forensic linkage
 * (`from_user_id` → `to_user_id`) before the mutation. Atomic emit of
 * `escalation_task_reassigned` per Constitution Principle VIII.
 *
 * Tenant-isolation note: the route handler resolves the assignee user
 * list from the same tenant via the staff-users helper before this use-
 * case is invoked. The use-case does NOT independently verify the
 * assignee user exists in the tenant — defence-in-depth is applied at
 * the route layer (combobox only shows same-tenant users).
 *
 * RBAC (FR-052a): admin role only. Defence-in-depth zod literal.
 *
 * Audit: emits `escalation_task_reassigned` (typed payload added Phase
 * 8 T213).
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
import type { UserId } from '@/modules/auth';

export const reassignEscalationTaskInputSchema = z.object({
  tenantId: z.string().min(1),
  taskId: z.string().uuid(),
  toUserId: z.string().uuid(),
  // Round 5 I-9 close — UUID brand promise (see complete schema).
  actorUserId: z.string().uuid(),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type ReassignEscalationTaskInput = z.infer<
  typeof reassignEscalationTaskInputSchema
>;

export interface ReassignEscalationTaskOutput {
  readonly taskId: TaskId;
  readonly fromUserId: string | null;
  readonly toUserId: string;
}

export type ReassignEscalationTaskError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'task_not_open' }
  | { readonly kind: 'server_error'; readonly message: string };

export async function reassignEscalationTask(
  deps: RenewalsDeps,
  rawInput: ReassignEscalationTaskInput,
): Promise<
  Result<ReassignEscalationTaskOutput, ReassignEscalationTaskError>
> {
  const inputResult = parseInput(
    reassignEscalationTaskInputSchema,
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

  const fromUserId = existing.assignedToUserId;

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      await deps.escalationTaskRepo.reassign(
        tx,
        input.tenantId,
        taskId,
        input.toUserId,
      );

      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_reassigned' as const,
            payload: {
              task_id: taskId,
              task_type: existing.taskType,
              member_id: existing.memberId as MemberId,
              cycle_id: (existing.cycleId ?? null) as CycleId | null,
              from_user_id: (fromUserId ?? null) as UserId | null,
              to_user_id: input.toUserId as UserId,
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
        // R8 IMP-B close — demoted to warn (breadcrumb only).
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), taskId },
          '[reassign-escalation-task] audit emit failed inside tx — rolling back (breadcrumb)',
        );
        // R10 T277g close — F8-A2 alarm rolls up via this counter.
        renewalsMetrics.escalationTaskAuditEmitFailed(
          input.tenantId,
          'reassigned',
        );
        throw e;
      }

      return ok({
        taskId,
        fromUserId: fromUserId ?? null,
        toUserId: input.toUserId,
      });
    });
  } catch (e) {
    // Round 5 I-1 close — concurrent-loss race maps to 409 (see
    // complete-escalation-task.ts for full rationale).
    if (e instanceof EscalationTaskNotFoundError) {
      return err({ kind: 'task_not_open' });
    }
    // R6 C-2 + R8 S-3 close — shared logUnexpectedError helper.
    logUnexpectedError('reassign-escalation-task', e, {
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
