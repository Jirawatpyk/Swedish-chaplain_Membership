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
// Round 6 W-004 — sanitize Resend SDK exception messages before
// they land in audit_log.payload (5y retention). Prevents API key
// prefix / email address leakage from raw `error.message` strings.
// Imported from Domain (relocated in Round 6) so no
// Application → Infrastructure boundary violation.
import { sanitizeResendErrorMessage } from '../../domain/value-objects/sanitize-error-message';
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
// 065 Fix 1 — CAS-loser error from the repo's transitionStatus
// (W-011 double-accept TOCTOU close). Value import of a port-owned
// error class — Application importing its own ports is Principle-III
// clean.
import { TierUpgradeStatusConflictError } from '../ports/tier-upgrade-suggestion-repo';

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

// Round 5 SUG-1 — compile-time pin on the GatewayResult arm count.
// Mutual subtype assertion: any divergence between the canonical
// union and the explicit-arm tuple type fails compile, surfacing
// arm additions/removals at the type-system layer (companion to
// the runtime `_exhaustive: never` pin in the if-chain below).
type _GatewayResultArmsLocked =
  | { readonly kind: 'no_recipient' }
  | { readonly kind: 'sent'; readonly deliveryId: string; readonly recipientHash: Sha256Hex }
  | {
      readonly kind: 'failed';
      readonly recipientHash: Sha256Hex;
      readonly error: SendRenewalEmailError;
    }
  | { readonly kind: 'threw'; readonly error: unknown };
type _AssertGatewayResultLocked = [
  _GatewayResultArmsLocked extends GatewayResult ? true : never,
  GatewayResult extends _GatewayResultArmsLocked ? true : never,
];
const _gatewayResultArmsLocked: _AssertGatewayResultLocked = [true, true];
void _gatewayResultArmsLocked;

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

  // Pre-tx repo lookups MUST be wrapped so a DB drop / RLS error /
  // drizzle parse error doesn't escape the Result contract. Without
  // this, the throw bubbles past the use-case to the route's outer
  // try/catch where it lands as `accept_unexpected_error` with NO
  // `errorId` in the canonical `F8.ACCEPT_TIER.*` taxonomy.
  // Constitution Principle VIII.
  let suggestion;
  let activeCycle;
  try {
    suggestion = await deps.tierUpgradeRepo.findById(
      input.tenantId,
      suggestionId,
    );
    if (suggestion === null) return err({ kind: 'suggestion_not_found' });
    if (suggestion.status !== 'open') {
      return err({ kind: 'suggestion_not_open' });
    }

    activeCycle = await deps.cyclesRepo.findActiveForMember(
      input.tenantId,
      suggestion.memberId,
    );
    if (activeCycle === null) return err({ kind: 'no_active_cycle' });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: `pre-tx-repo-lookup: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

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
      let supersededScheduledChangeId: string | null = null;
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
        // Capture the superseded prior-pending row id (if any) so the
        // post-tx emit branch fires the F2-domain
        // `plan_change_superseded` audit. `null` when this was a fresh
        // schedule with no prior pending row on the same (member, cycle).
        supersededScheduledChangeId =
          scheduled.superseded?.scheduledChangeId ?? null;
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
        // 065 Fix 1 — CAS guard. The pre-tx findById `open` check is
        // a stale read by the time this UPDATE runs (W-011 TOCTOU);
        // the repo re-checks `status='open'` atomically and throws
        // `TierUpgradeStatusConflictError` when a concurrent accept
        // already won — mapped to `suggestion_not_open` in the outer
        // catch below (the throw also rolls this tx back).
        expectedFrom: 'open' as const,
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
      // Phase 9 / T231 — tier-upgrade accept volume counter
      // (FR-039 funnel signal). Pairs with `tierUpgradeSuggestionsCreated`
      // — dashboard ratio measures admin engagement.
      renewalsMetrics.tierUpgradeSuggestionsAccepted(input.tenantId);

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
        supersededScheduledChangeId,
      });
    });

    if (!txResult.ok) return txResult;

    // ----- (a.5) Post-tx F2-domain audit emit (post-ship R6 I2 / D2,
    // 2026-05-19). F8's tier_upgrade_accepted (emitted in-tx above) is
    // the F8-domain audit trail; F2's plan_change_scheduled is the
    // F2-domain audit trail for the same atomic state change. Each
    // module owns its own audit taxonomy per Constitution Principle III.
    //
    // Runs OUTSIDE the renewal tx — F2's planAuditAdapter opens its
    // own runInTenant tx. A failure here leaves the F8 state intact
    // (suggestion accepted, scheduled-plan-change row in place) but
    // emits a critical log so on-call can backfill the F2 audit row.
    // Pattern mirrors the post-tx member-notification email below.
    // The requestId default is a sentinel that preserves cross-request
    // correlation when not supplied. Empty
    // strings pass `audit_log.request_id NOT NULL` but defeat the
    // column's purpose. The sentinel `system:accept-tier-upgrade:<id>`
    // gives SRE a deterministic key + matches the F4 onPaid pattern
    // (`f8-onPaid:<invoiceId>`).
    const f2AuditCtx = {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId:
        input.requestId ?? `system:accept-tier-upgrade:${suggestion.suggestionId}`,
      sourceIp: null,
    };
    try {
      const scheduledAuditResult = await deps.f2AuditEmitter.record(
        f2AuditCtx,
        {
          event_type: 'plan_change_scheduled',
          payload: {
            member_id: suggestion.memberId,
            scheduled_change_id: txResult.value.scheduledChangeId,
            effective_at_cycle_id: activeCycle.cycleId,
            from_plan_id: suggestion.fromPlanId,
            to_plan_id: suggestion.toPlanId,
            reason: `tier_upgrade_accepted:${suggestion.suggestionId}`,
          },
        },
      );
      if (!scheduledAuditResult.ok) {
        // `errorId` field aligns with the `F2.PLAN_CHANGE.*`
        // convention used at the F8
        // onPaid finaliser. Sentry / Grafana alert rules built
        // against `errorId: 'F2.PLAN_CHANGE.*'` now catch BOTH the
        // schedule-side (this site) and the apply-side
        // (apply-tier-upgrade-on-paid-callback.ts).
        logger.error(
          {
            errorId: 'F2.PLAN_CHANGE.SCHEDULED_AUDIT_EMIT_FAILED',
            event: 'accept_tier_upgrade.f2_audit_emit_failed',
            audit_event: 'plan_change_scheduled',
            err: scheduledAuditResult.error,
            suggestionId: suggestion.suggestionId,
            scheduledChangeId: txResult.value.scheduledChangeId,
          },
          '[accept-tier-upgrade] F2 plan_change_scheduled audit emit failed — F8 state committed; operator backfill needed',
        );
      }

      // Emit plan_change_superseded only when the in-tx repo call
      // actually bumped a prior pending row.
      if (txResult.value.supersededScheduledChangeId !== null) {
        const supersededAuditResult = await deps.f2AuditEmitter.record(
          f2AuditCtx,
          {
            event_type: 'plan_change_superseded',
            payload: {
              member_id: suggestion.memberId,
              scheduled_change_id:
                txResult.value.supersededScheduledChangeId,
              effective_at_cycle_id: activeCycle.cycleId,
              superseded_by_scheduled_change_id:
                txResult.value.scheduledChangeId,
            },
          },
        );
        if (!supersededAuditResult.ok) {
          // errorId for alert-routing parity.
          logger.error(
            {
              errorId: 'F2.PLAN_CHANGE.SUPERSEDED_AUDIT_EMIT_FAILED',
              event: 'accept_tier_upgrade.f2_audit_emit_failed',
              audit_event: 'plan_change_superseded',
              err: supersededAuditResult.error,
              suggestionId: suggestion.suggestionId,
              supersededScheduledChangeId:
                txResult.value.supersededScheduledChangeId,
            },
            '[accept-tier-upgrade] F2 plan_change_superseded audit emit failed — F8 state committed; operator backfill needed',
          );
        }
      }
    } catch (auditErr) {
      // Defence-in-depth: the F2 emitter itself shouldn't throw (it
      // wraps in try/catch + returns Result.err), but if it does we
      // still want F8's main flow to continue. Bumping a dedicated
      // counter via the F8 emitter is appropriate but the F8 emitter
      // is typed to F8 events; just log critically.
      // errorId for alert-routing parity with the `F2.PLAN_CHANGE.*`
      // convention.
      logger.error(
        {
          errorId: 'F2.PLAN_CHANGE.AUDIT_EMIT_THREW',
          event: 'accept_tier_upgrade.f2_audit_emit_threw',
          err: auditErr instanceof Error ? auditErr.message : String(auditErr),
          suggestionId: suggestion.suggestionId,
        },
        '[accept-tier-upgrade] F2 audit emitter threw — F8 state committed; operator backfill needed',
      );
    }

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
              // Round 6 W-004 — sanitize Resend SDK exception messages
              // (may contain API key prefix `re_…` or email addresses)
              // before persisting in audit_log (5y retention).
              failure_message: sanitizeResendErrorMessage(
                gatewayResult.error instanceof Error
                  ? gatewayResult.error.message
                  : String(gatewayResult.error),
              ).slice(0, 500),
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
      // Round 4 CRIT-3 + Round 5 IMP-1/IMP-3 — exhaustiveness pin on
      // the GatewayResult discriminated union. If a future arm is
      // added (e.g. 'rate_limited'), the `_exhaustive: never` type
      // assertion FAILS at compile time, forcing the contributor to
      // wire an audit-emit branch above. Pattern matches `renewal-
      // gateway.ts isPermanentGatewayError` and `renewals-deps.ts`
      // outcome dispatch.
      //
      // Round 5 IMP-1 + IMP-3 — defence-in-depth for the unreachable
      // runtime path: bump `tierUpgradeNotifyFailed('unknown')` (R5
      // IMP-3 closes the missing-counter gap so a deploy-skew arm
      // surfaces on dashboards, NOT only via 500-toast) AND emit the
      // `_member_notify_failed` audit row before throwing (R5 IMP-1
      // closes the state-mismatch UX gap — the DB tx already committed
      // suggestion → accepted_pending_apply, so the admin's "error"
      // toast must still leave a forensic trail explaining the silent
      // server-side success).
      renewalsMetrics.tierUpgradeNotifyFailed('unknown');
      logger.error(
        {
          gatewayResultKind:
            (gatewayResult as { kind?: string }).kind ?? 'unknown',
          suggestionId: suggestion.suggestionId,
        },
        '[accept-tier-upgrade] unhandled GatewayResult kind — deploy-skew? See exhaustiveness pin below',
      );
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
              failure_message: `unhandled_gateway_arm:${(gatewayResult as { kind?: string }).kind ?? 'unknown'}`.slice(
                0,
                500,
              ),
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            correlationId: input.correlationId,
            requestId: null,
          },
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
          '[accept-tier-upgrade] unhandled-arm audit emit failed — counter bumped',
        );
      }
      // Return typed server_error instead of throwing into the outer
      // catch. Preserves the compile-time
      // exhaustiveness pin (`_exhaustive: never`) AND surfaces the
      // unhandled-arm kind operationally so alert routing can match
      // on `message: 'deploy-skew:unhandled-gateway-arm:*'`.
      const _exhaustive: never = gatewayResult;
      return err({
        kind: 'server_error',
        message: `deploy-skew:unhandled-gateway-arm:${(_exhaustive as { kind?: string }).kind ?? 'undefined'}`,
      });
    }

    return ok({
      suggestionId,
      targetApplyAtCycleId: txResult.value.targetApplyAtCycleId,
      verificationTaskId: txResult.value.verificationTaskId,
      scheduledChangeId: txResult.value.scheduledChangeId,
      memberNotifiedDeliveryId,
    });
  } catch (e) {
    // R5-S9 caller-responsibility contract:
    //
    // This use-case wraps internal throws as a typed `server_error`
    // Result so callers can route them via the Application-layer
    // error union (Constitution III — Application MUST NOT import
    // `@/lib/logger`).
    //
    // The HTTP route caller at
    // `src/app/api/admin/renewals/tier-upgrades/[suggestionId]/accept/route.ts`
    // logs both `kind:'server_error'` (R4-C2 `errorId:
    // 'F8.ACCEPT_TIER.SERVER_ERROR'`) AND any uncaught throw
    // (R4-I4 outer catch `errorId: 'F8.ACCEPT_TIER.UNEXPECTED'`)
    // — so the HTTP path is fully covered.
    //
    // If a future non-HTTP caller (cron, queue worker, internal
    // service) invokes `acceptTierUpgrade(...)`, THAT caller MUST
    // wrap the call with equivalent log emission. The Result.err
    // `message` field carries the original throw's message verbatim
    // for diagnostic purposes; callers should log with errorId
    // matching their context (e.g., `F8.ACCEPT_TIER.CRON_INVOKED_THREW`).
    //
    // 065 Fix 1 — the transitionStatus CAS loser throws
    // `TierUpgradeStatusConflictError` from inside the runInTenant
    // block (MUST throw, not return err — returning would COMMIT the
    // partial tx, e.g. the step-(b) verification task). Map it here
    // to the same typed error the pre-tx `status !== 'open'` check
    // yields, so the admin sees one consistent conflict shape.
    if (e instanceof TierUpgradeStatusConflictError) {
      return err({ kind: 'suggestion_not_open' });
    }
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}

