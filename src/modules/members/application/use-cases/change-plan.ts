/**
 * `change-plan` use case (T079, US3 FR-004 + FR-010).
 *
 * Changes a member's plan binding. Returns a typed error that the API
 * route translates to `409 bundle_change_requires_confirmation` when the
 * new plan is a Partnership tier bundling a DIFFERENT corporate plan
 * than the current one — forcing the client to fetch the affected count
 * via endpoint #11 and re-submit with `confirm_bundle_change: true`.
 *
 * Plan-aware validation (turnover, startup duration) re-runs against the
 * NEW plan's bounds; the caller may bypass with an override reason per
 * FR-006a.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import {
  asOverrideReason,
  OVERRIDE_REASON_CODES,
} from '../../domain/value-objects/override-reason';
import { checkTurnoverBand } from '../../domain/policies/turnover-policy';
import { checkStartupDuration } from '../../domain/policies/startup-duration-policy';
import { asPlanId } from '../../domain/member';
import type { Member, MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';

export const changePlanSchema = z.object({
  new_plan_id: z.string().min(1),
  new_plan_year: z.number().int().min(2020).max(2100),
  confirm_bundle_change: z.boolean().optional(),
  override_reason_code: z.enum(OVERRIDE_REASON_CODES).nullable().optional(),
  override_reason_note: z.string().max(500).nullable().optional(),
});

export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export type ChangePlanError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'not_found' }
  | { type: 'plan_not_found' }
  | { type: 'invalid_override_reason'; code: string }
  | {
      type: 'bundle_change_requires_confirmation';
      oldBundleCorporatePlanId: string | null;
      newBundleCorporatePlanId: string | null;
    }
  | {
      type: 'turnover_out_of_band';
      turnoverThb: number;
      band: { minThb: number | null; maxThb: number | null };
    }
  | { type: 'startup_too_old'; foundedYear: number; maxAllowedYears: number }
  | { type: 'server_error'; message: string };

// F8 listener event payload — emitted to `manualPlanChangeListeners`
// after the `member_plan_manually_changed` audit row commits inside
// the change-plan tx. F8's `f8OnManualPlanChangeCallbacks(tenantId)`
// factory returns the listener array; the route handler wires it.
//
// Each listener runs inside the F3 tx (the `tx` param) so failures
// roll the F3 plan-change back per Constitution Principle VIII.
// Mirrors the F4 → F8 `f8OnPaidCallbacks` pattern.
//
// Phase 7 review-fix C-TYPE-1 — the event shape lives in F8's port to
// eliminate the prior duplicate F3 + F8 definitions that only worked
// via TS structural typing.
import type {
  ManualPlanChangeEvent,
  ManualPlanChangeListener as ManualPlanChangeListenerCanonical,
} from '@/modules/renewals';

export type ManualPlanChangeListenerEvent = ManualPlanChangeEvent;
export type ManualPlanChangeListener = ManualPlanChangeListenerCanonical;

export type ChangePlanDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  plans: PlanLookupPort;
  audit: AuditPort;
  /**
   * F8 Phase 7 T188 — listener array invoked atomically inside the
   * change-plan tx after the `member_plan_manually_changed` audit
   * commits. F8's `f8OnManualPlanChangeCallbacks(tenantId)` factory
   * supplies the canonical pair (supersede pending tier-upgrade +
   * reschedule renewal cadence). Optional — when undefined, change-
   * plan still works (the reconcile cron T185 catches orphan-pending
   * suggestions defensively).
   */
  manualPlanChangeListeners?: ReadonlyArray<ManualPlanChangeListener>;
};

export type ChangePlanCallMeta = {
  actorUserId: string;
  requestId: string;
};

export async function changePlan(
  memberId: MemberId,
  input: unknown,
  meta: ChangePlanCallMeta,
  deps: ChangePlanDeps,
): Promise<Result<Member, ChangePlanError>> {
  const parsed = changePlanSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  // Override reason pre-validation
  if (data.override_reason_code) {
    const r = asOverrideReason(
      data.override_reason_code,
      data.override_reason_note ?? null,
    );
    if (!r.ok)
      return err({ type: 'invalid_override_reason', code: r.error.code });
  }
  const overrideAsserted = Boolean(data.override_reason_code);

  // Load current member
  const currentResult = await deps.memberRepo.findById(deps.tenant, memberId);
  if (!currentResult.ok) {
    if (currentResult.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({
      type: 'server_error',
      message: `lookup: ${currentResult.error.code}`,
    });
  }
  const current = currentResult.value;

  // Short-circuit: no-op plan change
  if (
    (current.planId as string) === data.new_plan_id &&
    current.planYear === data.new_plan_year
  ) {
    return ok(current);
  }

  // Load new + old plan metadata
  const [oldPlan, newPlan] = await Promise.all([
    deps.plans.getPlan(deps.tenant, current.planId, current.planYear),
    deps.plans.getPlan(deps.tenant, asPlanId(data.new_plan_id), data.new_plan_year),
  ]);
  if (!newPlan.ok) return err({ type: 'plan_not_found' });

  // Bundle-change detection (FR-010): only fires on Partnership tiers
  // where the bundled corporate plan_id differs between old and new.
  const oldBundle = oldPlan.ok
    ? oldPlan.value.includesCorporatePlanId
    : null;
  const newBundle = newPlan.value.includesCorporatePlanId;
  const bundleChanged =
    newPlan.value.planCategory === 'partnership' &&
    oldBundle !== newBundle;
  if (bundleChanged && !data.confirm_bundle_change) {
    return err({
      type: 'bundle_change_requires_confirmation',
      oldBundleCorporatePlanId: oldBundle,
      newBundleCorporatePlanId: newBundle,
    });
  }

  // Turnover + startup checks against NEW plan (override may bypass)
  const turnoverCheck = checkTurnoverBand(current.turnoverThb, {
    minThb: newPlan.value.minTurnoverThb,
    maxThb: newPlan.value.maxTurnoverThb,
  });
  if (!turnoverCheck.ok && !overrideAsserted) {
    return err({
      type: 'turnover_out_of_band',
      turnoverThb: turnoverCheck.error.turnoverThb,
      band: turnoverCheck.error.band,
    });
  }

  if (
    newPlan.value.maxDurationYears !== null &&
    current.foundedYear !== null
  ) {
    const s = checkStartupDuration(
      current.foundedYear,
      current.registrationDate,
      newPlan.value.maxDurationYears,
    );
    if (!s.ok && !overrideAsserted) {
      return err({
        type: 'startup_too_old',
        foundedYear: s.error.foundedYear,
        maxAllowedYears: s.error.maxAllowedYears,
      });
    }
  }

  // Persist + audit atomically (Principle VIII — audit-with-state).
  // Throw-to-rollback: any port err aborts the tx via UpdateFailed /
  // AuditFailed sentinels caught below and mapped to server_error.
  try {
    const updatedMember = await runInTenant(deps.tenant, async (tx) => {
      const updated = await deps.memberRepo.updateFieldsInTx(tx, memberId, {
        planId: newPlan.value.planId,
        planYear: data.new_plan_year,
      });
      if (!updated.ok) {
        throw new TxAbort({ type: 'update_failed', code: updated.error.code });
      }

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_plan_changed',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_plan_changed ${memberId}`,
        payload: {
          member_id: memberId,
          old_plan_id: current.planId,
          old_plan_year: current.planYear,
          new_plan_id: data.new_plan_id,
          new_plan_year: data.new_plan_year,
          ...(data.override_reason_code && {
            override_reason_code: data.override_reason_code,
            override_reason_note: data.override_reason_note ?? null,
          }),
        },
      });
      if (!auditResult.ok) {
        throw new TxAbort({ type: 'audit_failed' });
      }

      // T029b (F8 Phase 2 Wave C, migration 0095) — emit
      // `member_plan_manually_changed` alongside the generic
      // `member_plan_changed` so F8's supersede listener (Phase 5+
      // T184) can distinguish admin manual overrides from auto-
      // applied scheduled plan changes. Same tx as the plan flip +
      // generic audit so the supersede observes either ALL three
      // events or NONE (Constitution Principle VIII — atomic
      // state+audit). The carry-over of Wave B T013.
      const manualAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_plan_manually_changed',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_plan_manually_changed ${memberId}`,
        payload: {
          member_id: memberId,
          old_plan_id: current.planId,
          old_plan_year: current.planYear,
          new_plan_id: data.new_plan_id,
          new_plan_year: data.new_plan_year,
          ...(data.override_reason_code && {
            override_reason_code: data.override_reason_code,
            override_reason_note: data.override_reason_note ?? null,
          }),
        },
      });
      if (!manualAudit.ok) {
        throw new TxAbort({ type: 'audit_failed' });
      }

      if (bundleChanged) {
        const bundleAudit = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'plan_bundle_changed',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `plan_bundle_changed for ${memberId}`,
          payload: {
            member_id: memberId,
            plan_id: data.new_plan_id,
            old_includes_corporate_plan_id: oldBundle,
            new_includes_corporate_plan_id: newBundle,
          },
        });
        if (!bundleAudit.ok) {
          throw new TxAbort({ type: 'audit_failed' });
        }
      }

      // F8 Phase 7 T188 — atomic invocation of registered F8 listeners
      // (supersede pending tier-upgrade + reschedule renewal cadence).
      // Same tx as the plan flip + audits per Constitution Principle VIII.
      // Any listener exception propagates → tx rollback → entire change-
      // plan is undone. Internal listener catch-blocks log + swallow per
      // their own contracts (the F8 reconcile cron provides defence-in-
      // depth recovery for any silently-swallowed failures).
      const listeners = deps.manualPlanChangeListeners ?? [];
      if (listeners.length > 0) {
        const evt: ManualPlanChangeListenerEvent = {
          tenantId: deps.tenant.slug,
          memberId,
          oldPlanId: current.planId,
          newPlanId: data.new_plan_id,
          actorUserId: meta.actorUserId,
          correlationId: meta.requestId,
          requestId: meta.requestId,
        };
        for (const listener of listeners) {
          try {
            await listener(evt, tx);
          } catch (e) {
            logger.error(
              {
                err: e instanceof Error ? e.message : String(e),
                tenantId: deps.tenant.slug,
                memberId,
              },
              '[change-plan] manualPlanChangeListener threw — F3 tx rolling back',
            );
            throw e;
          }
        }
      }

      return updated.value;
    });

    return ok(updatedMember);
  } catch (e) {
    if (e instanceof TxAbort) {
      if (e.detail.type === 'update_failed') {
        return err({
          type: 'server_error',
          message: `update: ${e.detail.code}`,
        });
      }
      return err({ type: 'server_error', message: 'audit_failed' });
    }
    throw e;
  }
}

/** Internal abort-sentinel for rolling back change-plan's tx cleanly. */
class TxAbort extends Error {
  constructor(
    public readonly detail:
      | { type: 'update_failed'; code: string }
      | { type: 'audit_failed' },
  ) {
    super(`tx-abort: ${detail.type}`);
  }
}
