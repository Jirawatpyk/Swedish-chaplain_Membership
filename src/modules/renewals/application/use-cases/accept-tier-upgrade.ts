/**
 * F8 Phase 7 T180 — `acceptTierUpgrade` use-case.
 *
 * Admin clicks "Accept" on a tier-upgrade suggestion in the dashboard.
 * Per FR-039 (Q5 round 2 pending-state lifecycle):
 *
 *   1. Suggestion `open` → `accepted_pending_apply` with
 *      `accepted_at`, `accepted_by_user_id`, `target_apply_at_cycle_id`.
 *      Member's `members.plan_id` is NOT mutated (avoids surprise
 *      mid-year invoicing).
 *   2. F2 `scheduleNextRenewalPlanChange` is called atomically inside
 *      the same tx — F2 stores the pending plan flip in
 *      `scheduled_plan_changes` keyed by (member, target cycle).
 *   3. Single transactional email dispatched to member's primary
 *      contact email via `RenewalGateway.sendTierUpgradeApprovalEmail`
 *      with audit `tier_upgrade_pending_member_notified`. Email send
 *      runs OUTSIDE the tx (post-commit) — failure is logged but
 *      doesn't roll back the suggestion accept (member can be
 *      re-notified manually if needed).
 *   4. If `expires_at - today > 180 days`, a T-180 verify task is
 *      created in `renewal_escalation_tasks` so admin re-verifies
 *      circumstances later.
 *
 * Audit emit:
 *   - `tier_upgrade_accepted`                              (in-tx, atomic)
 *   - `tier_upgrade_pending_admin_verification_due`        (in-tx, conditional)
 *   - `tier_upgrade_pending_member_notified`               (post-tx, on email success)
 *
 * RBAC (FR-052a): admin role only. Manager attempts MUST be
 * rejected by the route handler before this use-case is invoked;
 * the use-case validates the role anyway as defence-in-depth.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import {
  parseSuggestionId,
  type SuggestionId,
} from '../../domain/tier-upgrade-suggestion';
import { asTaskId, type TaskId } from '../../domain/renewal-escalation-task';
import type { CycleId } from '../../domain/renewal-cycle';
// Type-only — runtime no-op brand cast (Constitution Principle III).
import type { MemberId, PlanId } from '@/modules/members';

export const acceptTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  suggestionId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type AcceptTierUpgradeInput = z.infer<
  typeof acceptTierUpgradeInputSchema
>;

export interface AcceptTierUpgradeOutput {
  readonly suggestionId: SuggestionId;
  readonly targetApplyAtCycleId: CycleId;
  readonly verificationTaskId: TaskId | null;
  readonly scheduledChangeId: string;
  readonly memberNotifiedDeliveryId: string | null;
}

export type AcceptTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'suggestion_not_found' }
  | { readonly kind: 'suggestion_not_open' }
  | { readonly kind: 'no_active_cycle' }
  | { readonly kind: 'plan_change_failed'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

const VERIFICATION_LEAD_DAYS = 180;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function acceptTierUpgrade(
  deps: RenewalsDeps,
  rawInput: AcceptTierUpgradeInput,
): Promise<Result<AcceptTierUpgradeOutput, AcceptTierUpgradeError>> {
  const inputResult = parseInput(acceptTierUpgradeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const idParse = parseSuggestionId(input.suggestionId);
  if (!idParse.ok) {
    return err({ kind: 'invalid_input', message: 'invalid suggestion id' });
  }
  const suggestionId = idParse.value;

  const suggestion = await deps.tierUpgradeRepo.findById(
    input.tenantId,
    suggestionId,
  );
  if (suggestion === null) return err({ kind: 'suggestion_not_found' });
  if (suggestion.status !== 'open') {
    return err({ kind: 'suggestion_not_open' });
  }

  const activeCycle = await deps.cyclesRepo.findActiveForMember(
    input.tenantId,
    suggestion.memberId,
  );
  if (activeCycle === null) return err({ kind: 'no_active_cycle' });

  const now = deps.clock.now();
  const acceptedAt = now.toISOString();
  const expiresAt = new Date(activeCycle.expiresAt);
  const daysUntilExpiry = Math.floor(
    (expiresAt.getTime() - now.getTime()) / ONE_DAY_MS,
  );
  const verificationDueAt = new Date(
    expiresAt.getTime() - VERIFICATION_LEAD_DAYS * ONE_DAY_MS,
  ).toISOString();

  try {
    const txResult = await runInTenant(deps.tenant, async (tx) => {
      // ----- 1. F2 schedule plan change.
      let scheduledChangeId: string;
      try {
        const scheduled =
          await deps.scheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
            deps.tenant,
            {
              memberId: suggestion.memberId,
              effectiveAtCycleId: activeCycle.cycleId,
              fromPlanId: suggestion.fromPlanId,
              toPlanId: suggestion.toPlanId,
              scheduledByUserId: input.actorUserId,
              reason: `tier_upgrade_accepted:${suggestion.suggestionId}`,
            },
          );
        scheduledChangeId = scheduled.inserted.scheduledChangeId;
      } catch (e) {
        return err({
          kind: 'plan_change_failed' as const,
          message: (e as Error)?.message ?? 'unknown',
        });
      }

      // ----- 2. Optional T-180 verification task (FR-039 step 3).
      let verificationTaskId: TaskId | null = null;
      if (daysUntilExpiry > VERIFICATION_LEAD_DAYS) {
        try {
          const taskInsert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
            tenantId: input.tenantId,
            taskId: asTaskId(randomUUID()),
            memberId: suggestion.memberId,
            cycleId: activeCycle.cycleId,
            taskType: 'verify_pending_tier_upgrade',
            assignedToRole: 'admin',
            dueAt: verificationDueAt,
            relatedSuggestionId: suggestion.suggestionId,
          });
          verificationTaskId = taskInsert.row.taskId;
        } catch (e) {
          // Task creation is forensically valuable but not load-bearing.
          // Log + continue; the reconcile cron (T185) will surface
          // any orphan-pending suggestions.
          logger.warn(
            {
              err: e instanceof Error ? e.message : String(e),
              suggestionId: suggestion.suggestionId,
            },
            '[accept-tier-upgrade] T-180 verify task creation failed — continuing',
          );
        }
      }

      // ----- 3. Suggestion transition open → accepted_pending_apply.
      const transitionArgs: Parameters<
        typeof deps.tierUpgradeRepo.transitionStatus
      >[3] = {
        to: 'accepted_pending_apply' as const,
        acceptedAt,
        acceptedByUserId: input.actorUserId,
        targetApplyAtCycleId: activeCycle.cycleId,
        ...(verificationTaskId !== null
          ? { adminVerificationTaskId: verificationTaskId }
          : {}),
      };
      await deps.tierUpgradeRepo.transitionStatus(
        tx,
        input.tenantId,
        suggestionId,
        transitionArgs,
      );

      // ----- 4. Audit emits (all atomic with state).
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'tier_upgrade_accepted',
          payload: {
            suggestion_id: suggestionId,
            member_id: suggestion.memberId as MemberId,
            from_plan_id: suggestion.fromPlanId as PlanId,
            to_plan_id: suggestion.toPlanId as PlanId,
            target_apply_at_cycle_id: activeCycle.cycleId,
            scheduled_change_id: scheduledChangeId,
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

      if (verificationTaskId !== null) {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'tier_upgrade_pending_admin_verification_due',
            payload: {
              suggestion_id: suggestionId,
              member_id: suggestion.memberId as MemberId,
              verification_task_id: verificationTaskId,
              verification_due_at: verificationDueAt,
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
      }

      return ok({
        suggestionId,
        targetApplyAtCycleId: activeCycle.cycleId,
        verificationTaskId,
        scheduledChangeId,
      });
    });

    if (!txResult.ok) return txResult;

    // ----- 5. Post-tx member notification email (FR-039 step 2).
    // Email send + audit emit run AFTER the runInTenant tx commits so
    // a transient Resend failure doesn't roll back the suggestion
    // accept. Failure is logged + surfaced in the response (delivery
    // id null); admin can re-notify manually if needed.
    let memberNotifiedDeliveryId: string | null = null;
    try {
      const dispatchInfo = await deps.dispatchCandidateRepo.findOne(
        input.tenantId,
        txResult.value.targetApplyAtCycleId,
      );
      const planFrozen = await deps.planLookupForRenewal.loadPlanFrozenFields({
        tenantId: input.tenantId,
        planId: suggestion.toPlanId,
      });
      const planName =
        planFrozen.status === 'found'
          ? planFrozen.plan.tierBucket
          : suggestion.toPlanId;
      if (dispatchInfo?.primaryContact?.email) {
        const sendResult = await deps.renewalGateway.sendTierUpgradeApprovalEmail(
          {
            tenantId: input.tenantId,
            recipient: {
              memberId: suggestion.memberId,
              toEmail: dispatchInfo.primaryContact.email,
              toName: dispatchInfo.primaryContact.firstName,
              preferredLocale: dispatchInfo.primaryContact.preferredLanguage,
            },
            memberCompanyName: dispatchInfo.member.companyName,
            targetPlanName: planName,
            effectiveAtIso: activeCycle.expiresAt,
            idempotencyKey: suggestion.suggestionId,
            correlationId: input.correlationId,
          },
        );
        if (sendResult.ok) {
          memberNotifiedDeliveryId = sendResult.value.deliveryId;
          // Post-tx audit emit (no tx; uses .emit not .emitInTx).
          const recipientHash = await sha256HexLower(
            dispatchInfo.primaryContact.email,
          );
          await deps.auditEmitter.emit(
            {
              type: 'tier_upgrade_pending_member_notified',
              payload: {
                suggestion_id: suggestionId,
                member_id: suggestion.memberId as MemberId,
                to_plan_id: suggestion.toPlanId as PlanId,
                recipient_email_hashed: recipientHash,
                delivery_id: memberNotifiedDeliveryId,
                effective_at: activeCycle.expiresAt,
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
        } else {
          logger.warn(
            {
              suggestionId: suggestion.suggestionId,
              errorKind: sendResult.error.kind,
            },
            '[accept-tier-upgrade] member notification email failed — continuing',
          );
        }
      }
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          suggestionId: suggestion.suggestionId,
        },
        '[accept-tier-upgrade] member notification path threw — continuing',
      );
    }

    return ok({
      suggestionId,
      targetApplyAtCycleId: txResult.value.targetApplyAtCycleId,
      verificationTaskId: txResult.value.verificationTaskId,
      scheduledChangeId: txResult.value.scheduledChangeId,
      memberNotifiedDeliveryId,
    });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}

async function sha256HexLower(
  raw: string,
): Promise<import('../../domain/value-objects/sha256-hex').Sha256Hex> {
  const { sha256HexOf } = await import(
    '../../domain/value-objects/sha256-hex'
  );
  return sha256HexOf(raw.trim().toLowerCase());
}
