/**
 * Step 2.3 (plan-change immediate re-freeze, Phase 2) — change-plan drives the
 * renewals billing-remediation adapter end-to-end.
 *
 * When `applyPlanChangeToBilling` is wired, a manual admin change-plan:
 *   - flag ON + OPEN unlinked cycle       -> `applied_to_open_cycle` + the
 *     cycle's frozen_plan_* re-frozen to the new plan/price + a
 *     `member_plan_change_billing_effect` audit row (SAME tx, atomic);
 *   - flag ON + an ISSUED membership §86/4 -> `deferred_invoice_already_issued`
 *     + `blockingInvoiceId` + the cycle UNTOUCHED (never rewrite a tax invoice);
 *   - flag ON + no OPEN cycle             -> `no_open_cycle` + no cycle change;
 *   - flag OFF                            -> `deferred_immediate_not_enabled`
 *     + the cycle UNTOUCHED (Phase-1 defer-to-next-cycle billing).
 *
 * Live Neon Singapore via .env.local. RED (pre-implementation):
 * `makePlanChangeBillingRemediation` is not exported yet and `changePlan`'s ok
 * payload is still a bare Member (no `{ member, billingEffect }`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { changePlan } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makePlanChangeBillingRemediation } from '@/modules/renewals';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const OLD_PLAN = 'regular';
const NEW_PLAN = 'premium';

describe('change-plan -> billing remediation (Step 2.3)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  function depsWithFlag(immediateRefreezeEnabled: boolean) {
    return {
      ...buildMembersDeps(tenant.ctx),
      applyPlanChangeToBilling: makePlanChangeBillingRemediation(tenant.ctx.slug, {
        immediateRefreezeEnabled,
      }),
    };
  }

  async function seedMember(planId: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Remediation Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
    });
    return memberId;
  }

  async function seedOpenCycle(memberId: string): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-01-01T00:00:00.000Z'),
        periodTo: new Date('2027-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: OLD_PLAN,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return cycleId;
  }

  async function seedIssuedMembershipInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: OLD_PLAN,
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
        memberIdentitySnapshot: {
          companyName: 'Remediation Co',
          country: 'TH',
          legal_name: 'Remediation Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Rem Person',
          primary_contact_email: 'rem@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    return invoiceId;
  }

  function callChangePlan(memberId: string, immediateRefreezeEnabled: boolean) {
    return changePlan(
      memberId,
      { new_plan_id: NEW_PLAN, new_plan_year: 2026 },
      { actorUserId: admin.userId, requestId: `cp-${randomUUID().slice(0, 8)}` },
      depsWithFlag(immediateRefreezeEnabled),
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

  async function billingEffectAuditRows(memberId: string) {
    return db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_plan_change_billing_effect'),
        ),
      )
      .then((rows) =>
        rows.filter(
          (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
        ),
      );
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    for (const [planId, fee, tier] of [
      [OLD_PLAN, 5_000_000, 'regular'],
      [NEW_PLAN, 9_000_000, 'premium'],
    ] as const) {
      await runInTenant(tenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: planId },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
          annualFeeMinorUnits: fee,
          renewalTierBucket: tier,
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
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
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('flag ON + open unlinked cycle -> applied_to_open_cycle + cycle re-frozen + audit', async () => {
    const memberId = await seedMember(OLD_PLAN);
    const cycleId = await seedOpenCycle(memberId);

    const result = await callChangePlan(memberId, true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.member.planId as string).toBe(NEW_PLAN);
    expect(result.value.billingEffect?.effect).toBe('applied_to_open_cycle');

    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe(NEW_PLAN);
    expect(row.frozenPlanPriceThb).toBe('90000.00');
    expect(row.tierAtCycleStart).toBe('premium');

    const audits = await billingEffectAuditRows(memberId);
    expect(audits.length).toBe(1);
    expect((audits[0]!.payload as { effect?: string }).effect).toBe('applied_to_open_cycle');
  });

  it('flag ON + an issued membership §86/4 -> deferred_invoice_already_issued + cycle untouched', async () => {
    const memberId = await seedMember(OLD_PLAN);
    const cycleId = await seedOpenCycle(memberId);
    const invoiceId = await seedIssuedMembershipInvoice(memberId);

    const result = await callChangePlan(memberId, true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.billingEffect?.effect).toBe('deferred_invoice_already_issued');
    expect(result.value.billingEffect?.blockingInvoiceId).toBe(invoiceId);

    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe(OLD_PLAN);
    expect(row.frozenPlanPriceThb).toBe('50000.00');

    const audits = await billingEffectAuditRows(memberId);
    expect(audits.length).toBe(1);
    expect((audits[0]!.payload as { effect?: string }).effect).toBe(
      'deferred_invoice_already_issued',
    );
  });

  it('flag ON + no open cycle -> no_open_cycle', async () => {
    const memberId = await seedMember(OLD_PLAN);

    const result = await callChangePlan(memberId, true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.billingEffect?.effect).toBe('no_open_cycle');

    const audits = await billingEffectAuditRows(memberId);
    expect(audits.length).toBe(1);
    expect((audits[0]!.payload as { effect?: string }).effect).toBe('no_open_cycle');
  });

  it('flag OFF -> deferred_immediate_not_enabled + cycle untouched', async () => {
    const memberId = await seedMember(OLD_PLAN);
    const cycleId = await seedOpenCycle(memberId);

    const result = await callChangePlan(memberId, false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.billingEffect?.effect).toBe('deferred_immediate_not_enabled');
    // The member's plan STILL flips (Phase-1) — only the cycle re-freeze defers.
    expect(result.value.member.planId as string).toBe(NEW_PLAN);

    const row = await readCycle(cycleId);
    expect(row.planIdAtCycleStart).toBe(OLD_PLAN);
    expect(row.frozenPlanPriceThb).toBe('50000.00');

    const audits = await billingEffectAuditRows(memberId);
    expect(audits.length).toBe(1);
    expect((audits[0]!.payload as { effect?: string }).effect).toBe(
      'deferred_immediate_not_enabled',
    );
  });
});
