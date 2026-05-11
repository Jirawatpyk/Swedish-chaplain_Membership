/**
 * F8 Phase 5 Wave A · T124 (part 1 / 2) — `optOutRenewalReminders`.
 *
 * Member self-service portal toggle to silence renewal-reminder emails
 * per FR-016. Sets `members.renewal_reminders_opted_out=TRUE` +
 * `_at=NOW()` atomically. The dispatcher cron consults this flag at
 * candidate-fetch time and skips the EMAIL channel; the cycle still
 * appears in the admin pipeline + task channel events still fire so
 * admins retain forensic visibility.
 *
 * Concurrency: simple UPDATE inside a `runInTenant` tx; no advisory
 * lock needed (idempotent — re-toggle preserves original timestamp).
 *
 * Audit: no F8 audit event in the catalogue is reserved for this
 * toggle. Member-initiated lifecycle changes flow through F3's member
 * timeline events (e.g., `member_self_update`) — tracked at the F1/F3
 * layer rather than F8. If forensic-grade tracking is needed later,
 * extend `F8_AUDIT_EVENT_TYPES` + add an emit here.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';

export const optOutRenewalRemindersInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('member'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type OptOutRenewalRemindersInput = z.infer<
  typeof optOutRenewalRemindersInputSchema
>;

export interface OptOutRenewalRemindersOutput {
  /** Whether the flag was already TRUE before this call (idempotency). */
  readonly alreadyOptedOut: boolean;
}

export type OptOutRenewalRemindersError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' };

export async function optOutRenewalReminders(
  deps: RenewalsDeps,
  rawInput: OptOutRenewalRemindersInput,
): Promise<
  Result<OptOutRenewalRemindersOutput, OptOutRenewalRemindersError>
> {
  const inputResult = parseInput(optOutRenewalRemindersInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  return runInTenant(deps.tenant, async (tx) => {
    const result = await deps.memberRenewalFlagsRepo.setRenewalRemindersOptedOut(
      tx,
      input.tenantId,
      input.memberId,
    );
    if (result.affectedRows === 0) {
      return err({ kind: 'member_not_found' });
    }
    return ok({ alreadyOptedOut: result.previousValue });
  });
}
