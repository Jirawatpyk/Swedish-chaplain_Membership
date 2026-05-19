/**
 * Post-ship R6 Batch 2c (D7) — `cancelScheduledPlanChange` use-case.
 *
 * Cancels a `pending` scheduled plan change. Mirrors the structure of
 * `scheduleNextRenewalPlanChange` (Batch 1c / Wave B) and the
 * `accept-tier-upgrade` post-tx audit-emit pattern.
 *
 * Lifecycle (specs/011-renewal-reminders/data-model.md § 2.9):
 *
 *     pending ──cancel──→ cancelled (terminal — this use-case)
 *
 * Closes the `plan_change_cancelled` half of the deferred-emitter TODO
 * in `domain/audit-event.ts` lines 53-62. The `plan_change_applied`
 * half lands separately in Batch 2d (F8 invoice-paid callback wiring).
 *
 * Caller surface:
 *   - **No API route + no admin UI in this batch** (intentional —
 *     scope was capped at the use-case so the future caller — a
 *     post-MVP admin "cancel scheduled change" surface, or the F8
 *     auto-supersede flow — can wire it without a second use-case
 *     refactor).
 *   - The use-case is ready-to-call: input + deps + Result + audit
 *     emit are fully defined and contract-stable.
 *
 * Pure Application code — no framework imports (Constitution Principle III).
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
 * R2 Batch 3a (R2-C2) — zod schema at the Application boundary.
 * Without uuid validation here, the audit-payload schema (which
 * requires `z.string().uuid()` on `member_id` + `effective_at_cycle_id`)
 * would reject AFTER the DB transition lands → divergent committed
 * state. The boundary schema fails-closed BEFORE any DB or audit work.
 */
const cancelScheduledPlanChangeInputSchema = z.object({
  scheduledChangeId: z.string().min(1),
  memberId: z.string().uuid(),
  effectiveAtCycleId: z.string().uuid(),
  cancelledByUserId: z.string().min(1),
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
  // R2 Batch 3a — zod input validation at the Application boundary.
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

  // R2 Batch 3g (R2-I16) — primary-key lookup via `findById`. Cleaner
  // than the prior `findPendingForCycle + cross-check` pattern because:
  //   - Repo limitation no longer leaks into Application layer
  //     (Constitution III — port contract shouldn't reflect "the
  //     repo lacks a primary-key lookup")
  //   - Terminal-status rows are visible to the use-case → distinct
  //     `already_terminal` error code, not silently masked as
  //     `not_found`
  //
  // The (memberId, effectiveAtCycleId) cross-check still runs as
  // defence-against-stale-UI: if an admin UI passes a `scheduledChangeId`
  // that EXISTS but doesn't match the (memberId, cycleId) the UI
  // believes it's working with, treat as `not_found` (the row is no
  // longer the one the user clicked on, e.g., row was superseded
  // since the page loaded).
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
    return err({
      code: 'audit_failed',
      message:
        auditResult.error.type === 'invalid_payload'
          ? auditResult.error.issues.join('; ')
          : auditResult.error.message,
    });
  }

  return ok(transitioned);
}
