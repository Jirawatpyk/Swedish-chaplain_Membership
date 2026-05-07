/**
 * F8 Phase 5 Wave A · T135 (part 1 / 2) — `blockAutoReactivation`.
 *
 * Admin override per FR-005b — blocks the default auto-reactivate path
 * for a specific member. After this flag is set, when the member pays
 * for a lapsed renewal cycle the system enters
 * `pending_admin_reactivation` instead of auto-reactivating; the admin
 * must explicitly approve (T136) or reject-with-refund (T137) within
 * 30 days (T138 auto-times-out).
 *
 * RBAC: admin role only. Manager-role attempts MUST be rejected by the
 * route handler before this use-case is invoked (F8 RBAC matrix
 * mirrors F4 — admin writes, manager reads). The use-case validates
 * the role anyway as defence-in-depth.
 *
 * Audit: emits `member_auto_reactivation_blocked` (in F8 catalogue
 * since K6; pgEnum value added in migration 0109). Atomic with the
 * UPDATE per Constitution Principle VIII.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const blockAutoReactivationInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /**
   * Optional free-text reason logged on the audit row + persisted on
   * the members table column for forensic trail. Truncated to 1000
   * chars by the DB (the column is unbounded text but we cap input
   * here so a buggy admin UI can't insert megabyte-scale notes).
   */
  reason: z.string().trim().min(1).max(1000).optional(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type BlockAutoReactivationInput = z.infer<
  typeof blockAutoReactivationInputSchema
>;

export interface BlockAutoReactivationOutput {
  /** TRUE when the flag was already TRUE pre-call (idempotency). */
  readonly alreadyBlocked: boolean;
}

export type BlockAutoReactivationError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' };

export async function blockAutoReactivation(
  deps: RenewalsDeps,
  rawInput: BlockAutoReactivationInput,
): Promise<
  Result<BlockAutoReactivationOutput, BlockAutoReactivationError>
> {
  const parsed = blockAutoReactivationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;

  return runInTenant(deps.tenant, async (tx) => {
    const flagInput: {
      memberId: string;
      actorUserId: string;
      reason?: string;
    } = {
      memberId: input.memberId,
      actorUserId: input.actorUserId,
    };
    if (input.reason !== undefined) {
      flagInput.reason = input.reason;
    }
    const result = await deps.memberRenewalFlagsRepo.setBlockedFromAutoReactivation(
      tx,
      input.tenantId,
      flagInput,
    );
    if (result.affectedRows === 0) {
      return err({ kind: 'member_not_found' });
    }

    // Skip audit emit on idempotent re-block (no state change → no
    // forensic delta worth recording). The original block's audit row
    // already exists.
    if (!result.previousValue) {
      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'member_auto_reactivation_blocked' as const,
            payload: {
              member_id: input.memberId,
              actor_user_id: input.actorUserId,
              reason: input.reason ?? null,
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
        // Constitution Principle VIII reverse-direction atomicity —
        // an audit emit failure inside the tx MUST propagate so the
        // outer runInTenant rolls the UPDATE back. Re-throw rather
        // than swallowing.
        logger.error(
          { err: e instanceof Error ? e.message : String(e) },
          '[block-auto-reactivation] audit emit failed inside tx — rolling back',
        );
        throw e;
      }
    }
    return ok({ alreadyBlocked: result.previousValue });
  });
}
