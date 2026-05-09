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
 *     mutated (avoids surprise mid-year invoicing). The mechanism is
 *     a direct call to `scheduledPlanChangeRepo.supersedeAndInsertPendingAtomically`
 *     (review-fix Round 2 comment-S1: was previously documented as
 *     "F2 scheduleNextRenewalPlanChange" use-case wrapper but the code
 *     calls the repo method directly — same atomic supersede-and-insert
 *     semantics, but grep-able to the actual call site).
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
 * Audit emits from this use-case (Phase 7 review-fix Round 1+2+3):
 *   - `tier_upgrade_accepted`                              (in-tx, atomic)
 *   - `tier_upgrade_pending_admin_verification_due`        (in-tx, conditional)
 *   - `tier_upgrade_pending_member_notified`               (post-tx, on email ok)
 *   - `tier_upgrade_pending_member_notify_skipped`         (post-tx, no contact email)
 *   - `tier_upgrade_pending_member_notify_failed`          (post-tx, gateway err / threw — Round 3 IMP-2 added 'threw' branch)
 *
 * Counters wired in this use-case:
 *   - `tierUpgradeNotifyFailed{failure_kind}`              (per-branch on send/skip/throw failure)
 *   - `tierUpgradeAuditEmitFailed{audit_type}`             (Round 2 CRIT-2 differentiator — fires
 *                                                           when audit emit itself throws so on-call
 *                                                           can distinguish "email shipped, audit
 *                                                           missing" from "email send failed")
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
// Round 3 type SUG-3 + Round 4 SUG-1 — hoist gateway error type
// to a top-of-file `import type` instead of inline dynamic-import
// type-only reference inside the discriminated-union literal
// (the inline form was a `SendRenewalEmailError` lookup, not a
// TypeScript Brand — the prior comment misnamed the construct).
import type { SendRenewalEmailError } from '../ports/renewal-gateway';
import type { Sha256Hex } from '../../domain/value-objects/sha256-hex';

/**
 * Round 3 type SUG-3 + simplification — hoisted discriminated-union
 * for the post-tx member-notification result. Each arm carries the
 * data the corresponding audit emit branch needs.
 */
type GatewayResult =
  | { readonly kind: 'no_recipient' }
  | { readonly kind: 'sent'; readonly deliveryId: string; readonly recipientHash: Sha256Hex }
  | {
      readonly kind: 'failed';
      readonly recipientHash: Sha256Hex;
      readonly error: SendRenewalEmailError;
    }
  | { readonly kind: 'threw'; readonly error: unknown };

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
    // Phase 7 review-fix Round 2 CRIT-2: split outer catch into 2
    // narrower scopes so an audit-emit failure (production pgEnum
    // drift → pinoFallback throws) does NOT misclassify as a gateway
    // failure. Audit-emit failures bump `tierUpgradeAuditEmitFailed`
    // (separate counter) so on-call can differentiate "email
    // succeeded but audit row missing" from "email send failed".
    let dispatchInfo: Awaited<
      ReturnType<typeof deps.dispatchCandidateRepo.findOne>
    > = null;
    let planName = suggestion.toPlanId;
    // Round 3 silent SUG-3 — initialise to `'threw'` so any failure
    // to enter the try block (or refactor that moves work outside
    // the try) surfaces loudly via the threw-branch audit emit
    // instead of silently firing the no_recipient skip path.
    let gatewayResult: GatewayResult = {
      kind: 'threw',
      error: new Error('not_yet_evaluated'),
    };

    try {
      dispatchInfo = await deps.dispatchCandidateRepo.findOne(
        input.tenantId,
        txResult.value.targetApplyAtCycleId,
      );
      const planFrozen = await deps.planLookupForRenewal.loadPlanFrozenFields({
        tenantId: input.tenantId,
        planId: suggestion.toPlanId,
      });
      planName =
        planFrozen.status === 'found'
          ? planFrozen.plan.tierBucket
          : suggestion.toPlanId;

      if (!dispatchInfo?.primaryContact?.email) {
        gatewayResult = { kind: 'no_recipient' };
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
          gatewayResult = {
            kind: 'sent',
            deliveryId: sendResult.value.deliveryId,
            recipientHash,
          };
        } else {
          gatewayResult = {
            kind: 'failed',
            recipientHash,
            error: sendResult.error,
          };
        }
      }
    } catch (e) {
      // Gateway / lookup / hash crash — does NOT include audit-emit
      // throws (those are isolated to the per-emit try/catch below).
      gatewayResult = { kind: 'threw', error: e };
      renewalsMetrics.tierUpgradeNotifyFailed('unknown');
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          suggestionId: suggestion.suggestionId,
        },
        '[accept-tier-upgrade] gateway / lookup path threw — emitting failed audit',
      );
    }

    // Per-branch audit emit, each in its own try/catch + dedicated
    // counter for emit failures (CRIT-2 forensic split).
    if (gatewayResult.kind === 'no_recipient') {
      renewalsMetrics.tierUpgradeNotifyFailed('no_primary_contact');
      try {
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
      } catch (auditErr) {
        renewalsMetrics.tierUpgradeAuditEmitFailed(
          'tier_upgrade_pending_member_notify_skipped',
        );
        logger.error(
          {
            err: auditErr instanceof Error ? auditErr.message : String(auditErr),
            suggestionId: suggestion.suggestionId,
          },
          '[accept-tier-upgrade] notify_skipped audit emit failed — counter bumped',
        );
      }
      logger.warn(
        {
          suggestionId: suggestion.suggestionId,
          memberId: suggestion.memberId,
        },
        '[accept-tier-upgrade] member has no primary-contact email — notify skipped + audit attempted',
      );
    } else if (gatewayResult.kind === 'sent') {
      try {
        await deps.auditEmitter.emit(
          {
            type: 'tier_upgrade_pending_member_notified',
            payload: {
              suggestion_id: suggestionId,
              member_id: suggestion.memberId as MemberId,
              to_plan_id: suggestion.toPlanId as PlanId,
              recipient_email_hashed: gatewayResult.recipientHash,
              delivery_id: gatewayResult.deliveryId,
              effective_at: activeCycle.expiresAt,
            },
          },
          auditCtx,
        );
      } catch (auditErr) {
        // CRIT-2: email shipped successfully — audit row missing is
        // distinct from gateway failure. Bump audit-emit-failed
        // counter, NOT tierUpgradeNotifyFailed.
        renewalsMetrics.tierUpgradeAuditEmitFailed(
          'tier_upgrade_pending_member_notified',
        );
        logger.error(
          {
            err: auditErr instanceof Error ? auditErr.message : String(auditErr),
            suggestionId: suggestion.suggestionId,
            deliveryId: gatewayResult.deliveryId,
          },
          '[accept-tier-upgrade] notified audit emit failed (email shipped) — counter bumped',
        );
      }
    } else if (gatewayResult.kind === 'failed') {
      renewalsMetrics.tierUpgradeNotifyFailed(gatewayResult.error.kind);
      // R2-IMP-3: preserve actionable metadata for the
      // template_variables_missing variant (carries `missing[]` not
      // `message`). Fall back to comma-joined missing list.
      const failureMessage =
        'message' in gatewayResult.error
          ? gatewayResult.error.message
          : 'missing' in gatewayResult.error
            ? `template_variables_missing: ${(gatewayResult.error as { missing: ReadonlyArray<string> }).missing.join(',')}`
            : null;
      try {
        await deps.auditEmitter.emit(
          {
            type: 'tier_upgrade_pending_member_notify_failed',
            payload: {
              suggestion_id: suggestionId,
              member_id: suggestion.memberId as MemberId,
              to_plan_id: suggestion.toPlanId as PlanId,
              recipient_email_hashed: gatewayResult.recipientHash,
              failure_kind: gatewayResult.error.kind,
              failure_message: failureMessage,
            },
          },
          auditCtx,
        );
      } catch (auditErr) {
        renewalsMetrics.tierUpgradeAuditEmitFailed(
          'tier_upgrade_pending_member_notify_failed',
        );
        logger.error(
          {
            err: auditErr instanceof Error ? auditErr.message : String(auditErr),
            suggestionId: suggestion.suggestionId,
            errorKind: gatewayResult.error.kind,
          },
          '[accept-tier-upgrade] notify_failed audit emit failed — counter bumped',
        );
      }
      logger.warn(
        {
          suggestionId: suggestion.suggestionId,
          errorKind: gatewayResult.error.kind,
        },
        '[accept-tier-upgrade] member notification email failed — audit attempted',
      );
    }
    // gatewayResult.kind === 'threw' branch — Round 3 IMP-2 + Round 4
    // SUG-2 closes the forensic-chain gap. Rounds 1+2 emitted no audit
    // for this branch because the audit shape required a non-null
    // `recipient_email_hashed`, which the throw-path doesn't have
    // (the hash is computed AFTER the gateway call resolves). Round 3
    // relaxed the field to `Sha256Hex | null` so all 4 GatewayResult
    // arms have an audit row. The outer catch already bumped
    // tierUpgradeNotifyFailed counter; this fires the corresponding
    // `_failed` audit with `failure_kind: 'unknown'` + null hash.
    else if (gatewayResult.kind === 'threw') {
      try {
        await deps.auditEmitter.emit(
          {
            type: 'tier_upgrade_pending_member_notify_failed',
            payload: {
              suggestion_id: suggestionId,
              member_id: suggestion.memberId as MemberId,
              to_plan_id: suggestion.toPlanId as PlanId,
              recipient_email_hashed: null,
              failure_kind: 'unknown',
              failure_message:
                gatewayResult.error instanceof Error
                  ? gatewayResult.error.message.slice(0, 500)
                  : String(gatewayResult.error).slice(0, 500),
            },
          },
          auditCtx,
        );
      } catch (auditErr) {
        renewalsMetrics.tierUpgradeAuditEmitFailed(
          'tier_upgrade_pending_member_notify_failed',
        );
        logger.error(
          {
            err: auditErr instanceof Error ? auditErr.message : String(auditErr),
            suggestionId: suggestion.suggestionId,
          },
          '[accept-tier-upgrade] threw-branch notify_failed audit emit failed — counter bumped',
        );
      }
    } else {
      // Round 4 CRIT-3 — exhaustiveness pin on the GatewayResult
      // discriminated union. If a future arm is added (e.g.
      // 'rate_limited'), the `_exhaustive: never` type assertion
      // FAILS at compile time, forcing the contributor to wire an
      // audit-emit branch above. Pattern matches `renewal-gateway.ts`
      // `isPermanentGatewayError` and `renewals-deps.ts` outcome
      // dispatch. The runtime branch is unreachable but throws to
      // surface logic-bug regressions loudly (no silent skip).
      const _exhaustive: never = gatewayResult;
      void _exhaustive;
      throw new Error(
        `[accept-tier-upgrade] unhandled GatewayResult kind — possible new arm without audit emit wiring`,
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

