/**
 * COMP-1 (Member Erasure) — H4 regression net for F8 auto-reactivation.
 *
 * Erasure forces `blocked_from_auto_reactivation = FALSE` (the H1 fix: the
 * 0094 CHECK forbids the flag staying TRUE once its provenance is scrubbed).
 * It also keeps `status` and stamps only `erased_at`. So WITHOUT an explicit
 * `erased_at IS NULL` guard, an erased member whose lapsed renewal cycle gets
 * its invoice paid would silently AUTO-REACTIVATE (cycle → completed) instead
 * of holding for admin review — reactivating a GDPR-anonymised tombstone.
 *
 * `markCycleCompleteInTx` (the F4 onPaidCallback target = the "picks a member
 * to auto-reactivate" decision) must treat an erased member as NOT
 * auto-reactivatable → route to `pending_admin_reactivation` so an admin sees
 * the anomaly, never `completed`.
 *
 * Live Neon. Mirrors the `self-service-renewal-tx.test.ts` triplet seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps, markCycleCompleteFromInvoicePaid } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

let memberNumberSeq = 0;
function nextMemberNumber(): number {
  memberNumberSeq += 1;
  return memberNumberSeq;
}

const F4_PAID_DEFAULTS: Pick<
  F4InvoicePaidEvent,
  'paidAt' | 'amountSatang' | 'vatSatang' | 'currency' | 'paymentMethod' | 'triggeredBy'
> = {
  paidAt: '2026-05-07T08:00:00Z',
  amountSatang: asSatang(5_000_000n),
  vatSatang: asSatang(350_000n),
  currency: 'THB',
  paymentMethod: 'stripe_card',
  triggeredBy: 'webhook',
};

describe('F8 auto-reactivation excludes erased members (COMP-1 H4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planTextId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planTextId = `f8-erased-react-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planTextId,
        planName: { en: 'Erased React Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /** Seed (erased member, F4 draft invoice, awaiting_payment cycle). */
  async function seedErasedTriplet(): Promise<{
    memberId: string;
    cycleId: string;
    invoiceId: string;
  }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextMemberNumber(),
        companyName: '[erased]',
        country: 'TH',
        planId: planTextId,
        planYear: 2026,
        // Post-erasure state: status kept, block flag FALSE, erased_at set.
        blockedFromAutoReactivation: false,
        erasedAt: new Date(),
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planTextId,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
    });
    return { memberId, cycleId, invoiceId };
  }

  it('an erased member is NOT auto-reactivated on invoice-paid (holds for admin, not completed)', async () => {
    const { memberId, cycleId, invoiceId } = await seedErasedTriplet();
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
    };

    const r = await markCycleCompleteFromInvoicePaid(deps, event);
    // The erased member must NOT be auto-completed/auto-reactivated.
    expect(r.kind).not.toBe('completed');
    expect(r.kind).toBe('held_pending_admin');

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('pending_admin_reactivation');
  });
});
