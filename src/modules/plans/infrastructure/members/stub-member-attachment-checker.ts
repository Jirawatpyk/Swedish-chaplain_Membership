/**
 * F2 stub for `MemberAttachmentChecker` — always returns 0.
 *
 * F2 does not introduce the `members` table (that ships in F3), so
 * the plan-deletion "has active members?" check is implemented as a
 * constant-zero stub. The `soft-delete-plan` use case still calls
 * the port, so the happy path through `planRepo.softDelete` is
 * exercised by F2's integration tests.
 *
 * **F3 will replace this module** with a real Drizzle-backed
 * implementation of `MemberAttachmentChecker` that counts rows in
 * `members` where `plan_id = $1 AND plan_year = $2 AND status = 'active'`
 * inside `runInTenant(tenant, ...)`. The Application-layer contract
 * (the `MemberAttachmentChecker` interface) does NOT change — only the
 * Infrastructure implementation swaps.
 *
 * Critique P7 (2026-04-11) — stubbing the port keeps the
 * `409 plan_has_active_members` path reachable via mocking in unit
 * tests, so F2's contract tests cover the error shape today without
 * depending on a table that doesn't exist yet.
 */

import type {
  MemberAttachmentChecker,
} from '@/modules/plans/application/ports';

export const stubMemberAttachmentChecker: MemberAttachmentChecker = {
  async countActivePlanMembers() {
    // F2 stub — F3 replaces with a real query. No members table exists yet.
    return 0;
  },
};
