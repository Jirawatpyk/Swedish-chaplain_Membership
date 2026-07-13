/**
 * 059-membership-suspension Task 6 — `MembershipAccessPort` (F3 Application
 * port).
 *
 * Cross-module read against F8 (`@/modules/renewals` public barrel —
 * `deriveMembershipAccess` + `MembershipAccessReason`). Lets F3's
 * `inviteColleague` use case ask "is this member's benefit access
 * full / suspended / terminated?" before minting a new F1 auth account,
 * without reaching into F8's Domain or Infrastructure directly.
 *
 * F3 defines its OWN copy of this port (identical shape to F7's
 * `MembershipAccessPort` at
 * `src/modules/broadcasts/application/ports/membership-access-port.ts`)
 * rather than importing F7's — Constitution Principle III requires
 * every cross-module read to go through the CONSUMING module's own port
 * (consumer-owns-port convention), and F3 must not depend on F7. See
 * `src/modules/members/infrastructure/membership-access-bridge.ts` for
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
   * never throws — on any infra failure, so callers can fail CLOSED
   * (treat lookup failure as non-full access) rather than silently
   * granting access on an unexpected error.
   */
  getMembershipAccess(
    tenant: TenantContext,
    memberId: string,
  ): Promise<Result<MembershipAccessSummary, MembershipAccessLookupError>>;
}
