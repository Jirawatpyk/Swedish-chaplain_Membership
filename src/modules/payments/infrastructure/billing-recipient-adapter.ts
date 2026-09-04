/**
 * 108 FR-004 — `BillingRecipientPort` over the F3 members module.
 *
 * Goes through the members BARREL (`getMemberPrimaryContact`), not raw SQL:
 * that use case already answers exactly this question (`is_primary = true AND
 * removed_at IS NULL`, tenant-scoped via `runInTenant`), and Principle III
 * forbids reaching into a sibling context's internals.
 *
 * A repo error is reported as `null` — "no address we can trust". The caller
 * (PromptPay) then refuses the payment rather than sending Stripe an address
 * it guessed, and the failure is visible as a permanent
 * `primary_contact_missing` instead of a silent wrong recipient.
 */
import { getMemberPrimaryContact, drizzleMemberRepo, asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { BillingRecipientPort } from '../application/ports/billing-recipient-port';

export const billingRecipientAdapter: BillingRecipientPort = {
  async getPrimaryContactEmail(tenantId: string, memberId: string): Promise<string | null> {
    const result = await getMemberPrimaryContact(
      { tenant: asTenantContext(tenantId), memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    if (!result.ok) {
      logger.warn(
        { tenantId, memberId, err: errKind(result.error) },
        'billingRecipientAdapter: primary-contact read failed — treating as no recipient',
      );
      return null;
    }
    return result.value;
  },
};
