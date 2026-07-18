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

  /**
   * 107-auto-invoice Task 15 — batched sibling of `getMembershipAccess`,
   * resolving MANY members in ONE query.
   *
   * Added for `bulkEnrolAutoInvoice`, which must classify up to 100
   * members per request: the serial form would open 100 separate
   * `runInTenant` transactions (~100 RTT to Neon Singapore) for what the
   * renewals repo can already answer in a single `DISTINCT ON` — see
   * `findLatestCyclesForMembers`, which exists precisely to kill this
   * N+1 for the member-directory badge.
   *
   * Returns a Map keyed by member id. A member with NO renewal cycle is
   * still PRESENT in the map, resolved to the same value
   * `deriveMembershipAccess(null, now)` gives (`full` /
   * `in_good_standing`) — callers must not have to distinguish "absent
   * because no cycle" from "absent because unknown id".
   *
   * Same fail-CLOSED contract as the singular method: any infra failure
   * returns `err({ kind: 'membership_access.lookup_error' })` for the
   * WHOLE batch rather than a partial map, so a caller can never
   * mistake an unresolved member for a permitted one.
   */
  getMembershipAccessMany(
    tenant: TenantContext,
    memberIds: readonly string[],
  ): Promise<
    Result<
      ReadonlyMap<string, MembershipAccessSummary>,
      MembershipAccessLookupError
    >
  >;
}
