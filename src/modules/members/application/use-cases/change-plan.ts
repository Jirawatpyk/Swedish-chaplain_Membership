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
// AFTER the change-plan tx (plan-flip + `member_plan_manually_changed`
// audit) has COMMITTED. F8's `f8OnManualPlanChangeCallbacks(tenantId)`
// factory returns the listener array; the route handler wires it.
//
// 063 (Option A) — each listener runs POST-COMMIT in its OWN tenant tx
// (the bridge opens it). Listeners are best-effort: a failure is logged
// + counted by the bridge and does NOT roll back the already-committed
// plan-flip. This mirrors the POST-tx half of the F4 → F8
// `f8OnPaidCallbacks` pattern (the F2 finaliser there also runs in its
// own `runInTenant` after F4 commits). The previous in-tx contract could
// not deliver its swallow guarantee — a hard SQL failure poisoned the
// shared tx so COMMIT downgraded to ROLLBACK regardless.
//
// Phase 7 review-fix C-TYPE-1 — the event shape lives in F8's port to
// eliminate the prior duplicate F3 + F8 definitions that only worked
// via TS structural typing.
import type {
  ManualPlanChangeEvent,
  ManualPlanChangeListener as ManualPlanChangeListenerCanonical,
} from '@/modules/renewals';
import type { PlanAdvisoryLockPort } from '../ports/plan-advisory-lock-port';
// W0-02 — shared lock-key builder from plans Domain (pure, no drizzle).
// Cross-module import through plans public barrel (Constitution Principle III).
import { planSoftDeleteLockKey } from '@/modules/plans';

export type ManualPlanChangeListenerEvent = ManualPlanChangeEvent;
export type ManualPlanChangeListener = ManualPlanChangeListenerCanonical;

export type ChangePlanDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  plans: PlanLookupPort;
  audit: AuditPort;
  /**
   * W0-02 — Advisory-lock acquirer for the soft-delete TOCTOU fix.
   *
   * `changePlan` acquires `plans:softdelete:<tenantSlug>:<planId>:<planYear>`
   * on the NEW plan at the start of the write tx, serialising with
   * `softDeleteGuarded` (Side A) which acquires the SAME key before
   * deleting. This prevents a plan from being soft-deleted while a member
   * is concurrently being assigned to it.
   *
   * The implementation (`drizzlePlanAdvisoryLockAdapter`) is a thin
   * wrapper over `tx.execute(sql\`SELECT pg_advisory_xact_lock(...)\`)`.
   */
  planAdvisoryLock: PlanAdvisoryLockPort;
  /**
   * F8 Phase 7 T188 / 063 (Option A) — listener array invoked
   * POST-COMMIT, after the change-plan tx (plan-flip +
   * `member_plan_manually_changed` audit) has committed durably. Each
   * listener runs in its OWN tenant tx (the bridge opens it) and is
   * best-effort: a failure is logged + counted and leaves the
   * (documented) supersede-orphan state for replay — it does NOT roll
   * back the plan-flip. F8's `f8OnManualPlanChangeCallbacks(tenantId)`
   * factory supplies the canonical pair (supersede pending tier-upgrade
   * + reschedule renewal cadence). Optional — when undefined, change-
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
  // W0-02 (code-review #1) — `getPlan`/`findOne` deliberately returns
  // soft-deleted plans, so a `newPlan.ok` row may still be soft-deleted. A
  // member must never be assigned to a soft-deleted plan. Pre-tx fast-fail;
  // the in-tx re-check under the advisory lock (below) closes the race where
  // the plan is soft-deleted after this snapshot but before the FK write.
  if (newPlan.value.isSoftDeleted) return err({ type: 'plan_not_found' });

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
  //
  // 063 (Option A) — the old plan id read under FOR UPDATE inside the tx
  // is hoisted here so the POST-COMMIT F8 listener event (dispatched
  // after this tx returns) can carry the exact pre-flip plan id.
  let lockedOldPlanId = '';
  try {
    const updatedMember = await runInTenant(deps.tenant, async (tx) => {
      // W0-02 — acquire the shared soft-delete advisory lock on the NEW plan
      // as the FIRST statement in this tx. This serialises with
      // `softDeleteGuarded` (Side A in plans module) which acquires the
      // SAME key before performing the member count + delete. The lock is
      // auto-released at tx COMMIT or ROLLBACK.
      // We lock the NEW plan (assigning TO a plan is the dangerous direction).
      const lockKey = planSoftDeleteLockKey(
        deps.tenant.slug,
        newPlan.value.planId as string,
        data.new_plan_year,
      );
      await deps.planAdvisoryLock.acquire(tx, lockKey);

      // W0-02 completion (code-review #1) — re-read the NEW plan's deletion
      // state UNDER the lock. The pre-tx `isSoftDeleted` snapshot can go stale
      // if a concurrent `softDeleteGuarded` (Side A) won this same lock first,
      // deleted the (0-member) plan, and committed in the window between our
      // snapshot read and here. Since we now hold the SAME key, any such delete
      // is committed + visible. Without this the member FK would land on a
      // soft-deleted plan — the exact integrity violation W0-02 targets.
      const newPlanSoftDeleted =
        await deps.planAdvisoryLock.isPlanSoftDeletedInTx(
          tx,
          newPlan.value.planId as string,
          data.new_plan_year,
        );
      if (newPlanSoftDeleted) {
        throw new TxAbort({ type: 'plan_not_found' });
      }

      // M1: re-read + LOCK the row inside the tx (FOR UPDATE) so the audit's
      // old_plan_* values reflect the row actually being overwritten, closing
      // the TOCTOU window between the pre-tx validation read and this write.
      // Pre-tx validation (bundle/turnover/startup) stays on the snapshot —
      // those are policy gates; only the recorded old-plan provenance must be
      // exact.
      const lockedResult = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!lockedResult.ok) {
        throw new TxAbort(
          lockedResult.error.code === 'repo.not_found'
            ? { type: 'not_found' }
            : { type: 'update_failed', code: lockedResult.error.code },
        );
      }
      const locked = lockedResult.value;
      // 063 — capture the pre-flip plan id for the post-commit F8 event.
      lockedOldPlanId = locked.planId as string;

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
          old_plan_id: locked.planId,
          old_plan_year: locked.planYear,
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
          // camelCase `memberId` (NOT snake `member_id`): this F8-supersede
          // event is consumed by event-TYPE (f2-plan-change-bridge), not by
          // the payload key, and has no member-timeline renderer. The sibling
          // `member_plan_changed` (emitted in the same tx) keeps snake
          // `member_id` to drive the F3 timeline + last_activity bump — so a
          // snake key here would only add a DUPLICATE raw-summary timeline row
          // + a redundant recency bump (raw event-name + UUID shown to members).
          memberId,
          old_plan_id: locked.planId,
          old_plan_year: locked.planYear,
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

      return updated.value;
    });

    // F8 Phase 7 T188 / 063 (Option A) — invoke the registered F8
    // listeners (supersede pending tier-upgrade + reschedule renewal
    // cadence) POST-COMMIT, after the tx above has committed durably.
    //
    // Each listener runs in its OWN tenant tx (the bridge opens it) and
    // is best-effort. The previous design ran them INSIDE this tx with
    // the shared `tx`; the bridge tried to swallow failures, but a hard
    // SQL failure poisons the Postgres tx so the COMMIT downgrades to
    // ROLLBACK — the plan-flip was silently lost regardless of the
    // swallow. Running them after the commit makes the plan-flip atomic
    // and the F8 bookkeeping eventual: a listener failure is logged +
    // counted by the bridge (`manualPlanChangeListenerFailed`) and
    // leaves the documented supersede-orphan state for replay, but does
    // NOT roll the plan-flip back. Mirrors the post-tx half of the
    // F4 → F8 `f8OnPaidCallbacks` pattern.
    //
    // The try/catch here is defence-in-depth only: production F8
    // listeners (the bridge) never throw (they catch + log + count
    // internally + return). A custom/test listener that bypasses that
    // contract is logged here but still does NOT fail the use-case — the
    // plan-flip is already committed, so `ok` is returned either way.
    const listeners = deps.manualPlanChangeListeners ?? [];
    if (listeners.length > 0) {
      const evt: ManualPlanChangeListenerEvent = {
        tenantId: deps.tenant.slug,
        memberId,
        oldPlanId: lockedOldPlanId,
        newPlanId: data.new_plan_id,
        actorUserId: meta.actorUserId,
        correlationId: meta.requestId,
        requestId: meta.requestId,
      };
      for (const listener of listeners) {
        try {
          await listener(evt);
        } catch (e) {
          logger.error(
            {
              err: e instanceof Error ? e.message : String(e),
              tenantId: deps.tenant.slug,
              memberId,
            },
            '[change-plan] post-commit manualPlanChangeListener threw — plan-flip already committed; ignored',
          );
        }
      }
    }

    return ok(updatedMember);
  } catch (e) {
    if (e instanceof TxAbort) {
      if (e.detail.type === 'not_found') {
        return err({ type: 'not_found' });
      }
      if (e.detail.type === 'plan_not_found') {
        return err({ type: 'plan_not_found' });
      }
      if (e.detail.type === 'update_failed') {
        return err({
          type: 'server_error',
          message: `update: ${e.detail.code}`,
        });
      }
      return err({ type: 'server_error', message: 'audit_failed' });
    }
    // Map any non-TxAbort throw (infra/connection error, or a custom
    // manualPlanChangeListener that bypasses wrapListener and propagates)
    // to a typed server_error — consistent with update-member /
    // member-self-update, rather than an unhandled 500 at the route layer.
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Internal abort-sentinel for rolling back change-plan's tx cleanly. */
class TxAbort extends Error {
  constructor(
    public readonly detail:
      | { type: 'update_failed'; code: string }
      | { type: 'audit_failed' }
      | { type: 'not_found' }
      | { type: 'plan_not_found' },
  ) {
    super(`tx-abort: ${detail.type}`);
  }
}
