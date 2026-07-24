/**
 * Integration test: scripts/check-plan-change-divergence.ts
 *
 * The pre-flag-flip reconcile detector — verifies it correctly:
 *   (a) reports 0 divergences for a cycle whose frozen price MATCHES its
 *       linked §86/4 membership line, and
 *   (b) reports exactly 1 divergence, with the right numbers, for a cycle
 *       whose frozen price was re-frozen ABOVE the price already billed on
 *       its linked (still-issued) §86/4.
 *
 * Runs against live Neon. Uses a `test-*` tenant slug so the rows are also
 * swept by `clear-test-data.ts` if a teardown is skipped. Seeds two members
 * (one matching, one divergent) to sidestep the `renewal_cycles_active_member_
 * uniq` partial-unique (at most one non-terminal cycle per member).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { checkPlanChangeDivergence } from '@/../scripts/check-plan-change-divergence';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('checkPlanChangeDivergence script', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  // Matching cohort.
  const matchMemberId = randomUUID();
  const matchInvoiceId = randomUUID();
  const matchCycleId = randomUUID();

  // Divergent cohort.
  const divMemberId = randomUUID();
  const divInvoiceId = randomUUID();
  const divCycleId = randomUUID();

  async function seedMember(memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Divergence Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      }),
    );
  }

  /**
   * Seed an ISSUED membership invoice + its single `membership_fee` line at
   * `unitPriceSatang`. Mirrors the full non-draft snapshot column set required
   * by `invoices_non_draft_has_snapshots` (see invoice-due-bridge probe test).
   */
  async function seedIssuedMembershipInvoice(
    invoiceId: string,
    memberId: string,
    unitPriceSatang: bigint,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
        invoiceSubject: 'membership',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: admin.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(unitPriceSatang),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang((unitPriceSatang * 7n) / 100n),
        totalSatang: asSatang(unitPriceSatang + (unitPriceSatang * 7n) / 100n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Divergence Co',
          country: 'TH',
          legal_name: 'Divergence Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Probe Person',
          primary_contact_email: 'probe@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      // Single membership_fee line at the given unit price, full cycle
      // (qty=1.0000, proRate=1.0000 — the renewal billing invariant).
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership Fee 2026',
        unitPriceSatang,
        quantity: '1.0000',
        proRateFactor: '1.0000',
        totalSatang: unitPriceSatang,
        position: 1,
      });
    });
  }

  async function seedLinkedCycle(
    cycleId: string,
    memberId: string,
    invoiceId: string,
    frozenThb: string,
  ): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: frozenThb,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      }),
    );
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'regular',
        planName: { en: 'Regular' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: 5_000_000,
        renewalTierBucket: 'regular',
      }),
    );

    // (a) MATCHING: frozen 50,000.00 THB, billed at 5,000,000 satang → agree.
    await seedMember(matchMemberId);
    await seedIssuedMembershipInvoice(matchInvoiceId, matchMemberId, 5_000_000n);
    await seedLinkedCycle(matchCycleId, matchMemberId, matchInvoiceId, '50000.00');

    // (b) DIVERGENT: cycle re-frozen to 80,000.00 THB but its linked §86/4 was
    //     already issued at the OLD 50,000.00 price → drift of 3,000,000 satang.
    await seedMember(divMemberId);
    await seedIssuedMembershipInvoice(divInvoiceId, divMemberId, 5_000_000n);
    await seedLinkedCycle(divCycleId, divMemberId, divInvoiceId, '80000.00');
  }, 180_000);

  afterAll(async () => {
    // FK-order teardown: cycles → invoice_lines → invoices → members → plans.
    for (const q of [
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('reports exactly the divergent cycle (matching cycle → 0, divergent cycle → 1 with right numbers)', async () => {
    const report = await checkPlanChangeDivergence();

    // Both seeded linked invoices were scanned.
    expect(report.scannedCount).toBeGreaterThanOrEqual(2);

    const mine = report.divergences.filter((d) => d.tenantId === tenant.ctx.slug);
    // The matching cycle produced 0 divergences; only the divergent one shows.
    expect(mine).toHaveLength(1);

    const row = mine[0]!;
    expect(row.cycleId).toBe(divCycleId);
    expect(row.memberId).toBe(divMemberId);
    expect(row.invoiceId).toBe(divInvoiceId);
    expect(row.kind).toBe('price_divergence');
    expect(row.frozenSatang).toBe(8_000_000n);
    expect(row.lineUnitPriceSatang).toBe(5_000_000n);
    expect(row.lineTotalSatang).toBe(5_000_000n);
    expect(row.deltaSatang).toBe(3_000_000n);
    expect(row.membershipLineCount).toBe(1);
    expect(row.proRatedLine).toBe(false);

    // The matching cycle is provably NOT flagged.
    expect(mine.some((d) => d.cycleId === matchCycleId)).toBe(false);
  });

  it('scoped to our tenant, reports the same single divergence', async () => {
    const report = await checkPlanChangeDivergence({ tenantId: tenant.ctx.slug });
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]!.cycleId).toBe(divCycleId);
    // Scoped scan sees exactly our two linked membership invoices.
    expect(report.scannedCount).toBe(2);
  });
});
