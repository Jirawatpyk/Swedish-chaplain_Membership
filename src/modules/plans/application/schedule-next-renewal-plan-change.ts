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
 *
 * The next renewal invoice is priced against the member's effective plan by
 * reading `members.plan_id` at next-cycle seed time — the plan-change apply
 * paths keep that column current. (An earlier design routed this through a
 * `getEffectivePlanForRenewal` resolver, removed as dead code in Package B2;
 * it had zero call sites and required an un-implementable plans→members
 * dependency inversion.)
 *
 * Pure Application code — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort, ScheduledPlanChangeRepo, SupersedeAndInsertResult } from './ports';
import { auditFailureMessage, auditInTx, PlanAuditAbort } from './record-audit-event';
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

  // 126 #7 — the supersede + insert AND their F2 audit rows
  // (`plan_change_scheduled`, plus `plan_change_superseded` when a prior
  // pending row was bumped) run in ONE tx: an audit failure rolls the
  // schedule back instead of leaving an unaudited pending row.
  const auditCtx = {
    tenant: deps.tenant,
    actorUserId: deps.actorUserId,
    requestId: deps.requestId,
    sourceIp: deps.sourceIp,
  };
  const auditScheduled = auditInTx<SupersedeAndInsertResult>(deps.audit, auditCtx, (r) => ({
    event_type: 'plan_change_scheduled',
    payload: {
      member_id: input.memberId,
      scheduled_change_id: r.inserted.scheduledChangeId,
      effective_at_cycle_id: input.effectiveAtCycleId,
      from_plan_id: input.fromPlanId,
      to_plan_id: input.toPlanId,
      reason: input.reason ?? null,
    },
  }));
  const auditSuperseded = auditInTx<SupersedeAndInsertResult>(deps.audit, auditCtx, (r) => ({
    event_type: 'plan_change_superseded',
    payload: {
      member_id: input.memberId,
      scheduled_change_id: r.superseded!.scheduledChangeId,
      effective_at_cycle_id: input.effectiveAtCycleId,
      superseded_by_scheduled_change_id: r.inserted.scheduledChangeId,
    },
  }));

  let result: SupersedeAndInsertResult;
  try {
    result = await deps.repo.supersedeAndInsertPendingAtomically(
      deps.tenant,
      input,
      undefined,
      async (tx, written) => {
        await auditScheduled(tx, written);
        if (written.superseded !== null) await auditSuperseded(tx, written);
      },
    );
  } catch (e) {
    if (e instanceof PlanAuditAbort) {
      return err({ code: 'audit_failed', message: auditFailureMessage(e.error) });
    }
    return err({
      code: 'server_error',
      message: `scheduleNextRenewalPlanChange: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  return ok(result.inserted);
}
