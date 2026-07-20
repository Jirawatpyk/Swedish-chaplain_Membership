/**
 * Money-remediation Task 9 (F-9) — app-initiated refund recognition, live Neon.
 *
 * The unit suite proves the branching. This proves the two facts only a real
 * database can settle:
 *
 *   1. THE FALLBACK DID NOT STEAL FINALISATION. After recognition the row is
 *      STILL `pending`, with `processor_refund_id` back-filled and NO credit
 *      note. A.12/A.11 ownership stays with `charge.refund.updated` /
 *      `refund.updated`. A fallback that "helpfully" finalised here would book
 *      a §86/10 credit note off a `charge.refunded` event that carries no
 *      per-refund status — i.e. off no evidence that the money actually moved.
 *
 *   2. NO `out_of_band_refund_detected` ROW WAS WRITTEN. Absence is asserted
 *      against the real `audit_log` table, not a spy: that event carries
 *      10-year retention, so what matters is whether the ROW exists.
 *
 * Both are paired with a positive control in the same tenant, so a green
 * assertion cannot be produced by a broken fixture.
 *
 * Run in isolation (shared-Neon parallel suites flake cross-tenant probes):
 *   pnpm test:integration tests/integration/payments/f9-app-refund-recognition.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { processChargeRefunded } from '@/modules/payments/application/use-cases/process-charge-refunded';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { payments } from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const PAYMENT_AMOUNT = 5_350_000n;
const REFUND_AMOUNT = 100_000n;

function makeDeps(slug: string) {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(slug),
    refundsRepo: makeDrizzleRefundsRepo(slug),
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
    audit: f5AuditAdapter,
    clock: systemClock,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function refundRow(
  slug: string,
  refundId: string,
): Promise<{ status: string; processor_refund_id: string | null; credit_note_id: string | null } | undefined> {
  const rows = (await db.execute(sql`
    SELECT status, processor_refund_id, credit_note_id FROM refunds
    WHERE tenant_id = ${slug} AND id = ${refundId}
  `)) as unknown as Array<{
    status: string;
    processor_refund_id: string | null;
    credit_note_id: string | null;
  }>;
  return rows[0];
}

async function oobAuditCount(slug: string, processorRefundId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM audit_log
    WHERE tenant_id = ${slug}
      AND event_type = 'out_of_band_refund_detected'::audit_event_type
      AND payload->>'processor_refund_id' = ${processorRefundId}
  `)) as unknown as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

describe('F-9 app-refund recognition — live Neon', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let paymentId: PaymentId;
  let invoiceId: string;
  let paymentIntentId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const memberId = randomUUID();
    invoiceId = randomUUID();
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    paymentIntentId = `pi_test_${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'f9-plan',
        planYear: 2026,
        planName: { en: 'F9 Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'F9 Co',
        country: 'TH',
        planId: 'f9-plan',
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'f9-plan',
        draftByUserId: user.userId,
      });
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: PAYMENT_AMOUNT,
        currency: 'THB',
        processorPaymentIntentId: paymentIntentId,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date(),
        completedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-f9-pay',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** A pending refund in the exact state the defect strands: NULL processor id. */
  async function seedAwaitingRefund(): Promise<string> {
    const refundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await makeDrizzleRefundsRepo(tenant.ctx.slug).insert(tx, {
        id: refundId,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(REFUND_AMOUNT),
        reason: 'f9 awaiting attach',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-f9-refund',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });
    return refundId;
  }

  it('recognises + back-fills, leaves the row PENDING, writes no forensic', async () => {
    const refundId = await seedAwaitingRefund();
    const processorRefundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const result = await processChargeRefunded(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-f9-recognise',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      chargeId: `ch_${randomUUID().slice(0, 12)}`,
      refundIds: [processorRefundId],
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
      appRefundIds: { [processorRefundId]: refundId },
      paymentIntentId,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.invoiceId).toBe(invoiceId);

    const row = await refundRow(tenant.ctx.slug, refundId);
    // THE ASSERTION THIS FILE EXISTS FOR — the back-fill landed, and the row is
    // STILL pending. Settlement ownership was not stolen.
    expect(row?.processor_refund_id).toBe(processorRefundId);
    expect(row?.status).toBe('pending');
    expect(row?.credit_note_id).toBeNull();

    // And no 10-year forensic row was written.
    expect(await oobAuditCount(tenant.ctx.slug, processorRefundId)).toBe(0);
  });

  /**
   * POSITIVE CONTROL, same tenant + same code path. Without it, a green
   * assertion above could equally be produced by a use-case that silently does
   * nothing at all.
   */
  it('CONTROL: a markerless refund still writes the forensic row', async () => {
    const processorRefundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const result = await processChargeRefunded(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-f9-control',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      chargeId: `ch_${randomUUID().slice(0, 12)}`,
      refundIds: [processorRefundId],
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });

    expect(result.ok).toBe(true);
    expect(await oobAuditCount(tenant.ctx.slug, processorRefundId)).toBe(1);
  });

  /**
   * The forged-marker case, end-to-end: a well-formed marker naming a REAL row
   * in this tenant, delivered on an event for a DIFFERENT PaymentIntent. The
   * row must be untouched and the forensic must be written.
   */
  it('forged marker on a foreign PaymentIntent: no back-fill, forensic written', async () => {
    const refundId = await seedAwaitingRefund();
    const processorRefundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const result = await processChargeRefunded(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-f9-forged',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      chargeId: `ch_${randomUUID().slice(0, 12)}`,
      refundIds: [processorRefundId],
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
      appRefundIds: { [processorRefundId]: refundId },
      paymentIntentId: 'pi_not_the_parent_of_this_row',
    });

    expect(result.ok).toBe(true);

    const row = await refundRow(tenant.ctx.slug, refundId);
    expect(row?.processor_refund_id).toBeNull();
    expect(row?.status).toBe('pending');
    expect(await oobAuditCount(tenant.ctx.slug, processorRefundId)).toBe(1);
  });

  /**
   * The IS NULL predicate, end-to-end. Once a row carries a processor id it is
   * unreachable through the marker path, so a forged marker cannot re-point or
   * launder an already-matched refund.
   */
  it('already-attached row is unreachable by marker: forensic written', async () => {
    const refundId = await seedAwaitingRefund();
    const realProcessorRefundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await runInTenant(tenant.ctx, (tx) =>
      makeDrizzleRefundsRepo(tenant.ctx.slug).attachProcessorRefundId(tx, {
        refundId,
        tenantId: tenant.ctx.slug,
        processorRefundId: realProcessorRefundId,
      }),
    );

    // An attacker's refund, claiming the same app marker.
    const rogueProcessorRefundId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const result = await processChargeRefunded(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-f9-relabel',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      chargeId: `ch_${randomUUID().slice(0, 12)}`,
      refundIds: [rogueProcessorRefundId],
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
      appRefundIds: { [rogueProcessorRefundId]: refundId },
      paymentIntentId,
    });

    expect(result.ok).toBe(true);

    // The row still points at the REAL Stripe refund — not re-pointed.
    const row = await refundRow(tenant.ctx.slug, refundId);
    expect(row?.processor_refund_id).toBe(realProcessorRefundId);
    expect(await oobAuditCount(tenant.ctx.slug, rogueProcessorRefundId)).toBe(1);
  });
});
