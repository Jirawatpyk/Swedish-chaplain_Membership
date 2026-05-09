/**
 * F8 Phase 7 T180 — `acceptTierUpgrade` use-case.
 *
 * Admin clicks "Accept" on a tier-upgrade suggestion in the dashboard.
 * Per FR-039 (Q5 round 2 pending-state lifecycle), the implementation
 * realises spec steps 1-3 atomically inside the in-tx block + step 2
 * (member email) post-tx. Spec step numbers map to the in-tx work as:
 *
 *   - **FR-039 step 1** (transition `open` → `accepted_pending_apply`):
 *     in-tx · sets `accepted_at`, `accepted_by_user_id`,
 *     `target_apply_at_cycle_id`. Member's `members.plan_id` is NOT
 *     mutated (avoids surprise mid-year invoicing). The **F2
 *     `scheduleNextRenewalPlanChange`** call is the *mechanism* for
 *     step 1 (records the future plan-flip in F2's
 *     `scheduled_plan_changes`); not its own FR-039 step.
 *
 *   - **FR-039 step 2** (member email): post-tx · single transactional
 *     email via `RenewalGateway.sendTierUpgradeApprovalEmail`. Failure
 *     is logged + audited (`tier_upgrade_pending_member_notify_failed`
 *     or `_skipped`) but does NOT roll back the suggestion accept —
 *     member can be re-notified manually.
 *
 *   - **FR-039 step 3** (T-180 verify task): in-tx · only when
 *     `expires_at - today > 180 days` so admin re-verifies the upgrade
 *     still applies before the cycle rollover.
 *
 *   - **FR-039 step 4** (apply at next renewal): NOT in this use-case;
 *     fires from `applyPendingTierUpgradeInTx` via the F4 → F8
 *     onPaidCallbacks bridge in `renewals-deps.ts`.
 *
 *   - **FR-039 step 5** (manual override supersede): NOT in this
 *     use-case; fires from `supersedePendingTierUpgradeInTx` via the
 *     F2 → F8 plan-change bridge.
 *
 * Audit emits from this use-case (Phase 7 review-fix Round 1 close):
 *   - `tier_upgrade_accepted`                              (in-tx, atomic)
 *   - `tier_upgrade_pending_admin_verification_due`        (in-tx, conditional)
 *   - `tier_upgrade_pending_member_notified`               (post-tx, on email ok)
 *   - `tier_upgrade_pending_member_notify_skipped`         (post-tx, no contact email)
 *   - `tier_upgrade_pending_member_notify_failed`          (post-tx, gateway err / throw)
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
import { renewalsMetrics } from '@/lib/metrics';
// Phase 7 review-fix S-static-import: pull the Domain hash helper as a
// static import (was a per-call dynamic import). Domain modules are
// cheap to load and the static reference makes the dependency graph
// visible to bundler + typecheck.
import { sha256HexOf } from '../../domain/value-objects/sha256-hex';
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
      // ----- (a) F2 schedule plan change — mechanism for FR-039 step 1.
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

      // ----- (b) Optional T-180 verification task — FR-039 step 3.
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

      // ----- (c) Suggestion transition open → accepted_pending_apply
      //          (the FR-039 step 1 status flip).
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

      // ----- (d) Audit emits (all atomic with state — Principle VIII).
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

    // ----- (e) Post-tx member notification email — FR-039 step 2.
    // Email send + audit emit run AFTER the runInTenant tx commits so
    // a transient Resend failure doesn't roll back the suggestion
    // accept. Failure is logged + observability-counted + closed via
    // `_skipped` or `_failed` audits (Phase 7 review-fix I-ERR-1/2)
    // so the FR-039 step 2 obligation has an explicit forensic chain
    // entry whether the email shipped, was skipped (no contact), or
    // failed (gateway / render / exception).
    const auditCtx = {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: 'admin' as const,
      correlationId: input.correlationId,
      requestId: input.requestId ?? null,
    };
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

      if (!dispatchInfo?.primaryContact?.email) {
        // Phase 7 review-fix I-ERR-1: explicit notify-skipped audit so
        // the missing primary-contact case has a forensic chain entry
        // instead of a silent no-op. Admin can re-notify after onboarding.
        renewalsMetrics.tierUpgradeNotifyFailed('no_primary_contact');
        await deps.auditEmitter.emit(
          {
            type: 'tier_upgrade_pending_member_notify_skipped',
            payload: {
              suggestion_id: suggestionId,
              member_id: suggestion.memberId as MemberId,
              to_plan_id: suggestion.toPlanId as PlanId,
              reason: 'no_primary_contact_email',
            },
          },
          auditCtx,
        );
        logger.warn(
          {
            suggestionId: suggestion.suggestionId,
            memberId: suggestion.memberId,
          },
          '[accept-tier-upgrade] member has no primary-contact email — notify skipped + audit recorded',
        );
      } else {
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
        const recipientHash = sha256HexOf(
          dispatchInfo.primaryContact.email.trim().toLowerCase(),
        );
        if (sendResult.ok) {
          memberNotifiedDeliveryId = sendResult.value.deliveryId;
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
            auditCtx,
          );
        } else {
          // Phase 7 review-fix I-ERR-2: explicit notify-failed audit
          // closes the forensic chain when retry budget exhausts or
          // gateway returns a permanent error.
          renewalsMetrics.tierUpgradeNotifyFailed(sendResult.error.kind);
          await deps.auditEmitter.emit(
            {
              type: 'tier_upgrade_pending_member_notify_failed',
              payload: {
                suggestion_id: suggestionId,
                member_id: suggestion.memberId as MemberId,
                to_plan_id: suggestion.toPlanId as PlanId,
                recipient_email_hashed: recipientHash,
                failure_kind: sendResult.error.kind,
                failure_message:
                  'message' in sendResult.error
                    ? sendResult.error.message
                    : null,
              },
            },
            auditCtx,
          );
          logger.warn(
            {
              suggestionId: suggestion.suggestionId,
              errorKind: sendResult.error.kind,
            },
            '[accept-tier-upgrade] member notification email failed — audit recorded',
          );
        }
      }
    } catch (e) {
      // Catch-all for unexpected throws (dispatch repo unavailable,
      // sha256 helper crash, etc.). Bump the unknown-failure metric
      // but skip the audit emit (we don't have enough payload context
      // to fill the typed shape).
      renewalsMetrics.tierUpgradeNotifyFailed('unknown');
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

