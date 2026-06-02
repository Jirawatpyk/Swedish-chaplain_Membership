/**
 * Stage-3 importer — commitMembers integration tests (spec § 5/§8, live Neon).
 * Validates the --commit write path: RLS-scoped insert + audit, idempotent
 * re-run, cross-tenant isolation, and all-or-nothing rollback on a mid-batch
 * failure. Pure logic (parse/map/validate/report) is covered by the unit suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { ValidatedMember } from '@/../scripts/import-members/validate';

const { commitMembers } = await import('@/../scripts/import-members');

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1, website_page_type: 'member_news_update', homepage_logo_category: 'regular',
  directory_listing_size: 'half_page', event_discount_scope: 'all_employees', events_cobranded_access: false,
  cultural_tickets_per_year: 0, m2m_benefits_access: true, business_referrals: true,
  tailor_made_services: false, partnership: null,
};

async function seedPremiumPlan(slug: string, userId: string): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: slug, planId: 'premium', planYear: 2026,
      planName: { en: 'Premium Corporate' }, description: { en: 'test' }, sortOrder: 1,
      planCategory: 'corporate', memberTypeScope: 'company', annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: null, minTurnoverMinorUnits: null, maxTurnoverMinorUnits: null,
      maxDurationYears: null, maxMemberAge: null, benefitMatrix: MATRIX, isActive: true,
      createdBy: userId, updatedBy: userId,
    });
  });
}

let vmSeq = 0;
function vm(over: { planId?: string; emails?: string[] }): ValidatedMember {
  vmSeq += 1;
  const emails = over.emails ?? [`c${vmSeq}-${randomUUID().slice(0, 8)}@imp.test`];
  return {
    companyName: `Imp Co ${vmSeq}`,
    country: 'SE' as ValidatedMember['country'],
    taxId: ('SE' + String(vmSeq).padStart(6, '0')) as ValidatedMember['taxId'],
    planId: over.planId ?? 'premium',
    memberTypeScope: 'company',
    turnoverThb: null,
    registrationDate: new Date('2026-01-15T00:00:00Z'),
    preferredLocale: null,
    city: null, province: null, postalCode: null,
    contacts: emails.map((email, i) => ({
      firstName: 'First', lastName: 'Last',
      email: email as ValidatedMember['contacts'][number]['email'],
      phone: null, roleTitle: null, preferredLanguage: 'en' as const,
      isPrimary: i === 0, rowIndex: 100 + i,
    })),
    rowIndices: [100],
  };
}

const countMembers = (slug: string): Promise<number> =>
  runInTenant({ slug } as never, async (tx) =>
    tx.select({ id: members.memberId }).from(members).where(eq(members.tenantId, slug)),
  ).then((r) => r.length);

describe('commitMembers — integration (spec § 5)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let tenantC: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    tenantC = await createTestTenant('test');
    await seedPremiumPlan(tenantA.ctx.slug, user.userId);
    await seedPremiumPlan(tenantB.ctx.slug, user.userId);
    await seedPremiumPlan(tenantC.ctx.slug, user.userId);
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await tenantC.cleanup().catch(() => {});
  });

  it('inserts member + contacts under the tenant, emits audit (RLS-scoped)', async () => {
    const member = vm({ emails: [`a-${randomUUID().slice(0, 8)}@imp.test`, `b-${randomUUID().slice(0, 8)}@imp.test`] });
    const out = await commitMembers(tenantA.ctx, user.userId, [member], 2026);
    expect(out).toMatchObject({ membersCreated: 1, contactsCreated: 2, skippedExistingMembers: 0 });

    const rows = await runInTenant(tenantA.ctx, async (tx) => ({
      members: await tx.select().from(members).where(eq(members.tenantId, tenantA.ctx.slug)),
      contacts: await tx.select().from(contacts).where(eq(contacts.tenantId, tenantA.ctx.slug)),
      audit: await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), eq(auditLog.eventType, 'member_created'))),
    }));
    expect(rows.members).toHaveLength(1);
    expect(rows.members[0]!.planId).toBe('premium');
    expect(rows.contacts).toHaveLength(2);
    expect(rows.contacts.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(rows.audit.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: re-running the SAME member skips it (active email exists)', async () => {
    const member = vm({ emails: [`dup-${randomUUID().slice(0, 8)}@imp.test`] });
    const first = await commitMembers(tenantA.ctx, user.userId, [member], 2026);
    expect(first.membersCreated).toBe(1);
    const second = await commitMembers(tenantA.ctx, user.userId, [member], 2026);
    expect(second).toMatchObject({ membersCreated: 0, skippedExistingMembers: 1 });
  });

  it('RLS isolation: a member committed under tenantA is invisible to tenantB', async () => {
    const before = await countMembers(tenantB.ctx.slug);
    await commitMembers(tenantA.ctx, user.userId, [vm({ emails: [`iso-${randomUUID().slice(0, 8)}@imp.test`] })], 2026);
    expect(await countMembers(tenantB.ctx.slug)).toBe(before); // tenantB unchanged
  });

  it('all-or-nothing: a mid-batch FK failure rolls back the whole import', async () => {
    const good = vm({ emails: [`rb-good-${randomUUID().slice(0, 8)}@imp.test`] });
    const ghost = vm({ planId: 'ghost-plan-not-seeded', emails: [`rb-ghost-${randomUUID().slice(0, 8)}@imp.test`] });
    const before = await countMembers(tenantC.ctx.slug);

    await expect(commitMembers(tenantC.ctx, user.userId, [good, ghost], 2026)).rejects.toThrow();

    // The good member (committed before the ghost FK violation) MUST be rolled back.
    expect(await countMembers(tenantC.ctx.slug)).toBe(before);
  });
});
