/**
 * Step 2.2 (plan-change immediate re-freeze, Phase 2) — the guarded
 * `refreezeOpenCycleForPlanChangeInTx` repo method.
 *
 * Distinct from `updateFrozenPlan` (awaiting_payment-only, invoice-UNGUARDED,
 * THROWS on 0 rows): this method re-freezes the 5 frozen_plan_* columns of an
 * OPEN (upcoming|reminded|awaiting_payment) cycle ONLY WHILE it is still
 * unlinked (`linked_invoice_id IS NULL`), and returns `null` (never throws) on
 * 0 rows — the cycle raced into a terminal/linked/issued state and the caller
 * must DEFER (never rewrite an issued §86/4 — tax-safe).
 *
 * Live Neon Singapore via .env.local (RLS-scoped by `runInTenant`).
 *
 * RED (pre-implementation): the method does not yet exist on the repo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang, parseThbDecimal } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const NEW_ARGS = {
  planIdAtCycleStart: 'premium',
  tierAtCycleStart: 'premium' as const,
  frozenPlanPriceThb: parseThbDecimal('90000.00'),
  frozenPlanTermMonths: 12,
  frozenPlanCurrency: 'THB' as const,
};

describe('RenewalCycleRepo.refreezeOpenCycleForPlanChangeInTx (Step 2.2)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Refreeze Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
    });
    return memberId;
  }

  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
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
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: { companyName: 'Refreeze Co' } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    return invoiceId;
  }

  /** Seed a cycle on plan 'regular' @ 50,000.00 THB / tier regular. */
  async function seedCycle(
    memberId: string,
    overrides: Partial<typeof renewalCycles.$inferInsert>,
  ): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date('2026-01-01T00:00:00.000Z'),
        periodTo: new Date('2027-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        ...overrides,
      });
    });
    return cycleId;
  }

  function refreeze(cycleId: string) {
    const repo = makeDrizzleRenewalCycleRepo(tenant.ctx);
    return runInTenant(tenant.ctx, (tx) =>
      repo.refreezeOpenCycleForPlanChangeInTx(
        tx,
        tenant.ctx.slug,
        asCycleId(cycleId),
        NEW_ARGS,
      ),
    );
  }

  async function readCycle(cycleId: string) {
    const rows = await db
      .select()
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId))
      .limit(1);
    return rows[0]!;
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    for (const [planId, fee, tier] of [
      ['regular', 5_000_000, 'regular'],
      ['premium', 9_000_000, 'premium'],
    ] as const) {
      await runInTenant(tenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: planId },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
          annualFeeMinorUnits: fee,
          minTurnoverMinorUnits: 50_000_000,
          renewalTierBucket: tier,
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('(a) open + unlinked → re-freezes the 5 frozen cols to the new plan/price/tier', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle(memberId, { status: 'awaiting_payment' });

    const result = await refreeze(cycleId);

    expect(result).not.toBeNull();
    expect(result?.planIdAtCycleStart).toBe('premium');
    expect(result?.tierAtCycleStart).toBe('premium');
    expect(result?.frozenPlanPriceThb).toBe('90000.00');
    expect(result?.frozenPlanTermMonths).toBe(12);
    expect(result?.frozenPlanCurrency).toBe('THB');

    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe('premium');
    expect(row.frozenPlanPriceThb).toBe('90000.00');
    expect(row.tierAtCycleStart).toBe('premium');
  });

  it('(b) linked_invoice_id set → null, row unchanged (never rewrite a cycle whose §86/4 exists)', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);
    const cycleId = await seedCycle(memberId, {
      status: 'awaiting_payment',
      linkedInvoiceId: invoiceId,
    });

    const result = await refreeze(cycleId);

    expect(result).toBeNull();
    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe('regular');
    expect(row.frozenPlanPriceThb).toBe('50000.00');
    expect(row.tierAtCycleStart).toBe('regular');
  });

  it('(c) terminal (cancelled) → null, row unchanged', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle(memberId, {
      status: 'cancelled',
      closedAt: new Date('2026-02-01T00:00:00.000Z'),
      closedReason: 'cancelled',
    });

    const result = await refreeze(cycleId);

    expect(result).toBeNull();
    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe('regular');
    expect(row.frozenPlanPriceThb).toBe('50000.00');
  });
});
