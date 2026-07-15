/**
 * 059-membership-suspension Task 4 — `MembershipAccessPort` (F7 Application port).
 *
 * Cross-module read against F8 (`@/modules/renewals` public barrel —
 * `deriveMembershipAccess` + `MembershipAccessReason`). Lets F7 broadcast
 * use-cases (and, via the same shape, F3 member use-cases) ask "is this
 * member's benefit access full / suspended / terminated?" without
 * reaching into F8's Domain or Infrastructure directly — mirrors the
 * `PlansBridgePort` pattern (`./plans-bridge-port.ts`).
 *
 * Concrete adapter (Infrastructure) is `membershipAccessBridge`
 * (`../infrastructure/membership-access-bridge.ts`), composed at the F7
 * composition root against F8's `makeDrizzleRenewalCycleRepo` +
 * `deriveMembershipAccess`.
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
