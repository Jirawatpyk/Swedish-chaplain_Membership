/**
 * 108 FR-004 — `BillingRecipientPort` over the F3 members module.
 *
 * Goes through the members BARREL (`getMemberPrimaryContact`), not raw SQL:
 * that use case already answers exactly this question (`is_primary = true AND
 * removed_at IS NULL`, tenant-scoped via `runInTenant`), and Principle III
 * forbids reaching into a sibling context's internals.
 *
 * ## Two things this adapter deliberately does NOT do
 *
 * 1. **It does not swallow a read failure.** An earlier version returned `null`
 *    on a repo error, which the caller could not tell apart from "no primary
 *    contact exists" — so a database hiccup told the member their membership
 *    had no contact and sent them to an admin who would find nothing wrong.
 *    A failure is now `err({ kind: 'read_failed' })` and surfaces as a 500.
 * 2. **It does not open its own transaction inside the caller's.** It is called
 *    BEFORE `paymentsRepo.withTx`, so the `runInTenant` inside
 *    `getMemberPrimaryContact` checks out a connection while the pool holds
 *    none of ours. Calling it from inside the payment transaction would have
 *    asked the pool for a second connection while the first was held and the
 *    `payments:` advisory lock was open — the connection-starvation shape this
 *    repo already documents (`db.ts` pool comment, 2026-04-25).
 *
 * Log hygiene: `errKind` alone returns `'unknown'` for a plain `RepoError`
 * object, so the diagnostic goes through `rootCause` first to reach the real
 * thrown Error and report its CLASS — never its message, which can embed
 * user-submitted values.
 */
import { getMemberPrimaryContact, drizzleMemberRepo, asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type {
  BillingRecipientPort,
  BillingRecipientReadFailed,
} from '../application/ports/billing-recipient-port';

export const billingRecipientAdapter: BillingRecipientPort = {
  async getPrimaryContactEmail(
    tenantId: string,
    memberId: string,
  ): Promise<Result<string | null, BillingRecipientReadFailed>> {
    const result = await getMemberPrimaryContact(
      { tenant: asTenantContext(tenantId), memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    if (!result.ok) {
      logger.warn(
        { tenantId, memberId, err: errKind(rootCause(result.error)) },
        'billingRecipientAdapter: primary-contact read failed — reporting transient, not "no contact"',
      );
      return err({ kind: 'read_failed' });
    }
    return ok(result.value);
  },
};
