/**
 * T012 — F3 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probe on every
 * CRUD operation against both `members` and `contacts`, from both directions.
 *
 * Why this is a blocker: F3 is the first F-stream feature that handles PII
 * at scale (~131 SweCham members + ~164 contacts day one). A single missed
 * RLS path leaks contact emails / phones / DOBs across chambers.
 *
 * This file mirrors `tests/integration/plans/tenant-isolation.test.ts` (F2)
 * applied to the members+contacts tables + adds two F3-specific checks:
 *   - contacts FK to members: cross-tenant contact insert rejected by
 *     composite FK even before RLS fires
 *   - primary-contact partial unique index: two primaries for the SAME
 *     member in the SAME tenant is rejected; primaries for different
 *     tenants' members with the same email coexist peacefully
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

// --- Fixtures -----------------------------------------------------------------

const CORPORATE_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

// Per-call UUIDs so parallel CI runs never collide on PK.
function seedMembersFor(tenantSlug: string, prefix: string) {
  return [0, 1, 2].map((i) => ({
    tenantId: tenantSlug,
    memberId: randomUUID(),
    companyName: `${prefix} Company ${i}`,
    country: 'TH',
    planId: `${prefix}-plan-0`,
    planYear: 2026,
  }));
}

describe('F3 Tenant isolation — REVIEW GATE BLOCKER (T012)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberIds: string[];
  let bMemberIds: string[];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed a plan per tenant (FK prerequisite for members.plan_id)
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantA.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: 'alpha-plan-0',
        planYear: 2026,
        planName: { en: 'Alpha Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: CORPORATE_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantB.ctx.slug,
        currencyCode: 'SEK',
        vatRate: '0.2500',
        registrationFeeSatang: 50000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenantB.ctx.slug,
        planId: 'beta-plan-0',
        planYear: 2026,
        planName: { en: 'Beta Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 2_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: CORPORATE_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });

    // Seed 3 members per tenant + 1 primary contact per member
    const aSeeds = seedMembersFor(tenantA.ctx.slug, 'alpha');
    const bSeeds = seedMembersFor(tenantB.ctx.slug, 'beta');
    aMemberIds = aSeeds.map((m) => m.memberId);
    bMemberIds = bSeeds.map((m) => m.memberId);

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values(aSeeds);
      await tx.insert(contacts).values(
        aSeeds.map((m, i) => ({
          tenantId: tenantA.ctx.slug,
          contactId: randomUUID(),
          memberId: m.memberId,
          firstName: 'Alpha',
          lastName: `Primary${i}`,
          email: `alpha${i}@example.com`,
          isPrimary: true,
          preferredLanguage: 'en' as const,
        })),
      );
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(members).values(bSeeds);
      await tx.insert(contacts).values(
        bSeeds.map((m, i) => ({
          tenantId: tenantB.ctx.slug,
          contactId: randomUUID(),
          memberId: m.memberId,
          firstName: 'Beta',
          lastName: `Primary${i}`,
          email: `beta${i}@example.com`,
          isPrimary: true,
          preferredLanguage: 'en' as const,
        })),
      );
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // --- members SELECT isolation ---------------------------------------------

  it('A sees only A members (not B)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(members));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
  });

  it('B sees only B members (not A)', async () => {
    const rows = await runInTenant(tenantB.ctx, (tx) => tx.select().from(members));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantB.ctx.slug)).toBe(true);
  });

  it('A.getMember(B.member_id) returns empty (FR-022 cross-tenant probe)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, bMemberIds[0]!)),
    );
    expect(rows).toHaveLength(0);
  });

  // --- contacts SELECT isolation --------------------------------------------

  it('A sees only A contacts (not B)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(contacts));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
  });

  it('B sees only B contacts (not A)', async () => {
    const rows = await runInTenant(tenantB.ctx, (tx) => tx.select().from(contacts));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantB.ctx.slug)).toBe(true);
  });

  // --- UPDATE isolation -----------------------------------------------------

  it('A.update(B.member_id) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(members)
        .set({ companyName: 'HIJACKED' })
        .where(eq(members.memberId, bMemberIds[0]!))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, bMemberIds[0]!)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.companyName).toBe('beta Company 0');
  });

  // --- DELETE isolation -----------------------------------------------------

  it('A.delete(B.contact) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .delete(contacts)
        .where(eq(contacts.memberId, bMemberIds[0]!))
        .returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  // --- INSERT with mismatched tenant_id rejected by WITH CHECK --------------

  it('A.insert(member) with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          memberId: randomUUID(),
          companyName: 'Forged',
          country: 'TH',
          planId: 'beta-plan-0',
          planYear: 2026,
        }),
      ),
    ).rejects.toThrow();
  });

  it('A.insert(contact) with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(contacts).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          contactId: randomUUID(),
          memberId: bMemberIds[0]!,
          firstName: 'Forged',
          lastName: 'Contact',
          email: 'forged@example.com',
          preferredLanguage: 'en',
        }),
      ),
    ).rejects.toThrow();
  });

  // --- Secure default: unset app.current_tenant = zero rows -----------------

  it('unset app.current_tenant returns 0 rows on members', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(members);
    });
    expect(rows).toHaveLength(0);
  });

  it('unset app.current_tenant returns 0 rows on contacts', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(contacts);
    });
    expect(rows).toHaveLength(0);
  });

  // --- Per-tenant email uniqueness (spec edge case) -------------------------

  it('same contact email in two tenants coexists (consultant across tenants)', async () => {
    const email = 'shared-consultant@example.com';
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: aMemberIds[0]!,
        firstName: 'Shared',
        lastName: 'A',
        email,
        preferredLanguage: 'en',
      }),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug,
        contactId: randomUUID(),
        memberId: bMemberIds[0]!,
        firstName: 'Shared',
        lastName: 'B',
        email,
        preferredLanguage: 'en',
      }),
    );

    const fromA = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, email)),
    );
    const fromB = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, email)),
    );
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
  });

  // --- Primary-contact partial unique index enforcement ---------------------

  it('two primary contacts on the SAME member rejected by partial unique index', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(contacts).values({
          tenantId: tenantA.ctx.slug,
          contactId: randomUUID(),
          memberId: aMemberIds[0]!,
          firstName: 'Second',
          lastName: 'Primary',
          email: `second-primary-${Date.now()}@example.com`,
          isPrimary: true,
          preferredLanguage: 'en',
        }),
      ),
    ).rejects.toThrow();
  });

  // --- Cross-tenant composite FK violation on contacts.member_id ------------

  it('insert contact with member_id from another tenant fails (composite FK)', async () => {
    // Even if we wave the WITH CHECK by providing the "right" tenant_id,
    // the composite FK (tenant_id, member_id) → members won't find
    // the foreign row because we're referencing A's member from A's context
    // but using B's member_id → no matching (A.slug, B.member_id) tuple.
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(contacts).values({
          tenantId: tenantA.ctx.slug,
          contactId: randomUUID(),
          memberId: bMemberIds[0]!, // B's member from A's context
          firstName: 'Cross',
          lastName: 'Tenant',
          email: 'cross-tenant-fk@example.com',
          preferredLanguage: 'en',
        }),
      ),
    ).rejects.toThrow();
  });
});
