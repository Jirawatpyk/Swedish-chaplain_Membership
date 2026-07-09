/**
 * 070 — `findMostRecentForMember` integration. Live Neon.
 *
 * The post-payment `/portal/renewal/[memberId]/success` page must display the
 * member's just-COMPLETED cycle ("Renewal complete"). `findActiveForMember`
 * excludes completed (per the L135 active invariant), so while the page used
 * it the `status === 'completed'` status row was UNREACHABLE — the page could
 * never confirm completion. `findMostRecentForMember` includes a completed
 * cycle (excludes only lapsed/cancelled) and orders by newest `period_from`.
 *
 * This test pins the two load-bearing facts:
 *   1. With a completed cycle + an older lapsed cycle, the method returns the
 *      COMPLETED one (includes completed, excludes lapsed, newest period_from
 *      wins) — and `findActiveForMember` returns null for the same member,
 *      documenting exactly the gap this method fills for the success page.
 *   2. It still excludes lapsed/cancelled: a member whose only cycle is lapsed
 *      resolves to null (→ the success page's async-processing branch).
 *
 * Constitution Principle II (every behaviour has a test) + Principle I (RLS
 * via runInTenant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { asSatang } from '@/lib/money';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('findMostRecentForMember — integration (070)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Recent Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  /** An `issued` invoice to satisfy the completed-cycle FK + CHECK. */
  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
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
          companyName: 'Recent Co',
          country: 'TH',
          legal_name: 'Recent Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'recent@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  async function seedTerminalCycle(args: {
    memberId: string;
    status: 'completed' | 'lapsed';
    periodFromDaysAgo: number;
    linkedInvoiceId?: string;
  }): Promise<string> {
    const cycleId = randomUUID();
    const periodFrom = new Date(Date.now() - args.periodFromDaysAgo * MS_PER_DAY);
    const periodTo = new Date(periodFrom.getTime() + 365 * MS_PER_DAY);
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId: args.memberId,
        status: args.status,
        periodFrom,
        periodTo,
        expiresAt: periodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date(),
        closedReason: args.status === 'completed' ? 'paid' : 'lapsed',
        ...(args.linkedInvoiceId
          ? { linkedInvoiceId: args.linkedInvoiceId }
          : {}),
      }),
    );
    return cycleId;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-recent-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Recent Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('returns the COMPLETED cycle (includes completed, excludes the older lapsed); findActiveForMember returns null for the same member', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);
    // A just-completed cycle (recent) + an older lapsed one.
    const completedCycleId = await seedTerminalCycle({
      memberId,
      status: 'completed',
      periodFromDaysAgo: 100,
      linkedInvoiceId: invoiceId,
    });
    await seedTerminalCycle({
      memberId,
      status: 'lapsed',
      periodFromDaysAgo: 500,
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const recent = await deps.cyclesRepo.findMostRecentForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(recent).not.toBeNull();
    expect(recent?.cycleId).toBe(completedCycleId);
    expect(recent?.status).toBe('completed');

    // The gap this method fills: findActiveForMember EXCLUDES completed, so the
    // success page (using it) could never show the completed status row.
    const active = await deps.cyclesRepo.findActiveForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(active).toBeNull();
  });

  it('excludes lapsed/cancelled — a member whose only cycle is lapsed resolves to null', async () => {
    const memberId = await seedMember();
    await seedTerminalCycle({
      memberId,
      status: 'lapsed',
      periodFromDaysAgo: 200,
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const recent = await deps.cyclesRepo.findMostRecentForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(recent).toBeNull();
  });
});
