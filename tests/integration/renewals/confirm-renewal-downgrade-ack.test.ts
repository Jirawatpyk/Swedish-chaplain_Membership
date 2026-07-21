/**
 * WP4 — the confirm-renewal DOWNGRADE acknowledgement gate. Live Neon
 * Singapore via .env.local.
 *
 * The gate sits ABOVE the first write inside the Step-1 `runInTenant` tx —
 * `err()` inside `runInTenant` COMMITS earlier writes, so a refusal placed
 * below the lazy `upcoming → awaiting_payment` transition would leave the
 * cycle flipped and an audit row written for a renewal that never happened.
 *
 * This file proves the refusal is a genuine NO-OP at the DATABASE level:
 * the cycle stays `upcoming`, the frozen plan is untouched, `members.plan_id`
 * is untouched, and ZERO audit rows are written. Then it proves the
 * acknowledged path still flips everything (cycle re-freeze + members.plan_id
 * + the `renewal_with_plan_change` audit).
 *
 * The F4 invoicing bridge is MOCKED to return a pre-seeded issued invoice —
 * this pins the gate, not the §86/4 issuance (covered elsewhere).
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
import { makeRenewalsDeps } from '@/modules/renewals';
import type { RenewalsDeps } from '@/modules/renewals';
import { confirmRenewal } from '@/modules/renewals/application/use-cases/confirm-renewal';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// premium (dearer, the member's current plan) → regular (cheaper) = downgrade.
const PREMIUM_FEE_MINOR = 9_000_000; // 90,000.00 THB
const PREMIUM_PRICE_THB = '90000.00';
const REGULAR_FEE_MINOR = 5_000_000; // 50,000.00 THB
const REGULAR_PRICE_THB = '50000.00';

const PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface Scenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string;
}

describe('confirm-renewal downgrade acknowledgement gate (WP4)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  /** Member on PREMIUM with an `upcoming` cycle frozen at the premium price. */
  async function seedMemberOnPremium(): Promise<Scenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Downgrade Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'premium',
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Down',
        lastName: 'Grade',
        email: `dg-${memberId.slice(0, 8)}@example.com`,
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
        tierAtCycleStart: 'premium',
        planIdAtCycleStart: 'premium',
        frozenPlanPriceThb: PREMIUM_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
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
          companyName: 'Downgrade Co',
          country: 'TH',
          legal_name: 'Downgrade Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Down Grade',
          primary_contact_email: 'dg@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      // The cycle under test — `upcoming`, so a refusal that leaked past the
      // gate would visibly flip it to `awaiting_payment`.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'premium',
        planIdAtCycleStart: 'premium',
        frozenPlanPriceThb: PREMIUM_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    return { memberId, cycleId, invoiceId };
  }

  function mockInvoicingBridge(deps: RenewalsDeps, invoiceId: string): RenewalsDeps {
    return {
      ...deps,
      f4InvoicingBridge: {
        issueInvoiceForRenewal: async () => ({
          status: 'issued' as const,
          invoiceId,
          invoiceNumber: 'INV-2026-DOWNGRADE',
          totalSatang: asSatang(5_350_000n),
        }),
      },
    };
  }

  async function loadCycle(cycleId: string) {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          planId: renewalCycles.planIdAtCycleStart,
          tier: renewalCycles.tierAtCycleStart,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
    return rows[0]!;
  }

  async function loadMemberPlan(memberId: string) {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId, planYear: members.planYear })
        .from(members)
        .where(eq(members.memberId, memberId)),
    );
    return rows[0]!;
  }

  async function countAuditRows(): Promise<number> {
    // NOTE: audit_log's timestamp column is `timestamp`, NOT `created_at`.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    );
    return rows.length;
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
        annualFeeMinorUnits: REGULAR_FEE_MINOR,
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

  it('REFUSAL is a no-op: cycle stays upcoming, frozen plan + members.plan_id untouched, ZERO audit rows', async () => {
    const scenario = await seedMemberOnPremium();
    expect(await countAuditRows()).toBe(0);

    const deps = mockInvoicingBridge(makeRenewalsDeps(tenant.ctx.slug), scenario.invoiceId);
    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      memberId: scenario.memberId,
      newPlanId: 'regular', // cheaper than the frozen premium price
      actorUserId: admin.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('downgrade_not_acknowledged');
      if (result.error.kind === 'downgrade_not_acknowledged') {
        expect(result.error.currentPriceMinorUnits).toBe(PREMIUM_FEE_MINOR);
        expect(result.error.newPriceMinorUnits).toBe(REGULAR_FEE_MINOR);
        expect(result.error.currency).toBe('THB');
      }
    }

    // The gate sits above the first write — nothing moved.
    const cycle = await loadCycle(scenario.cycleId);
    expect(cycle.status, 'cycle status after refusal').toBe('upcoming');
    expect(cycle.planId, 'plan_id_at_cycle_start after refusal').toBe('premium');
    expect(cycle.frozenPrice, 'frozen price after refusal').toBe(PREMIUM_PRICE_THB);

    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id after refusal').toBe('premium');

    // `err()` inside runInTenant COMMITS earlier writes — zero rows proves
    // no lazy transition (and no `renewal_entered_awaiting_payment`) happened.
    expect(await countAuditRows(), 'audit rows written by a refusal').toBe(0);
  }, 120_000);

  it('ACKNOWLEDGED downgrade proceeds: cycle re-freezes to the cheap plan + members.plan_id follows + renewal_with_plan_change audited', async () => {
    const scenario = await seedMemberOnPremium();

    const deps = mockInvoicingBridge(makeRenewalsDeps(tenant.ctx.slug), scenario.invoiceId);
    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      memberId: scenario.memberId,
      newPlanId: 'regular',
      acknowledgeDowngrade: true,
      actorUserId: admin.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(
      result.ok,
      `confirmRenewal: ${JSON.stringify(result.ok ? null : result.error)}`,
    ).toBe(true);
    if (result.ok) expect(result.value.planChanged).toBe(true);

    const cycle = await loadCycle(scenario.cycleId);
    expect(cycle.planId, 'plan_id_at_cycle_start after ack').toBe('regular');
    expect(cycle.tier, 'tier after ack').toBe('regular');
    expect(cycle.frozenPrice, 'frozen price after ack').toBe(REGULAR_PRICE_THB);

    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id after ack').toBe('regular');

    // Filter the event type in JS, not SQL: the TS `audit_event_type` pgEnum
    // tuple drifts from the live DB enum (several F8 values exist in Postgres
    // but not the tuple), so `eq(auditLog.eventType, 'renewal_with_plan_change')`
    // fails typecheck even though the query is valid at runtime.
    const auditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug)),
    );
    const planChangeRows = auditRows.filter(
      (r) => (r.eventType as string) === 'renewal_with_plan_change',
    );
    expect(planChangeRows.length, 'renewal_with_plan_change audit rows').toBeGreaterThan(0);
  }, 120_000);
});
