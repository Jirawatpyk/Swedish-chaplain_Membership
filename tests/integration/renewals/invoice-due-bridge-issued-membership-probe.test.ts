/**
 * Step 2.5 (plan-change immediate re-freeze, Phase 2) — the tx-bound
 * issued-membership-invoice probe on `InvoiceDueBridge`.
 *
 * `hasIssuedMembershipInvoiceForMemberInTx(tx, tenantId, memberId)` runs on the
 * CALLER's tx (never its own `runInTenant`) so the plan-change refreeze can
 * consult it while holding change-plan's member FOR UPDATE lock without opening
 * a second pooled connection (deadlock-avoidance — see change-plan Phase-2
 * gotcha). It returns the FIRST `invoice_subject='membership'`,
 * `status='issued'` invoice id for the member, or null.
 *
 * Live Neon Singapore via .env.local (RLS-scoped by `runInTenant`).
 *
 * RED (pre-implementation): the method does not yet exist on the bridge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { makeInvoiceDueBridgeDrizzle } from '@/modules/renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void' | 'credited' | 'partially_credited';

describe('InvoiceDueBridge.hasIssuedMembershipInvoiceForMemberInTx (Step 2.5)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Probe Co ${memberId.slice(0, 6)}`,
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

  async function seedInvoice(
    memberId: string,
    status: InvoiceStatus,
  ): Promise<string> {
    const invoiceId = randomUUID();
    // Status-consistency CHECKs (migration 0019): a `paid` row needs
    // paid_at + payment_method; a `void` row needs voided_at + void_reason
    // + voided_by_user_id.
    const paidFields =
      status === 'paid'
        ? {
            paidAt: new Date('2026-06-01T00:00:00.000Z'),
            paymentMethod: 'stripe_card',
            receiptPdfStatus: 'rendered' as const,
          }
        : {};
    const voidFields =
      status === 'void'
        ? {
            voidedAt: new Date('2026-06-01T00:00:00.000Z'),
            voidReason: 'test void',
            voidedByUserId: admin.userId,
          }
        : {};
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
        invoiceSubject: 'membership',
        status,
        ...paidFields,
        ...voidFields,
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
          companyName: 'Probe Co',
          country: 'TH',
          legal_name: 'Probe Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Probe Person',
          primary_contact_email: 'probe@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    return invoiceId;
  }

  function probe(memberId: string): Promise<{ invoiceId: string } | null> {
    const bridge = makeInvoiceDueBridgeDrizzle(tenant.ctx);
    return runInTenant(tenant.ctx, (tx) =>
      bridge.hasIssuedMembershipInvoiceForMemberInTx(tx, tenant.ctx.slug, memberId),
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
        minTurnoverMinorUnits: 50_000_000,
        renewalTierBucket: 'regular',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
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
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('returns the invoice id for a member with an ISSUED membership invoice', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedInvoice(memberId, 'issued');

    const result = await probe(memberId);

    expect(result).not.toBeNull();
    expect(result?.invoiceId).toBe(invoiceId);
  });

  it('returns null when the member has only paid / draft / void membership invoices', async () => {
    const memberId = await seedMember();
    await seedInvoice(memberId, 'paid');
    await seedInvoice(memberId, 'draft');
    await seedInvoice(memberId, 'void');

    const result = await probe(memberId);

    expect(result).toBeNull();
  });

  it('returns null for a member with no invoices at all', async () => {
    const memberId = await seedMember();

    const result = await probe(memberId);

    expect(result).toBeNull();
  });
});
