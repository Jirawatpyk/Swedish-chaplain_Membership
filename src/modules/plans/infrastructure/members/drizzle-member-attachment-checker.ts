/**
 * F2 `MemberAttachmentChecker` — Drizzle-backed implementation.
 *
 * Replaces the prior `stub-member-attachment-checker` (always
 * returned 0) now that F3 has shipped a real `members` table.
 *
 * Composition (Constitution Principle III — barrel-only cross-module):
 *   F2 plans-deps → this adapter → F3 public barrel
 *   `countActiveMembersOnPlan(ctx, planId, planYear)`
 *
 * No deep import into F3 internals; the F3 free function lives at
 * `src/modules/members/infrastructure/db/count-active-members-on-plan.ts`
 * and is re-exported from `@/modules/members`.
 */
import { countActiveMembersOnPlan } from '@/modules/members';
import type { MemberAttachmentChecker } from '@/modules/plans/application/ports';

export const drizzleMemberAttachmentChecker: MemberAttachmentChecker = {
  async countActivePlanMembers(tenant, planId, year) {
    // F2's branded types (PlanSlug + PlanYear) are structurally string
    // + number — pass through to F3 as plain primitives. F3 brands its
    // own PlanId internally if needed.
    return countActiveMembersOnPlan(tenant, planId as string, year as number);
  },
};
