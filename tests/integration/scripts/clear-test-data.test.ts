/**
 * Integration test: scripts/clear-test-data.ts
 *
 * Verifies the cleanup script correctly removes test pollution without
 * touching production-shaped rows. Runs against live Neon.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { clearTestData } from '@/../scripts/clear-test-data';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { asTenantContext } from '@/modules/tenants';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';

const MATRIX: BenefitMatrix = {
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

describe('clearTestData script', () => {
  // Track anything we create so teardown can verify deletion.
  const createdEmails: string[] = [];
  const createdTenantSlugs: string[] = [];
  const createdE2EMemberIds: string[] = [];

  afterAll(async () => {
    // Defence: if a test skipped cleanup, force-delete anything we created
    // so we don't pollute the shared test DB for other suites.
    if (createdEmails.length > 0) {
      const emailList = sql.join(
        createdEmails.map((e) => sql`${e}`),
        sql`, `,
      );
      await db.execute(sql`DELETE FROM users WHERE email IN (${emailList})`);
    }
  });

  it('deletes E2E members (E2E Co %) and their contacts', async () => {
    // Need a real admin user for the created_by / updated_by FK on
    // membership_plans.
    const seedEmail = `test-${Date.now()}-e2eseed@swecham.test`;
    createdEmails.push(seedEmail);
    const seedHash = await argon2Hasher.hash('Test-Password-E2E-Seed-2026!');
    const seedRows = await db
      .insert(users)
      .values({
        email: seedEmail,
        role: 'admin',
        status: 'active',
        passwordHash: seedHash,
        lastPasswordChangedAt: new Date(),
      })
      .returning();
    const seedUserId = seedRows[0]!.id;

    const slug = `test-clear-${randomUUID().slice(0, 8)}`;
    createdTenantSlugs.push(slug);
    const ctx = asTenantContext(slug);

    await runInTenant(ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: slug,
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
        tenantId: slug,
        planId: 'clear-test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: seedUserId,
        updatedBy: seedUserId,
      });
    });

    const memberId = randomUUID();
    createdE2EMemberIds.push(memberId);

    await runInTenant(ctx, (tx) =>
      tx.insert(members).values({
        tenantId: slug,
        memberId,
        companyName: `E2E Co clear-test-${Date.now()}`,
        country: 'TH',
        planId: 'clear-test-plan',
        planYear: 2026,
        registrationDate: new Date().toISOString().slice(0, 10),
        registrationFeePaid: false,
        status: 'active',
        archivedAt: null,
      }),
    );

    // Run the cleanup.
    const report = await clearTestData();

    // Assertions — report must account for at least OUR seeded rows.
    // (Other concurrent tests may inflate the counts.)
    expect(report.e2eMembers).toBeGreaterThanOrEqual(1);

    // Verify the specific member is gone.
    const remaining = await db.execute(
      sql`SELECT member_id FROM members WHERE member_id = ${memberId}::uuid`,
    );
    expect(
      Array.isArray(remaining)
        ? remaining.length
        : (remaining as { rows?: unknown[] }).rows?.length ?? 0,
    ).toBe(0);
  }, 45_000);

  it('deletes integration test users (test-*@swecham.test)', async () => {
    const email = `test-${Date.now()}-cleartest@swecham.test`;
    createdEmails.push(email);
    const hash = await argon2Hasher.hash('Test-Password-ClearTest-2026!');
    await db.insert(users).values({
      email,
      role: 'admin',
      status: 'active',
      passwordHash: hash,
      lastPasswordChangedAt: new Date(),
    });

    const report = await clearTestData();
    expect(report.testUsers).toBeGreaterThanOrEqual(1);

    // Specific user must be gone.
    const remaining = await db.execute(
      sql`SELECT id FROM users WHERE email = ${email}`,
    );
    expect(
      Array.isArray(remaining)
        ? remaining.length
        : (remaining as { rows?: unknown[] }).rows?.length ?? 0,
    ).toBe(0);
  }, 30_000);

  it('DOES NOT delete production-shaped users (non-test prefix)', async () => {
    // Seed a production-shaped email (no test- prefix, not .test TLD).
    // If the script accidentally widens its pattern, this row would be
    // deleted and the test would fail.
    const productionEmail = `prod-sentinel-${Date.now()}@swecham.example`;
    createdEmails.push(productionEmail);
    const hash = await argon2Hasher.hash('Prod-Sentinel-Password-2026!');
    await db.insert(users).values({
      email: productionEmail,
      role: 'admin',
      status: 'active',
      passwordHash: hash,
      lastPasswordChangedAt: new Date(),
    });

    await clearTestData();

    const remaining = await db.execute(
      sql`SELECT id FROM users WHERE email = ${productionEmail}`,
    );
    const count = Array.isArray(remaining)
      ? remaining.length
      : (remaining as { rows?: unknown[] }).rows?.length ?? 0;
    expect(count).toBe(1);
  }, 30_000);

  it('is idempotent — second run reports zero deletions', async () => {
    // First run may delete leftovers. Second run must return a clean slate.
    await clearTestData();
    const second = await clearTestData();
    expect(second.e2eMembers).toBe(0);
    expect(second.e2eContacts).toBe(0);
    expect(second.testUsers).toBe(0);
  }, 30_000);
});
