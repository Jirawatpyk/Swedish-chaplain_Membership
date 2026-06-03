/**
 * Stage-3 importer — commitMembers integration tests (spec § 5/§8, live Neon).
 * Validates the --commit write path: RLS-scoped insert + audit, idempotent
 * re-run, cross-tenant isolation, and all-or-nothing rollback on a mid-batch
 * failure. Pure logic (parse/map/validate/report) is covered by the unit suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
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

// Seed one existing member that owns `email` as its ACTIVE primary contact. Returns its id.
async function seedActiveContact(t: TestTenant, email: string): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(t.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: t.ctx.slug, memberId, companyName: `Seed ${randomUUID().slice(0, 6)}`,
      country: 'SE', planId: 'premium', planYear: 2026, registrationDate: '2026-01-01',
      registrationFeePaid: true, status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: t.ctx.slug, contactId: randomUUID(), memberId,
      firstName: 'S', lastName: 'A', email, preferredLanguage: 'en', isPrimary: true,
    });
  });
  return memberId;
}

// Seed `email` as a SOFT-DELETED contact (domain invariant: is_primary=false once removed).
async function seedSoftContact(t: TestTenant, email: string): Promise<void> {
  await seedActiveContact(t, email);
  await runInTenant(t.ctx, async (tx) => {
    await tx.update(contacts).set({ removedAt: new Date(), isPrimary: false }).where(eq(contacts.email, email));
  });
}

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

  it('partial overlap: a member sharing one active email + a new one is SKIPPED + flagged, never auto-attached (R2 fix — items 1/2/4/5/7/8)', async () => {
    const emailA = `partA-${randomUUID().slice(0, 8)}@imp.test`;
    const emailB = `partB-${randomUUID().slice(0, 8)}@imp.test`;
    const first = await commitMembers(tenantA.ctx, user.userId, [vm({ emails: [emailA] })], 2026);
    expect(first.membersCreated).toBe(1);

    // Re-run lists the existing contact A AND a genuinely new B — an ambiguous partial
    // overlap. The importer must NOT auto-attach (avoids wrong-member attach + zero-primary):
    // it skips the member + records the row for the operator.
    const member2 = vm({ emails: [emailA, emailB] });
    const second = await commitMembers(tenantA.ctx, user.userId, [member2], 2026);
    expect(second).toMatchObject({ membersCreated: 0, contactsCreated: 0, skippedPartialOverlapMembers: 1 });
    expect(second.partialOverlapRows).toContain(member2.rowIndices[0]);

    // B was NOT inserted anywhere (no silent wrong-member attach).
    const bRows = await runInTenant(tenantA.ctx, async (tx) =>
      tx.select({ id: contacts.contactId }).from(contacts).where(and(eq(contacts.tenantId, tenantA.ctx.slug), inArray(contacts.email, [emailB]))),
    );
    expect(bRows).toHaveLength(0);
  });

  it('new member whose PRIMARY email is soft-deleted is skipped, never created with no primary (review items 2/8)', async () => {
    const email = `softP-${randomUUID().slice(0, 8)}@imp.test`;
    const seededMemberId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug, memberId: seededMemberId, companyName: `Soft Co ${randomUUID().slice(0, 6)}`,
        country: 'SE', planId: 'premium', planYear: 2026, registrationDate: '2026-01-01',
        registrationFeePaid: true, status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug, contactId: randomUUID(), memberId: seededMemberId,
        firstName: 'S', lastName: 'D', email, preferredLanguage: 'en', isPrimary: true,
      });
      // Soft-delete it (domain invariant: is_primary=false when removed_at set).
      await tx.update(contacts).set({ removedAt: new Date(), isPrimary: false }).where(eq(contacts.email, email));
    });

    const before = await countMembers(tenantA.ctx.slug);
    const out = await commitMembers(tenantA.ctx, user.userId, [vm({ emails: [email] })], 2026);
    expect(out).toMatchObject({ membersCreated: 0, skippedPrimaryCollisionMembers: 1 });
    expect(await countMembers(tenantA.ctx.slug)).toBe(before); // no orphan member created
  });

  it('new member with a soft-deleted SECONDARY: created with its primary, secondary skipped; re-run idempotent (R3 items 1/10)', async () => {
    const pEmail = `r3p-${randomUUID().slice(0, 8)}@imp.test`;
    const sEmail = `r3s-${randomUUID().slice(0, 8)}@imp.test`;
    // Pre-seed sEmail as a soft-deleted contact (on an unrelated member).
    await runInTenant(tenantC.ctx, async (tx) => {
      const oldMember = randomUUID();
      await tx.insert(members).values({
        tenantId: tenantC.ctx.slug, memberId: oldMember, companyName: `Old ${randomUUID().slice(0, 6)}`,
        country: 'SE', planId: 'premium', planYear: 2026, registrationDate: '2026-01-01', registrationFeePaid: true, status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenantC.ctx.slug, contactId: randomUUID(), memberId: oldMember,
        firstName: 'X', lastName: 'Y', email: sEmail, preferredLanguage: 'en', isPrimary: true,
      });
      await tx.update(contacts).set({ removedAt: new Date(), isPrimary: false }).where(eq(contacts.email, sEmail));
    });

    // Import a NEW member: primary P (new) + secondary S (email matches the soft-deleted row).
    const first = await commitMembers(tenantC.ctx, user.userId, [vm({ emails: [pEmail, sEmail] })], 2026);
    expect(first).toMatchObject({ membersCreated: 1, contactsCreated: 1, skippedSoftDeletedContacts: 1 });
    const pContact = await runInTenant(tenantC.ctx, async (tx) =>
      tx.select({ isPrimary: contacts.isPrimary }).from(contacts).where(and(eq(contacts.tenantId, tenantC.ctx.slug), inArray(contacts.email, [pEmail]))),
    );
    expect(pContact).toHaveLength(1);
    expect(pContact[0]!.isPrimary).toBe(true); // member kept its primary (P)

    // RE-RUN: P now active, S still soft-deleted → nothing genuinely new → idempotent
    // skip, NOT a phantom partial-overlap (the R3 idempotency bug).
    const second = await commitMembers(tenantC.ctx, user.userId, [vm({ emails: [pEmail, sEmail] })], 2026);
    // The still-soft secondary the operator listed is reported, not silently dropped (R4 #2).
    expect(second).toMatchObject({
      membersCreated: 0, skippedExistingMembers: 1, skippedPartialOverlapMembers: 0, skippedSoftDeletedContacts: 1,
    });
    expect(second.partialOverlapRows).toHaveLength(0);
  });

  it('cross-member collision: active emails spanning TWO existing members is FLAGGED, never silently counted as already-imported (R4 #1/#7)', async () => {
    const aEmail = `xmA-${randomUUID().slice(0, 8)}@imp.test`;
    const bEmail = `xmB-${randomUUID().slice(0, 8)}@imp.test`;
    await seedActiveContact(tenantC, aEmail); // belongs to member M1
    await seedActiveContact(tenantC, bEmail); // belongs to a DIFFERENT member M2
    const before = await countMembers(tenantC.ctx.slug);
    // A workbook "company" listing a@ + b@ (no genuinely-new email) matches no SINGLE existing
    // member — it must be flagged for the operator, not silently bucketed as "already imported".
    const member = vm({ emails: [aEmail, bEmail] });
    const out = await commitMembers(tenantC.ctx, user.userId, [member], 2026);
    expect(out).toMatchObject({ membersCreated: 0, skippedExistingMembers: 0, skippedPartialOverlapMembers: 1 });
    expect(out.partialOverlapRows).toContain(member.rowIndices[0]);
    expect(await countMembers(tenantC.ctx.slug)).toBe(before);
  });

  it('mixed active+soft+new emails → partial overlap (a genuinely-new email wins over the soft set) (R4 #5)', async () => {
    const aEmail = `mxA-${randomUUID().slice(0, 8)}@imp.test`;
    const sEmail = `mxS-${randomUUID().slice(0, 8)}@imp.test`;
    const nEmail = `mxN-${randomUUID().slice(0, 8)}@imp.test`;
    await seedActiveContact(tenantC, aEmail); // A active
    await seedSoftContact(tenantC, sEmail); // S soft-deleted
    const before = await countMembers(tenantC.ctx.slug);
    const member = vm({ emails: [aEmail, sEmail, nEmail] }); // A active + S soft + N new
    const out = await commitMembers(tenantC.ctx, user.userId, [member], 2026);
    expect(out).toMatchObject({ membersCreated: 0, contactsCreated: 0, skippedPartialOverlapMembers: 1 });
    expect(out.partialOverlapRows).toContain(member.rowIndices[0]);
    expect(await countMembers(tenantC.ctx.slug)).toBe(before);
    const nRows = await runInTenant(tenantC.ctx, async (tx) =>
      tx.select({ id: contacts.contactId }).from(contacts).where(and(eq(contacts.tenantId, tenantC.ctx.slug), inArray(contacts.email, [nEmail]))),
    );
    expect(nRows).toHaveLength(0); // N never silently attached
  });

  it('NEW member whose every email is soft-deleted → primary-collision skip, idempotent on re-run (R4 #14/#15)', async () => {
    const pEmail = `asP-${randomUUID().slice(0, 8)}@imp.test`;
    const sEmail = `asS-${randomUUID().slice(0, 8)}@imp.test`;
    await seedSoftContact(tenantC, pEmail);
    await seedSoftContact(tenantC, sEmail);
    const before = await countMembers(tenantC.ctx.slug);
    const member = vm({ emails: [pEmail, sEmail] }); // primary + secondary both soft-deleted
    const first = await commitMembers(tenantC.ctx, user.userId, [member], 2026);
    expect(first).toMatchObject({ membersCreated: 0, skippedPrimaryCollisionMembers: 1 });
    expect(first.primaryCollisionRows).toContain(member.rowIndices[0]);
    expect(await countMembers(tenantC.ctx.slug)).toBe(before); // no zero-primary member created
    // Re-run: primary still soft, still no active contact → identical primary-collision skip.
    const second = await commitMembers(tenantC.ctx, user.userId, [vm({ emails: [pEmail, sEmail] })], 2026);
    expect(second).toMatchObject({ membersCreated: 0, skippedPrimaryCollisionMembers: 1, skippedExistingMembers: 0 });
  });

  it('NEW member with multiple secondaries, only one soft-deleted → primary + good secondary inserted, soft one skipped+counted (R4 #10)', async () => {
    const pEmail = `msP-${randomUUID().slice(0, 8)}@imp.test`;
    const s1Email = `msS1-${randomUUID().slice(0, 8)}@imp.test`;
    const s2Email = `msS2-${randomUUID().slice(0, 8)}@imp.test`;
    await seedSoftContact(tenantC, s2Email); // S2 already soft-deleted
    const member = vm({ emails: [pEmail, s1Email, s2Email] }); // P new primary, S1 new, S2 soft
    const out = await commitMembers(tenantC.ctx, user.userId, [member], 2026);
    expect(out).toMatchObject({ membersCreated: 1, contactsCreated: 2, skippedSoftDeletedContacts: 1 });
    const rows = await runInTenant(tenantC.ctx, async (tx) =>
      tx.select({ email: contacts.email, isPrimary: contacts.isPrimary }).from(contacts)
        .where(and(eq(contacts.tenantId, tenantC.ctx.slug), inArray(contacts.email, [pEmail, s1Email]))),
    );
    expect(rows).toHaveLength(2); // exactly P + S1 active
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1); // member keeps exactly one primary
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
