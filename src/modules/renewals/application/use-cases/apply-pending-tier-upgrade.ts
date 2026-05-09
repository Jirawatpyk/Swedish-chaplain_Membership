/**
 * F8 Phase 7 T183 — `applyPendingTierUpgrade` use-case.
 *
 * Called from the F4 renewal-invoice-creation hook. When F4 issues a
 * fresh renewal invoice, it consults `getEffectivePlanForRenewal`
 * (F2 barrel) which returns the upgraded plan id when an
 * `accepted_pending_apply` `ScheduledPlanChange` row exists for the
 * cycle. F4 invoices at the resolved plan's price; this use-case
 * then transitions the corresponding tier-upgrade suggestion(s) to
 * `applied` + emits the audit trail.
 *
 * Per FR-039 step 4: F4's `createMembershipInvoice` is the caller —
 * the call site is wired in F8 → F4 bridge (`f4-invoice-bridge.ts`)
 * + the F2 `transitionStatus(..., 'applied')` is the F2 side.
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
import type { CycleId } from '../../domain/renewal-cycle';
import type { MemberId, PlanId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';

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
  },
): Promise<ReadonlyArray<SuggestionId>> {
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

    await deps.tierUpgradeRepo.transitionStatus(
      tx,
      args.tenantId,
      suggestion.suggestionId,
      {
        to: 'applied' as const,
        appliedAt,
        appliedAtInvoiceId: args.invoiceId,
        closedAt: appliedAt,
      },
    );

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
        actorUserId: null,
        // F8 RenewalActorRole: 'webhook' is the canonical label when
        // the F4 onPaidCallback fires from the Stripe-webhook path
        // (markPaidFromProcessor); mark-paid-offline path also runs
        // through the same callback array and is admin-driven, but
        // the actor for the *cascade* (cycle complete + tier-upgrade
        // apply) is the F4 webhook contract, not the original admin.
        // Mirrors `markCycleCompleteFromInvoicePaid` actorRole choice.
        actorRole: 'webhook',
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

  try {
    const applied = await runInTenant(deps.tenant, async (tx) => {
      return await applyPendingTierUpgradeInTx(deps, tx, {
        tenantId: input.tenantId,
        cycleId: input.cycleId as CycleId,
        invoiceId: input.invoiceId as InvoiceId,
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

