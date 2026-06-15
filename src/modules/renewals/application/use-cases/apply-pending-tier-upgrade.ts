/**
 * F8 Phase 7 T183 — `applyPendingTierUpgrade` use-case.
 *
 * Called from the F4 invoice-paid hook. When F4 marks an invoice
 * paid (mark-paid-offline path or Stripe-webhook path), it fires
 * the `f8OnPaidCallbacks` array. The 2nd entry of that array
 * (registered in `renewals-deps.ts:f8OnPaidCallbacks` post Phase 7
 * review-fix E2) resolves the cycle linked to the invoice and
 * invokes `applyPendingTierUpgradeInTx` atomically with the F4 tx.
 * This use-case then transitions any `accepted_pending_apply`
 * suggestion targeting that cycle to `applied` + emits the audit.
 *
 * **F2 plan-flip status**:
 * F4's invoice-creation step consults F2's `getEffectivePlanForRenewal`
 * resolver — pending `scheduled_plan_changes` rows DRIVE the invoice
 * price even though `members.plan_id` itself is not flipped here. The
 * F2 `scheduled_plan_changes.status` transition from `pending` →
 * `applied` lives in the shared
 * `application/use-cases/finalise-f2-plan-change-on-paid.ts` use-case,
 * called POST-commit by BOTH the online F4 invoice-paid callback and the
 * offline admin mark-paid path (070 Item D); the `_lib`
 * `_internal.finaliseF2ScheduledPlanChangeForCycle` is now a thin
 * online-actor wrapper over it. The audit chain
 * `tier_upgrade_applied_at_renewal` is the F8 canonical apply event; the F2
 * audit chain (`plan_change_applied`) lands post-tx alongside it.
 * `members.plan_id` flip remains a future feature.
 *
 * Audit: emits `tier_upgrade_applied_at_renewal` (atomic with the
 * suggestion transition).
 *
 * Idempotent on suggestion `applied`: re-firing the use-case for an
 * already-applied suggestion is a no-op + does NOT re-emit audit.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { TenantTx } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import { type SuggestionId } from '../../domain/tier-upgrade-suggestion';
// 065 Fix 1 — CAS-loser error from the repo's transitionStatus.
import { TierUpgradeStatusConflictError } from '../ports/tier-upgrade-suggestion-repo';
import { parseCycleId, type CycleId } from '../../domain/renewal-cycle';
import type { MemberId, PlanId } from '@/modules/members';
import { parseInvoiceId, type InvoiceId } from '@/modules/invoicing';
import type { RenewalActorRole } from '../ports/renewal-audit-emitter';

/**
 * Actor context for the `tier_upgrade_applied_at_renewal` audit emitted
 * by `applyPendingTierUpgradeInTx`. The default (online F4 invoice-paid
 * paths — Stripe webhook + record-payment) is the canonical
 * `{ actorUserId: null, actorRole: 'webhook' }`. The OFFLINE admin
 * mark-paid path (070 Item D) overrides with the admin's user id +
 * `'admin'` role, since that path is an admin-initiated out-of-band
 * settlement, not a webhook delivery — the admin is the accurate actor
 * for the cascade. `RenewalActorRole` already includes `'admin'`, so no
 * enum change is required.
 */
export interface ApplyTierUpgradeActor {
  readonly actorUserId: string | null;
  readonly actorRole: RenewalActorRole;
}

const DEFAULT_APPLY_ACTOR: ApplyTierUpgradeActor = {
  actorUserId: null,
  actorRole: 'webhook',
};

export const applyPendingTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type ApplyPendingTierUpgradeInput = z.infer<
  typeof applyPendingTierUpgradeInputSchema
>;

export interface ApplyPendingTierUpgradeOutput {
  readonly suggestionsApplied: ReadonlyArray<SuggestionId>;
}

export type ApplyPendingTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Apply tier-upgrade suggestions targeting `cycleId`. Called inside
 * an existing tenant tx by the F4 invoice-paid hook (the cycle and
 * invoice writes commit alongside the suggestion transition + audit).
 */
export async function applyPendingTierUpgradeInTx(
  deps: RenewalsDeps,
  tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly cycleId: CycleId;
    readonly invoiceId: InvoiceId;
    readonly correlationId: string;
    readonly requestId: string | null;
    /**
     * 070 Item D — optional actor override for the apply audit. Defaults
     * to the online `{ actorUserId: null, actorRole: 'webhook' }` so the
     * Stripe-webhook + record-payment callers are unchanged; the OFFLINE
     * admin mark-paid path passes `{ actorUserId: <admin>, actorRole:
     * 'admin' }` so the cascade audit reflects the real admin actor.
     */
    readonly actor?: ApplyTierUpgradeActor;
  },
): Promise<ReadonlyArray<SuggestionId>> {
  const actor = args.actor ?? DEFAULT_APPLY_ACTOR;
  const pending = await deps.tierUpgradeRepo.findPendingForCycle(
    args.tenantId,
    args.cycleId,
  );
  if (pending.length === 0) return [];

  const now = deps.clock.now();
  const appliedAt = now.toISOString();
  const applied: SuggestionId[] = [];

  for (const suggestion of pending) {
    if (suggestion.status !== 'accepted_pending_apply') continue;

    try {
      await deps.tierUpgradeRepo.transitionStatus(
        tx,
        args.tenantId,
        suggestion.suggestionId,
        {
          to: 'applied' as const,
          // 065 Fix 1 — CAS guard against the stale
          // `findPendingForCycle` read above.
          expectedFrom: 'accepted_pending_apply' as const,
          appliedAt,
          appliedAtInvoiceId: args.invoiceId,
          closedAt: appliedAt,
        },
      );
    } catch (e) {
      // 065 Fix 1 — CAS loser: a concurrent transition (supersede /
      // reconcile-dismiss / racing duplicate apply) moved the row off
      // `accepted_pending_apply` between the read and this UPDATE.
      // Skipping preserves the documented idempotency contract AND —
      // critically — does NOT abort the caller's F4 invoice-paid tx.
      // Safe to continue inside the tx: the 0-row CAS miss is a
      // JS-thrown error, not a SQL error, so the tx is not poisoned.
      if (e instanceof TierUpgradeStatusConflictError) continue;
      throw e;
    }

    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'tier_upgrade_applied_at_renewal',
        payload: {
          suggestion_id: suggestion.suggestionId,
          member_id: suggestion.memberId as MemberId,
          from_plan_id: suggestion.fromPlanId as PlanId,
          to_plan_id: suggestion.toPlanId as PlanId,
          applied_at_cycle_id: args.cycleId,
          applied_at_invoice_id: args.invoiceId,
        },
      },
      {
        tenantId: args.tenantId,
        // 070 Item D — actor is parameterised. The online F4 invoice-paid
        // paths (Stripe webhook via markPaidFromProcessor + record-payment)
        // keep the canonical `{ actorUserId: null, actorRole: 'webhook' }`
        // default; the OFFLINE admin mark-paid path passes the admin's
        // user id + `'admin'` role, since that path is an admin-initiated
        // out-of-band settlement (the admin is the accurate actor for the
        // cascade), not a webhook delivery.
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        correlationId: args.correlationId,
        requestId: args.requestId,
      },
    );

    applied.push(suggestion.suggestionId);
  }
  return applied;
}

/**
 * Standalone wrapper for callers without an existing tx (admin
 * manual replay, tests). Opens a fresh `runInTenant`. Production F4
 * callsite uses the InTx variant directly to keep the apply atomic
 * with the F4 invoice flip.
 */
export async function applyPendingTierUpgrade(
  deps: RenewalsDeps,
  rawInput: ApplyPendingTierUpgradeInput,
): Promise<
  Result<ApplyPendingTierUpgradeOutput, ApplyPendingTierUpgradeError>
> {
  const inputResult = parseInput(applyPendingTierUpgradeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  // Phase 7 review-fix C-TYPE-2: parse the brand types at the trust
  // boundary instead of bare `as` cast. Mirrors the parseSuggestionId
  // discipline in `accept-tier-upgrade.ts`. The Zod `.uuid()` check
  // is necessary but not sufficient — brand parsers run the canonical
  // validator (which may add format constraints beyond UUID shape).
  const cycleParse = parseCycleId(input.cycleId);
  if (!cycleParse.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const invoiceParse = parseInvoiceId(input.invoiceId);
  if (!invoiceParse.ok) {
    return err({ kind: 'invalid_input', message: 'invalid invoice id' });
  }

  try {
    const applied = await runInTenant(deps.tenant, async (tx) => {
      return await applyPendingTierUpgradeInTx(deps, tx, {
        tenantId: input.tenantId,
        cycleId: cycleParse.value,
        invoiceId: invoiceParse.value,
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
      });
    });
    return ok({ suggestionsApplied: applied });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}

