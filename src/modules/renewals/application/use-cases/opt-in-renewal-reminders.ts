/**
 * F8 Phase 5 Wave A · T124 (part 2 / 2) — `optInRenewalReminders`.
 *
 * Inverse of `optOutRenewalReminders` — member opts back into receiving
 * renewal-reminder emails. Resets `renewal_reminders_opted_out=FALSE` +
 * `_at=NULL`. Idempotent — clearing an already-false flag returns
 * `wasOptedOut=false` (no-op).
 *
 * Audit: same rationale as opt-out — no F8 catalogue event reserved.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';

export const optInRenewalRemindersInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('member'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type OptInRenewalRemindersInput = z.infer<
  typeof optInRenewalRemindersInputSchema
>;

export interface OptInRenewalRemindersOutput {
  /** Whether the flag was TRUE before this call. */
  readonly wasOptedOut: boolean;
}

export type OptInRenewalRemindersError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' };

export async function optInRenewalReminders(
  deps: RenewalsDeps,
  rawInput: OptInRenewalRemindersInput,
): Promise<
  Result<OptInRenewalRemindersOutput, OptInRenewalRemindersError>
> {
  const inputResult = parseInput(optInRenewalRemindersInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  return runInTenant(deps.tenant, async (tx) => {
    const result = await deps.memberRenewalFlagsRepo.clearRenewalRemindersOptedOut(
      tx,
      input.tenantId,
      input.memberId,
    );
    if (result.affectedRows === 0) {
      return err({ kind: 'member_not_found' });
    }
    return ok({ wasOptedOut: result.previousValue });
  });
}
