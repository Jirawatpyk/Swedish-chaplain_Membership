/**
 * Plan-change -> billing remediation (Package A, Step A2 RED) — the SECOND
 * seed site: the UNLINKED-payment rail. Live Neon Singapore via .env.local.
 *
 * When an admin-created ad-hoc membership invoice is paid (the cycle's
 * `linked_invoice_id` stays NULL), F4's record-payment callback[0]
 * (`markCycleComplete`) hits `no_cycle_for_invoice` and delegates to
 * `resolveUnlinkedMembershipPaymentInTx`. For a member with an anchored open
 * cycle the classifier returns `renewal`, so `renewalComplete` completes the
 * open cycle and creates the next cycle — seeding it from
 * `cycle.planIdAtCycleStart` (`resolve-unlinked-membership-payment.ts:614`),
 * NOT from `members.plan_id`. Fixing only `create-next-cycle-on-paid.ts`
 * leaves this rail diverging, so it needs its own regression net.
 *
 * SCOPE NOTE (Package A): the member's live plan is set to B by a direct
 * `members.plan_id` UPDATE (see plan-change-reaches-next-cycle.test.ts for
 * the rationale) — the seed reads only that column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_A_FEE_MINOR = 2_500_000; // 25,000.00 THB
const PLAN_B_FEE_MINOR = 4_500_000; // 45,000.00 THB
const PLAN_A_PRICE_THB = '25000.00';
const PLAN_B_PRICE_THB = '45000.00';
const PLAN_B_TIER = 'premium' as const;

describe('plan-change reaches the next cycle — UNLINKED ad-hoc payment rail (Package A)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planA: string;
  let planB: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planA = `pcu-a-${randomUUID().slice(0, 8)}`;
    planB = `pcu-b-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planA,
        planName: { en: 'Plan A (frozen)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: PLAN_A_FEE_MINOR,
        renewalTierBucket: 'regular',
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planB,
        planName: { en: 'Plan B (member live)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: PLAN_B_FEE_MINOR,
        renewalTierBucket: PLAN_B_TIER,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /** An already-paid ad-hoc membership invoice, NOT linked to any cycle. */
  async function seedPaidAdHocInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planB,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(4_500_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(315_000n),
        totalSatang: asSatang(4_815_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Unlinked Co',
          country: 'TH',
          legal_name: 'Unlinked Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'unlinked@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'ADHOC-PAY',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-08-16',
        paidAt: new Date('2026-08-16T09:00:00.000Z'),
      }),
    );
    return invoiceId;
  }

  it(
    'ad-hoc unlinked payment: renewalComplete seeds the next cycle from members.plan_id (B), not the paid cycle plan (A)',
    async () => {
      const memberId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Unlinked Co ${memberId.slice(0, 6)}`,
          country: 'TH',
          planId: planA,
          planYear: 2026,
          registrationFeePaid: true,
          registrationDate: '2020-01-01',
        });
        // A single ANCHORED, open cycle on plan A, linked to NO invoice.
        // Anchored -> the classifier returns `renewal` (not first_payment)
        // for the next payment, hitting renewalComplete.
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'awaiting_payment',
          periodFrom: new Date('2025-12-01T00:00:00.000Z'),
          periodTo: new Date('2026-12-01T00:00:00.000Z'),
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planA,
          frozenPlanPriceThb: PLAN_A_PRICE_THB,
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          anchoredAt: new Date('2025-12-01T00:00:00.000Z'),
          linkedInvoiceId: null,
        });
        // DIVERGE: the member's live plan is now B.
        await tx
          .update(members)
          .set({ planId: planB })
          .where(eq(members.memberId, memberId));
      });

      const invoiceId = await seedPaidAdHocInvoice(memberId);

      const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
      await runInTenant(tenant.ctx, async (tx) => {
        const evt: F4InvoicePaidEvent = {
          tenantId: tenant.ctx.slug,
          invoiceId,
          memberId,
          paidAt: '2026-08-16T09:00:00.000Z',
          amountSatang: asSatang(4_815_000n),
          vatSatang: asSatang(315_000n),
          currency: 'THB',
          paymentMethod: 'bank_transfer',
          triggeredBy: 'admin_manual',
          invoiceSubject: 'membership',
          paymentDate: '2026-08-16',
        };
        for (const cb of callbacks) {
          await cb(evt, tx);
        }
      });

      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({
            status: renewalCycles.status,
            planId: renewalCycles.planIdAtCycleStart,
            frozenPrice: renewalCycles.frozenPlanPriceThb,
            tier: renewalCycles.tierAtCycleStart,
          })
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberId)),
      );
      const next = rows.find((r) => r.status === 'upcoming');
      expect(next, 'a NEW upcoming next cycle must exist').toBeDefined();

      // Fails today: renewalComplete seeds from cycle.planIdAtCycleStart (A).
      expect(next!.planId).toBe(planB);
      expect(next!.frozenPrice).toBe(PLAN_B_PRICE_THB);
      expect(next!.tier).toBe(PLAN_B_TIER);
    },
    180_000,
  );
});
