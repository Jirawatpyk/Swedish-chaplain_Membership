/**
 * Plan-change -> billing remediation (Package A, Step A2 RED) — cohort E:
 * the seed-rewire fallback. Live Neon Singapore via .env.local. MANDATORY.
 *
 * Rewiring the seed to read `members.plan_id` introduces a new failure mode:
 * the member's live plan may have NO catalogue row resolvable for the next
 * cycle's fiscal year (an archived/inactive plan). `createCycleInTx` throws
 * `PlanNotResolvableError` on such a gap. On the on-paid rails that throw
 * rolls back F4's payment tx — turning a silent pricing bug into a
 * Stripe-retry storm (cohort E). The fix must instead FALL BACK to the prior
 * cycle's plan (guaranteed billable) + emit a forensic
 * `member_plan_change_billing_effect(effect: 'seed_fallback_plan_unresolvable')`
 * audit, and NEVER roll back the payment.
 *
 * Setup: the member's live plan is Z (a single INACTIVE 2026 catalogue row),
 * while the prior cycle is frozen on plan A (a live 2026 row). The prior
 * cycle's period ends in 2027, so the next cycle's fiscal year is 2027 —
 * where Z has no row and no active row anywhere (its only row is inactive),
 * so `loadPlanFrozenFields(Z, 2027, freeze)` -> plan_inactive ->
 * PlanNotResolvableError. Plan A DOES resolve for 2027 (FREEZE most-recent-
 * active fallback), so the fallback next cycle is billable.
 *
 * SCOPE NOTE (Package A): the member's live plan is set to Z by a direct
 * UPDATE. The real `changePlan` cannot reach this state anyway — it validates
 * the target plan and rejects an inactive/unresolvable plan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_A_FEE_MINOR = 2_500_000; // 25,000.00 THB (fallback plan)
const PLAN_A_PRICE_THB = '25000.00';

// Prior cycle ends in 2027 -> next cycle is fiscal 2027, where plan Z (only a
// 2026 inactive row) is unresolvable but plan A (2026 active) resolves.
const PRIOR_PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PRIOR_PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

describe('plan-change seed fallback — cohort E (Package A)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planA: string;
  let planZ: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planA = `pcf-a-${randomUUID().slice(0, 8)}`;
    planZ = `pcf-z-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planA,
        planName: { en: 'Plan A (fallback)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: PLAN_A_FEE_MINOR,
        renewalTierBucket: 'regular',
      });
      // Plan Z: the member's live plan — a single INACTIVE 2026 row. FK
      // members_plan_tenant_year_fk requires the row to exist; is_active does
      // not gate the FK, so the member can point at this archived plan.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planZ,
        planName: { en: 'Plan Z (archived)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 4_500_000,
        renewalTierBucket: 'premium',
        isActive: false,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planA,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(2_500_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(175_000n),
        totalSatang: asSatang(2_675_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Cohort E Co',
          country: 'TH',
          legal_name: 'Cohort E Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'cohorte@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  it(
    'archived live plan: payment COMMITS, next cycle falls back to the prior plan, and exactly one seed_fallback audit row lands',
    async () => {
      const memberId = randomUUID();
      // Member first (invoices.member_id FK -> members), then the invoice,
      // then the cycles (the prior cycle links the invoice).
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Cohort E Co ${memberId.slice(0, 6)}`,
          country: 'TH',
          planId: planA,
          planYear: 2026,
          registrationFeePaid: true,
          registrationDate: '2020-01-01',
        }),
      );
      const invoiceId = await seedIssuedInvoice(memberId);
      await runInTenant(tenant.ctx, async (tx) => {
        // Terminal predecessor (settled history) so the paid cycle
        // classifies as `renewal` -> completes + creates a next cycle.
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'cancelled',
          periodFrom: new Date('2024-06-01T00:00:00.000Z'),
          periodTo: new Date('2025-06-01T00:00:00.000Z'),
          expiresAt: new Date('2025-06-01T00:00:00.000Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planA,
          frozenPlanPriceThb: PLAN_A_PRICE_THB,
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          anchoredAt: new Date('2024-06-01T00:00:00.000Z'),
          closedAt: new Date('2025-06-01T00:00:00.000Z'),
          closedReason: 'cancelled',
        });
        // Prior awaiting_payment cycle on A, linked to the issued invoice.
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'awaiting_payment',
          periodFrom: PRIOR_PERIOD_FROM,
          periodTo: PRIOR_PERIOD_TO,
          expiresAt: PRIOR_PERIOD_TO,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planA,
          frozenPlanPriceThb: PLAN_A_PRICE_THB,
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          linkedInvoiceId: invoiceId,
        });
        // DIVERGE to the archived plan Z (FK ok — Z has a 2026 row).
        await tx
          .update(members)
          .set({ planId: planZ })
          .where(eq(members.memberId, memberId));
      });

      const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
      const evt: F4InvoicePaidEvent = {
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        // Within the prior cycle's period (2026-06-01..2027-06-01) so the
        // member is not terminated at settlement; the NEXT cycle still lands
        // in fiscal 2027 (periodFrom = prior.periodTo = 2027-06-01), where the
        // archived plan Z is unresolvable.
        paidAt: '2027-01-15T09:00:00.000Z',
        amountSatang: asSatang(2_675_000n),
        vatSatang: asSatang(175_000n),
        currency: 'THB',
        paymentMethod: 'stripe_card',
        triggeredBy: 'webhook',
        invoiceSubject: 'membership',
        paymentDate: null,
      };

      // Payment must COMMIT (no throw) — the fallback never rolls it back.
      await expect(
        runInTenant(tenant.ctx, async (tx) => {
          for (const cb of callbacks) {
            await cb(evt, tx);
          }
        }),
      ).resolves.toBeUndefined();

      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({
            status: renewalCycles.status,
            planId: renewalCycles.planIdAtCycleStart,
            frozenPrice: renewalCycles.frozenPlanPriceThb,
          })
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberId)),
      );
      const next = rows.find((r) => r.status === 'upcoming');
      expect(next, 'a NEW upcoming next cycle must exist').toBeDefined();
      // Fallback to the prior cycle's plan (A) — the guaranteed-billable
      // predecessor — NOT the unresolvable live plan Z.
      expect(next!.planId).toBe(planA);
      expect(next!.frozenPrice).toBe(PLAN_A_PRICE_THB);

      // Exactly one forensic audit row records the fallback.
      const audits = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ payload: auditLog.payload })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenant.ctx.slug),
              eq(auditLog.eventType, 'member_plan_change_billing_effect' as never),
            ),
          ),
      );
      expect(audits).toHaveLength(1);
      const payload = audits[0]!.payload as Record<string, unknown>;
      expect(payload.effect).toBe('seed_fallback_plan_unresolvable');
      expect(payload.member_id).toBe(memberId);
      expect(payload.old_plan_id).toBe(planA);
      expect(payload.new_plan_id).toBe(planZ);
    },
    180_000,
  );
});
