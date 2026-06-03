/**
 * F8 Phase 6 Wave B · T155 — `snoozeAtRiskMember` use-case.
 *
 * Admin "Snooze" CTA from the at-risk widget per FR-032. Sets
 * `members.risk_snoozed_until = NOW() + duration_days * INTERVAL '1
 * day'` so the at-risk widget's partial index (`members_at_risk_idx
 * WHERE risk_score >= 50 AND risk_snoozed_until IS NULL`) hides the
 * member for the configured duration. Cron continues to recompute
 * the score (snooze auto-expires when the timestamp falls behind
 * NOW()).
 *
 * RBAC (FR-052a): admin role only. Manager attempts MUST be rejected
 * by the route handler before this use-case is invoked; the use-case
 * validates the role anyway as defence-in-depth (zod literal).
 *
 * Audit: emits `at_risk_snoozed` (typed payload added Phase 6 Wave A2).
 * Atomic with the UPDATE per Constitution Principle VIII.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
// Type-only import keeps Application layer free of cross-module runtime
// coupling (Constitution Principle III). The brand is a compile-time
// no-op cast — `input.memberId` is a bare `string` per the use-case
// input shape, so the inline `as MemberId` is semantically identical to
// invoking `asMemberId(...)` and avoids importing a runtime value.
import type { MemberId } from '@/modules/members';

export const snoozeAtRiskMemberInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /** FR-032 enumerates 7 / 30 / 90 only — admin UI surfaces these as a radio. */
  durationDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type SnoozeAtRiskMemberInput = z.infer<
  typeof snoozeAtRiskMemberInputSchema
>;

export interface SnoozeAtRiskMemberOutput {
  /** ISO 8601 UTC — `now() + durationDays * 24h`. */
  readonly snoozedUntil: string;
}

export type SnoozeAtRiskMemberError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' };

export async function snoozeAtRiskMember(
  deps: RenewalsDeps,
  rawInput: SnoozeAtRiskMemberInput,
): Promise<Result<SnoozeAtRiskMemberOutput, SnoozeAtRiskMemberError>> {
  const inputResult = parseInput(snoozeAtRiskMemberInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const snoozedUntil = new Date(
    Date.now() + input.durationDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const txResult = await runInTenant(deps.tenant, async (tx) => {
    const result = await deps.memberRenewalFlagsRepo.setRiskSnoozedUntil(
      tx,
      input.tenantId,
      input.memberId,
      snoozedUntil,
    );
    if (result.affectedRows === 0) {
      return err({ kind: 'member_not_found' as const });
    }
    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_snoozed' as const,
          payload: {
            member_id: input.memberId as MemberId,
            snooze_duration_days: input.durationDays,
            snoozed_until: snoozedUntil,
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
      // Constitution Principle VIII reverse-direction atomicity — an
      // audit emit failure inside the tx MUST propagate so the outer
      // runInTenant rolls the UPDATE back.
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[snooze-at-risk-member] audit emit failed inside tx — rolling back',
      );
      throw e;
    }
    return ok({ snoozedUntil });
  });
  // W0-09: § 23.1.2 snooze counter — emitted genuinely AFTER the tx has committed
  // (runInTenant has returned here) and ONLY on a durable success. A member_not_found
  // (Result err) or a rolled-back audit-emit failure (throw → the await above rejects)
  // must NOT increment it. The earlier in-callback emit over-counted on any
  // post-emit commit failure and its "after commit" comment was inaccurate.
  if (txResult.ok) {
    renewalsMetrics.atRiskSnooze(input.tenantId, input.actorRole);
  }
  return txResult;
}
