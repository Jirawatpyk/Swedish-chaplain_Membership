/**
 * membership-coverage-exclude-guard (mig 0281) — DB-enforcement integration
 * test (live Neon). The design designates the DB objects as the AUTHORITY that
 * closes the read-decide-write concurrency race the application pre-flight guard
 * cannot; unit/mock tests cannot exercise them. This pins, against live
 * Postgres:
 *   - the GiST EXCLUDE `invoices_membership_coverage_no_overlap` rejects a
 *     second COMMITTED membership §86/4 whose coverage OVERLAPS an existing one
 *     for the same (tenant, member) — SQLSTATE 23P01;
 *   - half-open `tstzrange('[)')`: adjacent terms (touch at periodTo) coexist;
 *   - drafts coexist (their `blocks_coverage` is false) — money-safety is the
 *     EXCLUDE on COMMITTED rows, never draft-blocking;
 *   - the STORED generated column `blocks_coverage` equals
 *     `coverage_from IS NOT NULL AND status IN ('issued','paid','partially_credited')`
 *     for every status — pinning the SAME literal that is triplicated in the DDL,
 *     the Drizzle mirror, and the domain `BLOCKING_STATUSES` to one oracle;
 *   - the CHECK `invoices_coverage_window_wellformed` rejects a half-set window;
 *   - the EXCLUDE is PER-member (a different member's overlapping bill coexists);
 *   - coverage round-trips (ISO → timestamptz → ISO).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { isExclusionViolation } from '@/lib/db-errors';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Coverage Excl Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

// Windows used across the cases.
const Y2026 = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') };
const Y2026_MID = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2027-06-01T00:00:00Z') }; // overlaps Y2026
const Y2027 = { from: new Date('2027-01-01T00:00:00Z'), to: new Date('2028-01-01T00:00:00Z') }; // adjacent to Y2026

describe('membership-coverage-exclude-guard — DB enforcement (mig 0281, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'coverage-excl-plan';
  let billSeq = 0;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Coverage Excl Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  /** Inserts a full COMMITTED (issued/paid/partially_credited) membership bill
   *  with the given coverage window. */
  async function seedCommittedBill(
    memberId: string,
    status: 'issued' | 'paid' | 'partially_credited',
    coverage: { from: Date; to: Date } | null,
  ): Promise<string> {
    const invoiceId = randomUUID();
    const isPaid = status === 'paid' || status === 'partially_credited';
    const n = String(++billSeq).padStart(6, '0');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status,
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        billDocumentNumberRaw: `SC-2026-${n}`,
        receiptDocumentNumberRaw: isPaid ? `RC-2026-${n}` : null,
        issueDate: '2026-01-15',
        dueDate: '2026-02-14',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: status === 'partially_credited' ? 10_000n : 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        autoEmailOnIssue: true,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: isPaid ? 'bank_transfer' : null,
        paymentReference: isPaid ? 'seed-ref' : null,
        paymentRecordedByUserId: isPaid ? user.userId : null,
        paymentDate: isPaid ? '2026-02-01' : null,
        paidAt: isPaid ? new Date('2026-02-01T03:00:00Z') : null,
        receiptPdfStatus: isPaid ? 'rendered' : null,
        coverageFrom: coverage?.from ?? null,
        coverageTo: coverage?.to ?? null,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 100_000n,
        totalSatang: 100_000n,
        position: 1,
      });
    });
    return invoiceId;
  }

  /** Inserts a minimal DRAFT membership bill (no numbering) with coverage. */
  async function seedDraftBill(
    memberId: string,
    coverage: { from: Date; to: Date } | null,
  ): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        coverageFrom: coverage?.from ?? null,
        coverageTo: coverage?.to ?? null,
      }),
    );
    return invoiceId;
  }

  async function selectBlocksCoverage(invoiceId: string): Promise<boolean | null | undefined> {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ blocks: invoices.blocksCoverage })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId))),
    );
    return row?.blocks;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Coverage Exclude Test Plan' },
        description: { en: 'mig 0281 pin' },
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
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(A) rejects a second COMMITTED bill whose coverage overlaps — 23P01', async () => {
    const m = await seedMember();
    await seedCommittedBill(m, 'issued', Y2026);
    let caught: unknown;
    try {
      await seedCommittedBill(m, 'issued', Y2026_MID); // overlaps [2026-06, 2027-06)
    } catch (e) {
      caught = e;
    }
    expect(caught, 'overlapping committed insert must throw').toBeDefined();
    expect(isExclusionViolation(caught), 'must be a 23P01 exclusion violation').toBe(true);
  }, 60_000);

  it('(B) adjacent terms coexist — half-open [from, to) touch at periodTo', async () => {
    const m = await seedMember();
    await seedCommittedBill(m, 'issued', Y2026); // [2026, 2027)
    // [2027, 2028) starts exactly where the first ends → no overlap.
    await expect(seedCommittedBill(m, 'paid', Y2027)).resolves.toBeTruthy();
  }, 60_000);

  it('(C) two overlapping DRAFT bills coexist — blocks_coverage is false for drafts', async () => {
    const m = await seedMember();
    await expect(seedDraftBill(m, Y2026)).resolves.toBeTruthy();
    await expect(seedDraftBill(m, Y2026_MID)).resolves.toBeTruthy();
  }, 60_000);

  it('(D) generated column blocks_coverage == (coverage set AND status ∈ committed set)', async () => {
    // The THREE committed statuses → blocks_coverage true. This pins the DB
    // generated column against a DDL drift that DROPS one of them (a same-period
    // double-bill regression). Each on its OWN member so their identical
    // coverage windows never trip the EXCLUDE against each other.
    for (const status of ['issued', 'paid', 'partially_credited'] as const) {
      const m = await seedMember();
      const id = await seedCommittedBill(m, status, Y2026);
      expect(await selectBlocksCoverage(id), `${status} + coverage → true`).toBe(true);
    }

    // draft + coverage → false (drafts never block at the DB layer).
    const mDraft = await seedMember();
    const draft = await seedDraftBill(mDraft, Y2026);
    expect(await selectBlocksCoverage(draft), 'draft + coverage → false').toBe(false);

    // committed + NULL coverage → false (legacy/first-payment/erased never
    // participate — matches the constraint's WHERE (blocks_coverage) predicate).
    const mNull = await seedMember();
    const issuedNull = await seedCommittedBill(mNull, 'issued', null);
    expect(await selectBlocksCoverage(issuedNull), 'issued + NULL coverage → false').toBe(false);
  }, 60_000);

  it('(E) rejects a half-set coverage window — invoices_coverage_window_wellformed CHECK', async () => {
    const m = await seedMember();
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: randomUUID(),
          memberId: m,
          planYear: 2026,
          planId,
          draftByUserId: user.userId,
          status: 'draft',
          coverageFrom: Y2026.from,
          coverageTo: null, // half-set — both-or-neither violated
        }),
      ),
    ).rejects.toThrow();
  }, 60_000);

  it('(F) the EXCLUDE is PER-member — a different member overlapping the same window coexists', async () => {
    const m1 = await seedMember();
    const m2 = await seedMember();
    await seedCommittedBill(m1, 'issued', Y2026);
    await expect(seedCommittedBill(m2, 'issued', Y2026_MID)).resolves.toBeTruthy();
  }, 60_000);

  it('(G) coverage round-trips ISO → timestamptz → ISO', async () => {
    const m = await seedMember();
    const id = await seedCommittedBill(m, 'issued', Y2026);
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ from: invoices.coverageFrom, to: invoices.coverageTo })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, id))),
    );
    expect(row?.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.to?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  }, 60_000);
});
