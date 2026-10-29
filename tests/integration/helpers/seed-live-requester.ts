/**
 * Spec 139 — a REAL, live requesting member for an E-Blast fixture.
 *
 * The send-standing gate reads `members.erased_at` first, and a member id with
 * no `members` row in the tenant is refused like an erasure (P4: erasure never
 * deletes a member row, so "not found" means the member is gone). Fixtures
 * that seeded `requested_by_member_id` as a bare random UUID therefore stop
 * sending — their docblocks said "neither halted nor with a renewal cycle",
 * but there was no member at all. This seeds one: not erased, not halted, no
 * renewal cycle (F8 access `full`), on its own plan.
 *
 * The plan's `created_by` references `users`, so the caller passes a real test
 * user's id. Rows go away with the tenant's `cleanup()` (members + plans);
 * a caller seeding into a tenant it does not clean up removes them itself.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { DEFAULT_TEST_BENEFIT_MATRIX } from './test-benefit-matrix';
import { seedF8MembershipPlan } from './seed-f8-plan';
import { nextSeedMemberNumber } from './seed-member-number';

export async function seedLiveRequester(
  tenant: TenantContext,
  createdByUserId: string,
  memberId: string = randomUUID(),
): Promise<{ readonly memberId: string; readonly planId: string }> {
  const planId = `p139-live-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.slug,
      planId,
      planName: { en: 'Live requester plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: createdByUserId,
    });
    await tx.insert(members).values({
      tenantId: tenant.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Live Requester Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });
  return { memberId, planId };
}
