/**
 * F8 Phase 7 T181 — `dismissTierUpgrade` use-case.
 *
 * Admin clicks "Dismiss" on a tier-upgrade suggestion. Per FR-039 +
 * AS3:
 *   - Suggestion `open` → `dismissed`
 *   - `suppressed_until` set to `today + 90d` so the eval cron skips
 *     this member's upgrade re-suggestion for 90 days.
 *   - Optional reason ≤500 chars (Domain CHECK constraint enforces).
 *
 * Audit: emits `tier_upgrade_dismissed` (atomic with state per
 * Principle VIII).
 *
 * RBAC (FR-052a): admin role only. Manager attempts MUST be
 * rejected by the route handler before this use-case is invoked.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import { loadOpenSuggestion } from './_lib/load-open-suggestion';
import { type SuggestionId } from '../../domain/tier-upgrade-suggestion';
import type { MemberId } from '@/modules/members';
// 065 Fix 1 — CAS-loser error from the repo's transitionStatus
// (same W-011-class TOCTOU as accept: two concurrent Dismiss clicks,
// or Dismiss racing Accept).
import { TierUpgradeStatusConflictError } from '../ports/tier-upgrade-suggestion-repo';

export const dismissTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  suggestionId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type DismissTierUpgradeInput = z.infer<
  typeof dismissTierUpgradeInputSchema
>;

export interface DismissTierUpgradeOutput {
  readonly suggestionId: SuggestionId;
  readonly suppressedUntil: string;
}

export type DismissTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'suggestion_not_found' }
  | { readonly kind: 'suggestion_not_open' }
  | { readonly kind: 'server_error'; readonly message: string };

const SUPPRESSION_DAYS = 90;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function dismissTierUpgrade(
  deps: RenewalsDeps,
  rawInput: DismissTierUpgradeInput,
): Promise<Result<DismissTierUpgradeOutput, DismissTierUpgradeError>> {
  const inputResult = parseInput(dismissTierUpgradeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  // Phase 7 review-fix S-Simplify-1: shared loader for the parse+find+
  // status-check preamble. Same shape used in accept + escalate paths.
  const loaded = await loadOpenSuggestion(
    deps.tierUpgradeRepo,
    input.tenantId,
    input.suggestionId,
  );
  if (!loaded.ok) return err(loaded.error);
  const { suggestionId, suggestion: existing } = loaded.value;

  const now = deps.clock.now();
  const closedAt = now.toISOString();
  const suppressedUntil = new Date(
    now.getTime() + SUPPRESSION_DAYS * ONE_DAY_MS,
  ).toISOString();

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const transitionArgs: Parameters<
        typeof deps.tierUpgradeRepo.transitionStatus
      >[3] = {
        to: 'dismissed' as const,
        // 065 Fix 1 — CAS guard: `loadOpenSuggestion`'s `open` check
        // is a stale read by UPDATE time; the repo re-checks
        // atomically and throws `TierUpgradeStatusConflictError` when
        // a concurrent Accept/Dismiss already transitioned the row —
        // mapped to `suggestion_not_open` in the catch below.
        expectedFrom: 'open' as const,
        suppressedUntil,
        closedAt,
        ...(input.reason !== undefined && input.reason.length > 0
          ? { dismissedReason: input.reason }
          : { dismissedReason: '' }),
      };
      await deps.tierUpgradeRepo.transitionStatus(
        tx,
        input.tenantId,
        suggestionId,
        transitionArgs,
      );

      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'tier_upgrade_dismissed',
          payload: {
            suggestion_id: suggestionId,
            member_id: existing.memberId as MemberId,
            reason:
              input.reason !== undefined && input.reason.length > 0
                ? input.reason
                : null,
            suppressed_until: suppressedUntil,
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

      return ok({ suggestionId, suppressedUntil });
    });
  } catch (e) {
    // 065 Fix 1 — CAS loser maps to the same typed error the pre-tx
    // `open` check yields (the throw already rolled the tx back, so
    // no partial audit row committed).
    if (e instanceof TierUpgradeStatusConflictError) {
      return err({ kind: 'suggestion_not_open' });
    }
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}
