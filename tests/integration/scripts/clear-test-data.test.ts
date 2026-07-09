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
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { asTenantContext } from '@/modules/tenants';
import { asSatang } from '@/lib/money';
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
        memberNumber: 1,
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

  // 068 cluster E — the test-USER orphan pass must purge F8 renewal_cycles in
  // a NON-`test-%` tenant that link a test-user-orphaned invoice/member, or the
  // orphan `DELETE FROM invoices` / `DELETE FROM members` aborts the whole
  // script with an FK violation (`renewal_cycles_linked_invoice_fk` NO ACTION /
  // `renewal_cycles_member_fk` RESTRICT).
  it('purges renewal_cycles linking a test-user-orphaned invoice in a NON-test tenant (cluster E)', async () => {
    // A test user (drives the orphan-invoice predicate).
    const email = `test-${Date.now()}-cyclepurge@swecham.test`;
    createdEmails.push(email);
    const hash = await argon2Hasher.hash('Test-Password-CyclePurge-2026!');
    const userRows = await db
      .insert(users)
      .values({
        email,
        role: 'admin',
        status: 'active',
        passwordHash: hash,
        lastPasswordChangedAt: new Date(),
      })
      .returning();
    const userId = userRows[0]!.id;

    // A NON-`test-%` tenant slug — so the test-USER orphan pass (not the
    // tenant-scoped pass) is the only thing that can purge these rows. This
    // models stale cross-tenant data left by a partial prior cleanup.
    const slug = `clearcycle-${randomUUID().slice(0, 8)}`;
    const ctx = asTenantContext(slug);
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    const cycleId = randomUUID();

    try {
      await runInTenant(ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'CycleP TH',
          legalNameEn: 'CycleP EN',
          taxId: '0000000000000',
          registeredAddressTh: 'Addr TH',
          registeredAddressEn: 'Addr EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        await tx.insert(membershipPlans).values({
          tenantId: slug,
          planId: 'clearcycle-plan',
          planYear: 2026,
          planName: { en: 'CycleP Plan' },
          description: { en: 'desc' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 5_000_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          // created_by = the test user → drives the orphan-MEMBER predicate too.
          createdBy: userId,
          updatedBy: userId,
        });
        await tx.insert(members).values({
          tenantId: slug,
          memberId,
          memberNumber: 1,
          companyName: `CycleP Co ${Date.now()}`,
          country: 'TH',
          planId: 'clearcycle-plan',
          planYear: 2026,
          registrationDate: new Date().toISOString().slice(0, 10),
          registrationFeePaid: true,
          status: 'active',
          archivedAt: null,
        });
        // An ISSUED invoice drafted by the test user → drives the orphan-
        // INVOICE predicate. Full non-draft snapshot fields per the F4
        // `invoices_non_draft_has_snapshots` CHECK.
        await tx.insert(invoices).values({
          tenantId: slug,
          invoiceId,
          memberId,
          planYear: 2026,
          planId: 'clearcycle-plan',
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: userId,
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: 'INV-2026-000001',
          issueDate: '2026-05-15',
          dueDate: '2026-06-14',
          currency: 'THB',
          subtotalSatang: asSatang(5_000_000n),
          vatRateSnapshot: '0.0700',
          vatSatang: asSatang(350_000n),
          totalSatang: asSatang(5_350_000n),
          proRatePolicySnapshot: 'none',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
          memberIdentitySnapshot: {
            companyName: 'CycleP Co',
            country: 'TH',
            legal_name: 'CycleP Co Ltd',
            address: '1 Test Rd, Bangkok 10110',
            primary_contact_name: 'Test',
            primary_contact_email: 'cyclep@example.com',
          } as unknown,
          pdfBlobKey: `invoicing/${slug}/2026/${invoiceId}.pdf`,
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
        // The renewal_cycle linking BOTH the orphan invoice + member, in the
        // NON-test tenant — the row that the cluster-E fix must purge.
        await tx.insert(renewalCycles).values({
          tenantId: slug,
          cycleId,
          memberId,
          status: 'completed',
          periodFrom: new Date('2026-06-01T00:00:00Z'),
          periodTo: new Date('2027-06-01T00:00:00Z'),
          expiresAt: new Date('2027-06-01T00:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: 'clearcycle-plan',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          closedAt: new Date(),
          closedReason: 'paid',
          linkedInvoiceId: invoiceId,
        });
      });

      // The cleanup must NOT throw (without the cluster-E fix it aborts with an
      // FK violation on the orphan invoice/member delete) AND must remove the
      // cycle + invoice + member + the test user.
      const report = await clearTestData();
      expect(report.testUsers).toBeGreaterThanOrEqual(1);

      const cycleLeft = await db.execute(
        sql`SELECT cycle_id FROM renewal_cycles WHERE cycle_id = ${cycleId}::uuid`,
      );
      const invoiceLeft = await db.execute(
        sql`SELECT invoice_id FROM invoices WHERE invoice_id = ${invoiceId}::uuid`,
      );
      const memberLeft = await db.execute(
        sql`SELECT member_id FROM members WHERE member_id = ${memberId}::uuid`,
      );
      const userLeft = await db.execute(
        sql`SELECT id FROM users WHERE email = ${email}`,
      );
      const count = (r: unknown) =>
        Array.isArray(r) ? r.length : (r as { rows?: unknown[] }).rows?.length ?? 0;
      expect(count(cycleLeft)).toBe(0);
      expect(count(invoiceLeft)).toBe(0);
      expect(count(memberLeft)).toBe(0);
      expect(count(userLeft)).toBe(0);
    } finally {
      // Defensive cleanup of the non-test tenant (in case an assertion failed
      // before clearTestData ran, or the fix is absent).
      await db
        .delete(renewalCycles)
        .where(sql`tenant_id = ${slug}`)
        .catch(() => {});
      await db.execute(sql`DELETE FROM invoices WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM members WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM membership_plans WHERE tenant_id = ${slug}`).catch(() => {});
      await db
        .execute(sql`DELETE FROM tenant_invoice_settings WHERE tenant_id = ${slug}`)
        .catch(() => {});
    }
  }, 45_000);

  // 068 R2-5 — the orphan-cycle purge must ALSO match `linked_credit_note_id`.
  // A NON-`test-%` tenant cycle linking a test-user-issued credit_note (whose
  // row is purged later by the test-user pass) would otherwise block the
  // `DELETE FROM credit_notes` with `renewal_cycles_linked_credit_note_fk`
  // (NO ACTION, migration 0087). Isolate the credit-note arm: this cycle links
  // ONLY a credit_note (no linked_invoice_id, member is on a NON-test-user
  // plan), so the invoice/member arms cannot mask the credit-note arm.
  it('purges a renewal_cycle linking a test-user-issued credit_note in a NON-test tenant (R2-5)', async () => {
    // A standalone NON-test user seeds the member's plan so the orphan-MEMBER
    // arm does NOT match (proves the credit-note arm is what purges the cycle).
    const plannerEmail = `clearcn-planner-${Date.now()}@swecham.example`;
    createdEmails.push(plannerEmail);
    const plannerHash = await argon2Hasher.hash('Planner-Password-2026!');
    const plannerRows = await db
      .insert(users)
      .values({
        email: plannerEmail,
        role: 'admin',
        status: 'active',
        passwordHash: plannerHash,
        lastPasswordChangedAt: new Date(),
      })
      .returning();
    const plannerId = plannerRows[0]!.id;

    // The TEST user that ISSUES the credit_note → drives the credit-note arm.
    const cnEmail = `test-${Date.now()}-cnpurge@swecham.test`;
    createdEmails.push(cnEmail);
    const cnHash = await argon2Hasher.hash('Test-Password-CnPurge-2026!');
    const cnUserRows = await db
      .insert(users)
      .values({
        email: cnEmail,
        role: 'admin',
        status: 'active',
        passwordHash: cnHash,
        lastPasswordChangedAt: new Date(),
      })
      .returning();
    const cnUserId = cnUserRows[0]!.id;

    const slug = `clearcn-${randomUUID().slice(0, 8)}`;
    const ctx = asTenantContext(slug);
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    const creditNoteId = randomUUID();
    const cycleId = randomUUID();

    try {
      await runInTenant(ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'ClearCN TH',
          legalNameEn: 'ClearCN EN',
          taxId: '0000000000000',
          registeredAddressTh: 'Addr TH',
          registeredAddressEn: 'Addr EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        // Plan created by the NON-test planner → the member is NOT in the
        // orphan-MEMBER set.
        await tx.insert(membershipPlans).values({
          tenantId: slug,
          planId: 'clearcn-plan',
          planYear: 2026,
          planName: { en: 'ClearCN Plan' },
          description: { en: 'desc' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 5_000_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          createdBy: plannerId,
          updatedBy: plannerId,
        });
        await tx.insert(members).values({
          tenantId: slug,
          memberId,
          memberNumber: 1,
          companyName: `ClearCN Co ${Date.now()}`,
          country: 'TH',
          planId: 'clearcn-plan',
          planYear: 2026,
          registrationDate: new Date().toISOString().slice(0, 10),
          registrationFeePaid: true,
          status: 'active',
          archivedAt: null,
        });
        // An invoice drafted by the NON-test planner → NOT in the orphan-
        // INVOICE set. The credit_note references it as its original invoice.
        await tx.insert(invoices).values({
          tenantId: slug,
          invoiceId,
          memberId,
          planYear: 2026,
          planId: 'clearcn-plan',
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: plannerId,
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: 'INV-2026-000001',
          issueDate: '2026-05-15',
          dueDate: '2026-06-14',
          currency: 'THB',
          subtotalSatang: asSatang(5_000_000n),
          vatRateSnapshot: '0.0700',
          vatSatang: asSatang(350_000n),
          totalSatang: asSatang(5_350_000n),
          proRatePolicySnapshot: 'none',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
          memberIdentitySnapshot: {
            companyName: 'ClearCN Co',
            country: 'TH',
            legal_name: 'ClearCN Co Ltd',
            address: '1 Test Rd, Bangkok 10110',
            primary_contact_name: 'Test',
            primary_contact_email: 'clearcn@example.com',
          } as unknown,
          pdfBlobKey: `invoicing/${slug}/2026/${invoiceId}.pdf`,
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
        // The credit_note ISSUED BY the TEST user → drives the credit-note arm
        // of the orphan-cycle predicate (and is itself purged by the test-user
        // pass at `credit_notes.issued_by_user_id`).
        await tx.execute(sql`
          INSERT INTO credit_notes (
            tenant_id, credit_note_id, original_invoice_id,
            fiscal_year, sequence_number, document_number,
            issue_date, issued_by_user_id, reason,
            credit_amount_satang, vat_satang, total_satang,
            tenant_identity_snapshot, member_identity_snapshot,
            pdf_blob_key, pdf_sha256, pdf_template_version
          ) VALUES (
            ${slug}, ${creditNoteId}::uuid, ${invoiceId}::uuid,
            2026, 1, 'CN-2026-000001',
            '2026-05-20', ${cnUserId}::uuid, 'test orphan credit note',
            5000000, 350000, 5350000,
            ${'{"legalNameEn":"Test","taxId":"0"}'}::jsonb,
            ${'{"companyName":"ClearCN Co"}'}::jsonb,
            ${`invoicing/${slug}/2026/${creditNoteId}.pdf`}, ${'a'.repeat(64)}, 1
          )
        `);
        // The cycle linking ONLY the credit_note (no linked_invoice_id) — the
        // FR-005b admin-rejection-with-refund terminal state. `cancelled` does
        // NOT require linked_invoice_id (only `completed` does), so this row
        // isolates the credit-note arm of the orphan-cycle predicate.
        await tx.insert(renewalCycles).values({
          tenantId: slug,
          cycleId,
          memberId,
          status: 'cancelled',
          periodFrom: new Date('2026-06-01T00:00:00Z'),
          periodTo: new Date('2027-06-01T00:00:00Z'),
          expiresAt: new Date('2027-06-01T00:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: 'clearcn-plan',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          closedAt: new Date(),
          closedReason: 'admin_rejected_with_refund',
          linkedCreditNoteId: creditNoteId,
        });
      });

      // Must NOT throw (without R2-5 the credit_notes DELETE aborts on the
      // NO-ACTION FK) AND must remove the cycle + credit_note + test user.
      const report = await clearTestData();
      expect(report.testUsers).toBeGreaterThanOrEqual(1);

      const count = (r: unknown) =>
        Array.isArray(r) ? r.length : (r as { rows?: unknown[] }).rows?.length ?? 0;
      const cycleLeft = await db.execute(
        sql`SELECT cycle_id FROM renewal_cycles WHERE cycle_id = ${cycleId}::uuid`,
      );
      const cnLeft = await db.execute(
        sql`SELECT credit_note_id FROM credit_notes WHERE credit_note_id = ${creditNoteId}::uuid`,
      );
      const userLeft = await db.execute(
        sql`SELECT id FROM users WHERE email = ${cnEmail}`,
      );
      expect(count(cycleLeft)).toBe(0);
      expect(count(cnLeft)).toBe(0);
      expect(count(userLeft)).toBe(0);
    } finally {
      await db
        .delete(renewalCycles)
        .where(sql`tenant_id = ${slug}`)
        .catch(() => {});
      await db.execute(sql`DELETE FROM credit_notes WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM invoices WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM members WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM membership_plans WHERE tenant_id = ${slug}`).catch(() => {});
      await db
        .execute(sql`DELETE FROM tenant_invoice_settings WHERE tenant_id = ${slug}`)
        .catch(() => {});
    }
  }, 45_000);

  it('is idempotent — second run reports zero deletions', async () => {
    // First run may delete leftovers. Second run must return a clean slate.
    await clearTestData();
    const second = await clearTestData();
    expect(second.e2eMembers).toBe(0);
    expect(second.e2eContacts).toBe(0);
    expect(second.testUsers).toBe(0);
  }, 30_000);
});
