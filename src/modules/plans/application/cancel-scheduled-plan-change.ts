/**
 * Post-ship R6 Batch 2c (D7) — `cancelScheduledPlanChange` use-case.
 *
 * Cancels a `pending` scheduled plan change. Mirrors the structure of
 * `scheduleNextRenewalPlanChange` (Batch 1c / Wave B) and the
 * `accept-tier-upgrade` post-tx audit-emit pattern.
 *
 * Lifecycle (data-model.md § 2.9):
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
  // Light Domain validation — full zod input schema lives at the API
  // boundary when a caller (admin UI / F8 listener) is wired.
  if (!input.scheduledChangeId)
    return err({ code: 'invalid_input', field: 'scheduledChangeId' });
  if (!input.memberId)
    return err({ code: 'invalid_input', field: 'memberId' });
  if (!input.effectiveAtCycleId)
    return err({ code: 'invalid_input', field: 'effectiveAtCycleId' });
  if (!input.cancelledByUserId)
    return err({ code: 'invalid_input', field: 'cancelledByUserId' });

  // Precondition check — terminal-state immutability is a Domain
  // invariant. We look up the pending row for (member, cycle) via the
  // existing repo method (rather than `findById`) because the repo
  // contract today exposes `findPendingForCycle` + the partial-unique
  // guarantees at most one pending per cycle. If the caller-supplied
  // `scheduledChangeId` does NOT match the pending row, treat as
  // `not_found` — a stale UI submission targeting a row that was
  // already superseded by another concurrent admin action.
  let pending: ScheduledPlanChange | null;
  try {
    pending = await deps.repo.findPendingForCycle(
      deps.tenant,
      input.memberId,
      input.effectiveAtCycleId,
    );
  } catch (e) {
    return err({
      code: 'server_error',
      message: `cancelScheduledPlanChange.findPendingForCycle: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  if (pending === null) {
    return err({
      code: 'not_found',
      scheduledChangeId: input.scheduledChangeId,
    });
  }

  if (pending.scheduledChangeId !== input.scheduledChangeId) {
    // The pending row exists but for a DIFFERENT scheduledChangeId —
    // caller is racing against a concurrent supersede. Report as
    // `not_found` (the row they asked about is no longer pending).
    return err({
      code: 'not_found',
      scheduledChangeId: input.scheduledChangeId,
    });
  }

  // Defence-in-depth: `findPendingForCycle` should only return pending
  // rows, but verify before transitioning. If somehow we get a
  // terminal row back, refuse — this is a contract violation of the
  // repo + caller deserves a typed error not a silent overwrite.
  if (isTerminalStatus(pending.status)) {
    return err({
      code: 'already_terminal',
      scheduledChangeId: pending.scheduledChangeId,
      status: pending.status as Exclude<ScheduledPlanChangeStatus, 'pending'>,
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
