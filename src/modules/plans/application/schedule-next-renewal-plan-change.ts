/**
 * `scheduleNextRenewalPlanChange` use-case (F2).
 *
 * Captures admin intent to switch a member's plan AT the next renewal
 * boundary. Atomic supersede+insert: any prior pending row for the
 * SAME (member, cycle) is flipped to `superseded` first, then a fresh
 * `pending` row lands. Terminal rows on the same (member, cycle) are
 * left untouched (specs/011-renewal-reminders/data-model.md § 2.9
 * partial unique allows them to coexist alongside one fresh pending
 * row).
 *
 * F2 boundary callers (live, not deferred):
 *   - F8 `acceptTierUpgrade` invokes
 *     `scheduledPlanChangeRepo.supersedeAndInsertPendingAtomically`
 *     directly (in-tx) and emits the F2 audit chain post-tx via the
 *     `planAuditAdapter`. See
 *     `src/modules/renewals/application/use-cases/accept-tier-upgrade.ts:358-414`.
 *   - F4 invoice-paid hook flips `pending → applied` post-tx via
 *     `_internal.finaliseF2ScheduledPlanChangeForCycle` in
 *     `src/modules/renewals/infrastructure/_lib/apply-tier-upgrade-on-paid-callback.ts:41-164`
 *     (F2 state apply lives there).
 *   - F4 invoice-creation hook reads the effective plan via
 *     `getEffectivePlanForRenewal` (no write).
 *
 * Pure Application code — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort, ScheduledPlanChangeRepo } from './ports';
import { recordAuditEvent } from './record-audit-event';
import type {
  ScheduledPlanChange,
  ScheduleNextRenewalPlanChangeError,
  ScheduleNextRenewalPlanChangeInput,
} from '../domain/scheduled-plan-change';

export interface ScheduleNextRenewalPlanChangeDeps {
  readonly tenant: TenantContext;
  readonly repo: ScheduledPlanChangeRepo;
  // Audit emit for `plan_change_scheduled` (+ `plan_change_superseded`
  // when a prior pending row was bumped).
  // F8's `accept-tier-upgrade` calls the repo directly today rather
  // than this use-case; F8 wires its own post-tx emit via the F2
  // `planAuditAdapter` re-exported from `@/modules/plans/server`. Both
  // call sites now leave an F2-domain audit trail when the
  // scheduled-plan-change state machine transitions.
  readonly audit: AuditPort;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
}

export async function scheduleNextRenewalPlanChange(
  deps: ScheduleNextRenewalPlanChangeDeps,
  input: ScheduleNextRenewalPlanChangeInput,
): Promise<Result<ScheduledPlanChange, ScheduleNextRenewalPlanChangeError>> {
  // Light Domain validation — full zod input schema lives at the API
  // boundary; here we only assert what's needed for the repo write to
  // be safe.
  if (!input.memberId) return err({ code: 'invalid_input', field: 'memberId' });
  if (!input.effectiveAtCycleId)
    return err({ code: 'invalid_input', field: 'effectiveAtCycleId' });
  if (!input.fromPlanId)
    return err({ code: 'invalid_input', field: 'fromPlanId' });
  if (!input.toPlanId)
    return err({ code: 'invalid_input', field: 'toPlanId' });
  if (!input.scheduledByUserId)
    return err({ code: 'invalid_input', field: 'scheduledByUserId' });
  if (input.fromPlanId === input.toPlanId)
    return err({ code: 'invalid_input', field: 'toPlanId' });

  let result;
  try {
    // Atomic supersede + insert pair (Constitution Principle VIII —
    // Reliability). The repo's `supersedeAndInsertPendingAtomically`
    // wraps both writes in a single DB tx; a failure on either statement
    // rolls both back so the (tenant, member, cycle) never observes a
    // "no pending row" intermediate state. Resolves Wave B verify-run
    // finding F1 (the earlier two-call pattern via `transitionStatus`
    // + `insertPending` had a crash window between calls).
    //
    // Terminal rows on the same (member, cycle) are left untouched by
    // the adapter — the partial unique
    // `(tenant_id, member_id, effective_at_cycle_id) WHERE status='pending'`
    // permits any number of terminal rows to coexist alongside one
    // fresh pending row (data-model.md § 2.9).
    result = await deps.repo.supersedeAndInsertPendingAtomically(
      deps.tenant,
      input,
    );
  } catch (e) {
    return err({
      code: 'server_error',
      message: `scheduleNextRenewalPlanChange: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  // Emit F2-domain audit trail for the state change.
  // Runs OUTSIDE the repo tx (the repo opens its own runInTenant), so
  // a failure here leaves the row in place + surfaces a typed error
  // for the caller to log; the audit-adapter ALSO logs internally at
  // Infrastructure for the persist_failed branch.
  const auditCtx = {
    tenant: deps.tenant,
    actorUserId: deps.actorUserId,
    requestId: deps.requestId,
    sourceIp: deps.sourceIp,
  };
  const scheduledAuditResult = await recordAuditEvent(deps.audit, auditCtx, {
    event_type: 'plan_change_scheduled',
    payload: {
      member_id: input.memberId,
      scheduled_change_id: result.inserted.scheduledChangeId,
      effective_at_cycle_id: input.effectiveAtCycleId,
      from_plan_id: input.fromPlanId,
      to_plan_id: input.toPlanId,
      reason: input.reason ?? null,
    },
  });
  if (!scheduledAuditResult.ok) {
    return err({
      code: 'audit_failed',
      message:
        scheduledAuditResult.error.type === 'invalid_payload'
          ? scheduledAuditResult.error.issues.join('; ')
          : scheduledAuditResult.error.message,
    });
  }

  // Emit `plan_change_superseded` for the prior pending row (if any).
  // The repo only returns a non-null `superseded` row when one was
  // bumped; new-pending-only inserts skip this branch cleanly.
  if (result.superseded !== null) {
    const supersededAuditResult = await recordAuditEvent(deps.audit, auditCtx, {
      event_type: 'plan_change_superseded',
      payload: {
        member_id: input.memberId,
        scheduled_change_id: result.superseded.scheduledChangeId,
        effective_at_cycle_id: input.effectiveAtCycleId,
        superseded_by_scheduled_change_id: result.inserted.scheduledChangeId,
      },
    });
    if (!supersededAuditResult.ok) {
      return err({
        code: 'audit_failed',
        message:
          supersededAuditResult.error.type === 'invalid_payload'
            ? supersededAuditResult.error.issues.join('; ')
            : supersededAuditResult.error.message,
      });
    }
  }

  return ok(result.inserted);
}
