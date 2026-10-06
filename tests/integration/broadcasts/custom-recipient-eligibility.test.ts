/**
 * Custom-list member eligibility on live Neon (E-Blasts reach member
 * companies only — decision 2026-10-06).
 *
 * FR-015d resolves a pasted address against the tenant graph. The member
 * legs (primary contact, any contact) must accept only contacts of members
 * the member segments could reach: ACTIVE, not erased, not halted
 * (`findMembersBySegmentForBroadcast`). This drives the REAL F7→F3 bridge
 * and the real F6 attendee bridge — no fixture decides who resolves.
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { validateCustomRecipients } from '@/modules/broadcasts/application/use-cases/validate-custom-recipients';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { eventAttendeesBridge } from '@/modules/broadcasts';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

type MemberState = 'active' | 'inactive' | 'erased' | 'halted';

describe('custom-list validation — member eligibility (live Neon)', () => {
  let admin: TestUser;
  let tenant: TestTenant;
  const planId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const addr = (state: MemberState, role: 'primary' | 'secondary') =>
    `${state}-${role}-${tag}@eligibility.example`;

  async function seedMember(state: MemberState): Promise<void> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Eligibility ${state} ${tag}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: state === 'inactive' ? 'inactive' : 'active',
        erasedAt: state === 'erased' ? new Date() : null,
        broadcastsHaltedUntilAdminReview: state === 'halted',
      });
      await tx.insert(contacts).values(
        (['primary', 'secondary'] as const).map((role) => ({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Sim',
          lastName: `${state}-${role}`,
          email: addr(state, role),
          preferredLanguage: 'en' as const,
          isPrimary: role === 'primary',
          removedAt: null,
        })),
      );
    });
  }

  const deps = () => ({
    tenant: tenant.ctx,
    emailValidator: rfc5321EmailValidator,
    membersBridge,
    eventAttendees: eventAttendeesBridge,
  });

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    for (const state of ['active', 'inactive', 'erased', 'halted'] as const) {
      await seedMember(state);
    }
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it('accepts the primary and a secondary contact of an active member', async () => {
    const r = await validateCustomRecipients(deps(), {
      raw: [addr('active', 'primary'), addr('active', 'secondary')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.normalised).toHaveLength(2);
  });

  it('rejects every contact of an inactive, erased or halted member', async () => {
    const ineligible = (['inactive', 'erased', 'halted'] as const).flatMap((state) => [
      addr(state, 'primary'),
      addr(state, 'secondary'),
    ]);
    const r = await validateCustomRecipients(deps(), {
      raw: [addr('active', 'primary'), ...ineligible],
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'broadcast_custom_recipient_unknown') {
      expect([...r.error.unresolved].sort()).toEqual([...ineligible].sort());
    } else {
      expect.unreachable('expected broadcast_custom_recipient_unknown');
    }
  });
});
