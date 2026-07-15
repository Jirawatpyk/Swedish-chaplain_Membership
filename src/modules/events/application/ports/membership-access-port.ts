/**
 * 059-membership-suspension Task 17 — `MembershipAccessPort` (F6
 * Application port).
 *
 * Cross-module read against F8 (`@/modules/renewals` public barrel —
 * `deriveMembershipAccess` + `MembershipAccessReason`, TYPES ONLY). Lets
 * the CSV-import use-case (`importCsv`) ask "is this matched member's
 * benefit access full / suspended / terminated?" AFTER a fresh
 * attendance row has already been recorded, so the import result can
 * flag the row + a forensic audit event can fire — WITHOUT gating
 * anything (F6 event benefits are fulfilled externally; the event
 * already happened by the time an admin uploads the CSV, so there is
 * nothing to block).
 *
 * F6 defines its OWN copy of this port (identical shape to F3's
 * `src/modules/members/application/ports/membership-access-port.ts` and
 * F7's `src/modules/broadcasts/application/ports/membership-access-port.ts`)
 * rather than importing either sibling's — Constitution Principle III
 * requires every cross-module read to go through the CONSUMING module's
 * own port (consumer-owns-port convention), and F6 must not depend on
 * F3/F7. See `src/modules/events/infrastructure/membership-access-bridge.ts`
 * for the concrete adapter.
 *
 * Pure interface — no framework/ORM imports (Constitution Principle III).
 */
import type { TenantId, MemberId } from '@/modules/members';
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
   * never throws — on any infra failure. Unlike the F3/F7 sibling ports
   * (which gate a WRITE and must fail CLOSED), this port backs a purely
   * observational check: the caller (`import-csv.ts`) treats a lookup
   * failure as "no warning" (fail OPEN on the warning itself) rather
   * than risk a false-positive flag — the attendance row is recorded
   * either way.
   */
  getMembershipAccess(
    tenantId: TenantId,
    memberId: MemberId,
  ): Promise<Result<MembershipAccessSummary, MembershipAccessLookupError>>;
}
