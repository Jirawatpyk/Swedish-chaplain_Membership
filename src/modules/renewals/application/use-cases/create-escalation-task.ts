/**
 * F8 Phase 8 T208 — `createEscalationTask` use-case.
 *
 * Canonical seam for inserting a new `renewal_escalation_tasks` row +
 * emitting the atomic `escalation_task_created` audit. Wraps
 * `escalationTaskRepo.insertIfAbsent` (idempotent against the partial
 * unique index `(tenant, member, cycle, task_type) WHERE status='open'`)
 * + `auditEmitter.emitInTx` so producers don't drift on payload shape
 * or skip the audit emit on the replay-no-op path.
 *
 * **Why a new use-case when 5 inline producers already exist**: Phase 8
 * adds the queue-side consumer (T214–T217 routes + T218–T222 UI).
 * Future producers (e.g. an admin "Create task manually" CTA) and the
 * Phase 8 integration tests need a single grep-able call site that
 * carries the canonical audit payload. The 5 existing inline producers
 * (`dispatch-one-cycle` ladder, `dispatch-one-cycle` no-primary-contact,
 * `detect-bounce-threshold`, `admin-reject-reactivation`,
 * `retry-failed-reminders`) are NOT refactored to call this use-case in
 * Phase 8 — their emits are correct and the diff stays focused. Phase 9
 * cross-cutting OR a future sweep can DRY them up.
 *
 * Audit emission semantics:
 *   - `created=true` (new row inserted) → emit `escalation_task_created`
 *     with `idempotent_replay: false`.
 *   - `created=false` (open partial-unique short-circuit) → still emit
 *     `escalation_task_created` with `idempotent_replay: true`. The
 *     forensic chain documents the no-op replay so on-call sees the
 *     producer attempted creation (e.g. `dispatch-one-cycle.ts ~L924`
 *     pattern). Consumers of the event filter by `idempotent_replay`
 *     when counting "fresh tasks created" vs "ladder run probes".
 *
 * RBAC: caller-authenticated. The use-case accepts `actorRole` ∈
 * `{ 'admin', 'cron', 'webhook', 'system' }` to cover every existing
 * producer; the route handlers enforce admin-only at the HTTP layer.
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
  asTaskId,
  ESCALATION_ASSIGNEE_ROLES,
  type EscalationAssigneeRole,
  type RenewalEscalationTask,
  type TaskId,
} from '../../domain/renewal-escalation-task';
import type { CycleId } from '../../domain/renewal-cycle';
import type { SuggestionId } from '../../domain/tier-upgrade-suggestion';
import type { MemberId } from '@/modules/members';
import type { UserId } from '@/modules/auth/domain/branded';
import type { CreditNoteId } from '@/modules/invoicing';

export const createEscalationTaskInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /** NULL for non-cycle tasks (e.g. `verify_pending_tier_upgrade`). */
  cycleId: z.string().uuid().nullable(),
  taskType: z.string().min(1).max(100),
  assignedToRole: z.enum(ESCALATION_ASSIGNEE_ROLES),
  /** Optional pre-assignment to a specific user (otherwise role-only). */
  assignedToUserId: z.string().uuid().optional(),
  /** ISO 8601 UTC. */
  dueAt: z.string().datetime(),
  /**
   * Producer-supplied discriminator for dashboards + alert routing
   * (e.g. `'scheduled_cron_step'`, `'no_primary_contact'`,
   * `'bounce_threshold_crossed'`, `'tier_upgrade_t180_verify'`,
   * `'admin_reject_with_refund'`).
   */
  triggerReason: z.string().min(1).max(100),
  /** Forward-compat for `verify_pending_tier_upgrade` tasks. */
  relatedSuggestionId: z.string().uuid().optional(),
  /** Optional context passthrough into the audit payload. */
  stepId: z.string().min(1).optional(),
  yearInCycle: z.number().int().positive().optional(),
  refundCreditNoteId: z.string().uuid().nullable().optional(),
  /** Pre-generated TaskId for callers that need to reference it. */
  taskId: z.string().uuid().optional(),
  /** Caller identity. */
  actorUserId: z.string().min(1).nullable(),
  actorRole: z.enum(['admin', 'manager', 'cron', 'webhook', 'system']),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /** Optional summary line for the audit row (truncated to 500). */
  summary: z.string().max(500).optional(),
});

export type CreateEscalationTaskInput = z.infer<
  typeof createEscalationTaskInputSchema
>;

export interface CreateEscalationTaskOutput {
  readonly taskId: TaskId;
  readonly created: boolean;
  readonly row: RenewalEscalationTask;
}

export type CreateEscalationTaskError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

export async function createEscalationTask(
  deps: RenewalsDeps,
  rawInput: CreateEscalationTaskInput,
): Promise<Result<CreateEscalationTaskOutput, CreateEscalationTaskError>> {
  const inputResult = parseInput(createEscalationTaskInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const taskId = asTaskId(
    input.taskId ?? globalThis.crypto.randomUUID(),
  );

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const insert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
        tenantId: input.tenantId,
        taskId,
        memberId: input.memberId,
        cycleId: input.cycleId,
        taskType: input.taskType,
        assignedToRole: input.assignedToRole as EscalationAssigneeRole,
        ...(input.assignedToUserId !== undefined
          ? { assignedToUserId: input.assignedToUserId }
          : {}),
        dueAt: input.dueAt,
        ...(input.relatedSuggestionId !== undefined
          ? { relatedSuggestionId: input.relatedSuggestionId }
          : {}),
      });

      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'escalation_task_created' as const,
            payload: {
              task_id: insert.row.taskId,
              task_type: input.taskType,
              member_id: input.memberId as MemberId,
              cycle_id: (input.cycleId ?? null) as CycleId | null,
              trigger_reason: input.triggerReason,
              assignee_role: input.assignedToRole as EscalationAssigneeRole,
              idempotent_replay: !insert.created,
              ...(input.stepId !== undefined ? { step_id: input.stepId } : {}),
              ...(input.yearInCycle !== undefined
                ? { year_in_cycle: input.yearInCycle }
                : {}),
              ...(input.refundCreditNoteId !== undefined
                ? {
                    refund_credit_note_id: (input.refundCreditNoteId ??
                      null) as CreditNoteId | null,
                  }
                : {}),
              ...(input.relatedSuggestionId !== undefined
                ? {
                    related_suggestion_id:
                      input.relatedSuggestionId as SuggestionId,
                  }
                : {}),
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          },
        );
      } catch (e) {
        // Constitution Principle VIII reverse-direction atomicity — an
        // audit emit failure inside the tx MUST propagate so the outer
        // runInTenant rolls the insertIfAbsent back.
        logger.error(
          { err: e instanceof Error ? e.message : String(e), taskId },
          '[create-escalation-task] audit emit failed inside tx — rolling back',
        );
        throw e;
      }

      return ok({
        taskId: insert.row.taskId,
        created: insert.created,
        row: insert.row,
      });
    });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// Re-exports kept off this file — the use-case is exposed via the
// barrel at `src/modules/renewals/index.ts`. UserId import is kept to
// keep the brand-link visible if a future variant needs it.
export type { UserId };
