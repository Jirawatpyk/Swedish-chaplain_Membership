/**
 * F8 Phase 5 Wave A · T135 (part 2 / 2) — `unblockAutoReactivation`.
 *
 * Inverse of `blockAutoReactivation` — admin clears the manual override
 * so future lapsed-cycle payments auto-reactivate per FR-005b default.
 * Resets all four block-related columns
 * (`blocked_from_auto_reactivation` + `_at` + `_set_by_user_id` +
 * `_reason`) to (FALSE, NULL, NULL, NULL) atomically per the migration
 * 0094 CHECK constraint.
 *
 * Audit: emits `member_auto_reactivation_unblocked` only on actual
 * state change (no double-row on re-toggle).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';

export const unblockAutoReactivationInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type UnblockAutoReactivationInput = z.infer<
  typeof unblockAutoReactivationInputSchema
>;

export interface UnblockAutoReactivationOutput {
  /** TRUE when the flag was actually toggled (i.e. previously blocked). */
  readonly wasBlocked: boolean;
}

export type UnblockAutoReactivationError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' };

export async function unblockAutoReactivation(
  deps: RenewalsDeps,
  rawInput: UnblockAutoReactivationInput,
): Promise<
  Result<UnblockAutoReactivationOutput, UnblockAutoReactivationError>
> {
  const inputResult = parseInput(unblockAutoReactivationInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  return runInTenant(deps.tenant, async (tx) => {
    const result =
      await deps.memberRenewalFlagsRepo.clearBlockedFromAutoReactivation(
        tx,
        input.tenantId,
        input.memberId,
      );
    if (result.affectedRows === 0) {
      return err({ kind: 'member_not_found' });
    }

    if (result.previousValue) {
      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'member_auto_reactivation_unblocked' as const,
            payload: {
              member_id: input.memberId,
              actor_user_id: input.actorUserId,
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
      } catch (e) {
        logger.error(
          { err: e instanceof Error ? e.message : String(e) },
          '[unblock-auto-reactivation] audit emit failed inside tx — rolling back',
        );
        throw e;
      }
    }
    return ok({ wasBlocked: result.previousValue });
  });
}
