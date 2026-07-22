/**
 * Plan-change -> billing remediation (Package B1) — the PORTAL confirm-renewal
 * plan-change rail. Live Neon Singapore via .env.local.
 *
 * THE BUG (exposed by Package A's seed rewire): when a member confirms their
 * renewal and picks a DIFFERENT plan, `confirmRenewal` re-freezes the CYCLE to
 * the new plan but never writes `members.plan_id`. Once the next-cycle seed
 * reads `members.plan_id` (Package A), the member's own choice REVERTS one
 * cycle later — a regression on a member-initiated action.
 *
 * THE FIX (this file pins it): `confirmRenewal`'s plan-change branch also
 * flips `members.plan_id` (+ `plan_year`) in the SAME tx, above the invoice
 * issuance, so the choice persists and the next cycle follows it.
 *
 * The F4 invoicing bridge is MOCKED to return a pre-seeded issued invoice —
 * this test pins the members.plan_id persistence + next-cycle seed, NOT the
 * §86/4 issuance (covered elsewhere).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { makeRenewalsDeps, f8OnPaidCallbacks } from '@/modules/renewals';
import type { RenewalsDeps } from '@/modules/renewals';
import { confirmRenewal } from '@/modules/renewals/application/use-cases/confirm-renewal';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PREMIUM_FEE_MINOR = 9_000_000; // 90,000.00 THB
const PREMIUM_PRICE_THB = '90000.00';

const PRIOR_PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PRIOR_PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface Scenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string;
}

describe('confirm-renewal persists the member plan choice (Package B1)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  async function seedMemberOnRegular(): Promise<Scenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Portal Pick Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Portal',
        lastName: 'Pick',
        email: `pp-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      // Terminal predecessor -> the paying cycle classifies as `renewal`.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      });
      // Pre-seeded issued invoice — the mocked bridge returns THIS id, and the
      // paid rail resolves the prior cycle by it.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'premium',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: admin.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(9_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(630_000n),
        totalSatang: asSatang(9_630_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Portal Pick Co',
          country: 'TH',
          legal_name: 'Portal Pick Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Portal Pick',
          primary_contact_email: 'pp@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: PRIOR_PERIOD_FROM,
        periodTo: PRIOR_PERIOD_TO,
        expiresAt: PRIOR_PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    return { memberId, cycleId, invoiceId };
  }

  /** Mock the F8->F4 invoicing bridge to "issue" the pre-seeded invoice. */
  function mockInvoicingBridge(deps: RenewalsDeps, invoiceId: string): RenewalsDeps {
    return {
      ...deps,
      f4InvoicingBridge: {
        issueInvoiceForRenewal: async () => ({
          status: 'issued' as const,
          invoiceId,
          invoiceNumber: 'INV-2026-CONFIRM',
          totalSatang: asSatang(9_630_000n),
        }),
      },
    };
  }

  async function loadMemberPlan(memberId: string): Promise<{ planId: string; planYear: number }> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId, planYear: members.planYear })
        .from(members)
        .where(eq(members.memberId, memberId)),
    );
    return { planId: rows[0]!.planId, planYear: rows[0]!.planYear };
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
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'premium',
        planName: { en: 'Premium' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: PREMIUM_FEE_MINOR,
        renewalTierBucket: 'premium',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('confirmRenewal with a new plan flips members.plan_id AND the next cycle follows it', async () => {
    const scenario = await seedMemberOnRegular();

    const deps = mockInvoicingBridge(makeRenewalsDeps(tenant.ctx.slug), scenario.invoiceId);
    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      memberId: scenario.memberId,
      newPlanId: 'premium',
      actorUserId: admin.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(result.ok, `confirmRenewal: ${JSON.stringify(result.ok ? null : result.error)}`).toBe(true);
    if (result.ok) expect(result.value.planChanged).toBe(true);

    // THE FIX — the member's own choice is now persisted (was 'regular').
    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id after confirm').toBe('premium');
    expect(member.planYear, 'members.plan_year after confirm').toBe(2026);

    // Pay via the ONLINE rail so the next cycle is seeded from members.plan_id.
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt: F4InvoicePaidEvent = {
        tenantId: tenant.ctx.slug,
        invoiceId: scenario.invoiceId,
        memberId: scenario.memberId,
        paidAt: new Date('2026-06-05T09:00:00.000Z').toISOString(),
        amountSatang: asSatang(9_630_000n),
        vatSatang: asSatang(630_000n),
        currency: 'THB',
        paymentMethod: 'stripe_card',
        triggeredBy: 'webhook',
        invoiceSubject: 'membership',
        paymentDate: null,
      };
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          planId: renewalCycles.planIdAtCycleStart,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, scenario.memberId)),
    );
    const next = rows.find((r) => r.cycleId !== scenario.cycleId && r.status === 'upcoming');
    expect(next, 'a NEW upcoming next cycle must exist').toBeDefined();
    expect(next!.planId, 'next cycle planId').toBe('premium');
    expect(next!.frozenPrice, 'next cycle frozen price').toBe(PREMIUM_PRICE_THB);
  }, 120_000);
});
