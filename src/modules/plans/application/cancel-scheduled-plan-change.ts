/**
 * `cancelScheduledPlanChange` use-case (F2).
 *
 * Lifecycle (specs/011-renewal-reminders/data-model.md § 2.9):
 *
 *     pending ──cancel──→ cancelled (terminal — this use-case)
 *
 * Emits `plan_change_cancelled` audit post-tx. Audit-emit failure
 * returns `audit_failed` even though the row is already in the
 * cancelled terminal state (non-rollback — same compromise as
 * `scheduleNextRenewalPlanChange`).
 *
 * Caller: admin API route at
 * `src/app/api/admin/scheduled-plan-changes/[id]/cancel/route.ts`.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort, ScheduledPlanChangeRepo } from './ports';
import { recordAuditEvent } from './record-audit-event';
import {
  isTerminalStatus,
  type CancelScheduledPlanChangeError,
  type CancelScheduledPlanChangeInput,
  type ScheduledPlanChange,
  type ScheduledPlanChangeStatus,
} from '../domain/scheduled-plan-change';

/**
 * Zod schema at the Application boundary.
 * Without uuid validation here, the audit-payload schema (which
 * requires `z.string().uuid()` on `member_id` + `effective_at_cycle_id`)
 * would reject AFTER the DB transition lands → divergent committed
 * state. The boundary schema fails-closed BEFORE any DB or audit work.
 */
const cancelScheduledPlanChangeInputSchema = z.object({
  // `scheduled_plan_changes.scheduled_change_id` is a Postgres `uuid`.
  // A non-UUID input would otherwise bypass the boundary check, reach
  // `findById` Drizzle adapter, hit SQLSTATE 22P02
  // (invalid_text_representation), and surface as a generic
  // server_error (500) instead of the correct invalid_input (400).
  scheduledChangeId: z.string().uuid(),
  memberId: z.string().uuid(),
  effectiveAtCycleId: z.string().uuid(),
  // No `cancelledByUserId` — it always equals `deps.actorUserId`.
  reason: z.string().max(500).nullable().optional(),
});

export interface CancelScheduledPlanChangeDeps {
  readonly tenant: TenantContext;
  readonly repo: ScheduledPlanChangeRepo;
  /**
   * F2 audit emitter. The use-case calls `recordAuditEvent` after the
   * repo transition lands. A failed audit write returns an
   * `audit_failed` typed error to the caller — same compliance rule
   * `scheduleNextRenewalPlanChange` enforces.
   */
  readonly audit: AuditPort;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
}

export async function cancelScheduledPlanChange(
  deps: CancelScheduledPlanChangeDeps,
  input: CancelScheduledPlanChangeInput,
): Promise<Result<ScheduledPlanChange, CancelScheduledPlanChangeError>> {
  // Zod input validation at the Application boundary.
  // First-issue translation keeps the existing error union shape.
  const parsed = cancelScheduledPlanChangeInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path[0];
    return err({
      code: 'invalid_input',
      field: typeof field === 'string' ? field : 'unknown',
    });
  }

  // Lookup-by-primary-key via `findById`. Two distinct guards run
  // after the lookup:
  //
  //   1. (memberId, effectiveAtCycleId) cross-check — **INTENTIONALLY
  //      KEPT** as defence-against-stale-UI. If an admin UI's local
  //      state still references a `scheduledChangeId` that has since
  //      been superseded onto a different (member, cycle) tuple, the
  //      cross-check catches it and returns `not_found` so the user
  //      gets a fresh-view prompt rather than silently mutating a
  //      stranger's row.
  //   2. `isTerminalStatus` precondition — terminal-state immutability
  //      is a Domain invariant. `findById` returns terminal rows (the
  //      prior `findPendingForCycle` filtered them out, masking the
  //      distinction); we map terminal → `already_terminal` (409) so
  //      callers can distinguish "row gone" from "row already
  //      applied/cancelled/superseded".
  let row: ScheduledPlanChange | null;
  try {
    row = await deps.repo.findById(deps.tenant, input.scheduledChangeId);
  } catch (e) {
    return err({
      code: 'server_error',
      message: `cancelScheduledPlanChange.findById: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  if (row === null) {
    return err({
      code: 'not_found',
      scheduledChangeId: input.scheduledChangeId,
    });
  }

  // Defence-against-stale-UI cross-check.
  if (
    row.memberId !== input.memberId ||
    row.effectiveAtCycleId !== input.effectiveAtCycleId
  ) {
    return err({
      code: 'not_found',
      scheduledChangeId: input.scheduledChangeId,
    });
  }

  // Terminal-state immutability — distinct error code so callers can
  // distinguish "row no longer exists for you" from "row already
  // applied/superseded/cancelled".
  if (isTerminalStatus(row.status)) {
    return err({
      code: 'already_terminal',
      scheduledChangeId: row.scheduledChangeId,
      status: row.status as Exclude<ScheduledPlanChangeStatus, 'pending'>,
    });
  }

  // Atomic single-row update. The repo throws on `pending` → `pending`
  // self-transitions or any other domain-invariant violation; catch
  // here surfaces as `server_error` rather than crashing.
  let transitioned: ScheduledPlanChange;
  try {
    transitioned = await deps.repo.transitionStatus(
      deps.tenant,
      input.scheduledChangeId,
      'cancelled',
    );
  } catch (e) {
    // TOCTOU race classification. Between findById (pending) and
    // transitionStatus UPDATE, a concurrent
    // admin can apply/cancel/supersede the row. The repo's
    // conditional UPDATE only matches `status='pending'`, throws
    // "row not found or already terminal" when 0 rows updated. Re-
    // read via findById; if row is terminal, return `already_terminal`
    // (409) — operationally distinct from `server_error` (500).
    try {
      const recheck = await deps.repo.findById(
        deps.tenant,
        input.scheduledChangeId,
      );
      if (recheck !== null && isTerminalStatus(recheck.status)) {
        return err({
          code: 'already_terminal',
          scheduledChangeId: recheck.scheduledChangeId,
          status: recheck.status as Exclude<
            ScheduledPlanChangeStatus,
            'pending'
          >,
        });
      }
    } catch {
      // re-read itself failed — fall through to server_error
    }
    return err({
      code: 'server_error',
      message: `cancelScheduledPlanChange.transitionStatus: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  // Post-tx audit emit — mirror `scheduleNextRenewalPlanChange` (Batch
  // 1c) + `accept-tier-upgrade` (Batch 1c F8 post-tx pattern). Runs
  // OUTSIDE the repo tx; on failure, return `audit_failed` typed
  // error. The row IS already cancelled at this point — the audit
  // failure is surfaced to the caller for logging + monitoring, but
  // is not a roll-back trigger (Constitution Principle VIII: audit
  // writes are compliance-critical but not transactional with the
  // domain mutation; same compromise as the schedule use-case).
  const auditCtx = {
    tenant: deps.tenant,
    actorUserId: deps.actorUserId,
    requestId: deps.requestId,
    sourceIp: deps.sourceIp,
  };
  const auditResult = await recordAuditEvent(deps.audit, auditCtx, {
    event_type: 'plan_change_cancelled',
    payload: {
      member_id: input.memberId,
      scheduled_change_id: input.scheduledChangeId,
      effective_at_cycle_id: input.effectiveAtCycleId,
      reason: input.reason ?? null,
    },
  });
  if (!auditResult.ok) {
    // Preserve discriminator so the route can attach
    // `errorId: 'F2.PLAN_CHANGE.CANCEL_AUDIT_*'` with the specific
    // failure mode visible to alert routing. Carry `transitioned` so
    // the route can return 200 + diagnostic header instead of a
    // misleading 500. The row IS already cancelled; the audit failure
    // is a separate, async-recoverable observability concern.
    return err({
      code: 'audit_failed',
      auditErrorType: auditResult.error.type,
      message:
        auditResult.error.type === 'invalid_payload'
          ? auditResult.error.issues.join('; ')
          : auditResult.error.message,
      transitioned,
    });
  }

  return ok(transitioned);
}
