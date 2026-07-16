/**
 * 066-renewal-swecham-round2 §4.4(1)/§7 — `MembershipAccessPort` (F4
 * Invoicing Application port).
 *
 * Cross-module read against F8 (`@/modules/renewals` public barrel —
 * `deriveMembershipAccess` + `MembershipAccessReason`). Lets F4's
 * `recordPayment` use case ask "is this member's membership terminated?"
 * before minting a §86/4 tax receipt on an admin-manual payment against a
 * MEMBERSHIP invoice — so a payment can be refused BEFORE the charge +
 * receipt reach a non-member (design §4.2 "prevent, not mitigate").
 *
 * This is the 4th copy of the consumer-owns-port convention (F3 members /
 * F6 events / F7 broadcasts each ship an identical shape). Constitution
 * Principle III requires every cross-module read to go through the
 * CONSUMING module's own port; F4 must not depend on F3/F6/F7, so it
 * defines its own. See
 * `src/modules/invoicing/infrastructure/membership-access-bridge.ts` for
 * the concrete adapter.
 *
 * Pure interface — no framework/ORM imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { Result } from '@/lib/result';
import type { MembershipAccessReason } from '@/modules/renewals';

export interface MembershipAccessSummary {
  readonly access: 'full' | 'suspended' | 'terminated';
  readonly reason: MembershipAccessReason;
}

export interface MembershipAccessLookupError {
  readonly kind: 'membership_access.lookup_error';
}

export interface MembershipAccessPort {
  /**
   * Resolve the member's current benefit-access state (F8's
   * `deriveMembershipAccess` predicate applied to their latest renewal
   * cycle). Returns `err({ kind: 'membership_access.lookup_error' })` —
   * never throws — on any infra failure.
   *
   * NOTE the F4 consumer (`recordPayment`) fails **OPEN** on this error
   * (F6 events precedent, NOT the F3/F7 fail-closed one): availability of
   * the money path beats the gate; the §4.4(2) heal-site audit net is the
   * backstop that records any payment that slips through. The fail-open
   * decision lives in the consumer — this port only reports `err`.
   */
  getMembershipAccess(
    tenant: TenantContext,
    memberId: string,
  ): Promise<Result<MembershipAccessSummary, MembershipAccessLookupError>>;
}
