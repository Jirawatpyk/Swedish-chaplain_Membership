/**
 * A.14 — Stripe-aware stale-pending-refund sweep, live Neon integration.
 *
 * Replaces the T130a blind-fail integration test. Seeds stale `pending`
 * refunds and drives the sweep with a FAKE processorGateway (keyed by
 * `re_…` id) so we control the Stripe outcome, while every DB write
 * (refund flip, payment flip, credit-note FK, audit rows) runs against
 * real Postgres. Asserts the live-DB behaviours mocks cannot verify:
 *
 *   - `succeeded` → refund row flips `succeeded` (+ `credit_note_id`), the
 *     parent payment flips `partially_refunded`, and a `refund_succeeded`
 *     audit with `payload.path='sweep_recovery'` is written.
 *   - `failed`    → refund row flips `failed` with
 *     `failure_reason_code='stripe_refund_failed'` + a `refund_failed` audit.
 *   - `pending`   → refund row STAYS `pending` (never marked failed).
 *   - null `processor_refund_id` (aged) → STAYS `pending` (never blind-failed),
 *     counted as escalated.
 *   - fresh (< 24h `olderThanHours` cutoff) → NOT picked up by
 *     `listPendingOlderThan`'s `initiatedAt < cutoff` clause at all: no
 *     retrieve, no finalize, status untouched. Regression guard for the
 *     cutoff WHERE clause (review-hardening — the old T130a integration test
 *     asserted this; restored here since every other seeded row in this file
 *     is deliberately stale).
 *   - NO `stale_pending_refund_detected` audit for ANY row (blind-fail removed).
 *   - Idempotent: a second run sweeps 0.
 *   - RR-1: a row finalised by a concurrent writer between the list-read and
 *     the per-row lock is SKIPPED under the lock re-check — the sweep does
 *     NOT emit a second `refund_succeeded` and does NOT clobber the state.
 *
 * Mocking policy: live Postgres for refundsRepo + paymentsRepo + audit.
 * The Stripe gateway is FAKE (no SDK) and the F4 CN bridge is stubbed to a
 * pre-seeded placeholder credit-note row (FK-safe) — the F4 issuance chain
 * has its own dedicated coverage.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { ok, err } from '@/lib/result';
import { sweepStalePendingRefunds } from '@/modules/payments';
import type { SweepStalePendingRefundsDeps } from '@/modules/payments';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

const HOUR_MS = 60 * 60 * 1000;
const STALE_INITIATED = new Date(Date.now() - 30 * HOUR_MS);
const AGED_INITIATED = new Date(Date.now() - 100 * HOUR_MS); // > 3d escalation age
const PAYMENT_AMOUNT = 5_350_000n;

describe('sweepStalePendingRefunds — Stripe-aware, live Neon (A.14)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;
  // Single active payment per invoice (payments_one_active_per_invoice). All
  // five seeded refunds hang off this one payment; only the succeeded one
  // flips its status (failed/pending/null-id/fresh never touch payment status).
  let paymentSucc: PaymentId;

  // Refund ids
  const rfndSucc = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const rfndFail = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const rfndPend = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const rfndNull = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  // Fresh (< 24h) regression row — MUST stay outside the cutoff (see class
  // doc comment "fresh" bullet). No mapping in `fakeGateway` on purpose: if
  // the cutoff clause ever regressed and let this row through, `retrieveRefund`
  // would be called with an unmapped id and the test would fail loudly.
  const rfndFresh = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const reSucc = `re_succ_${randomUUID().slice(0, 8)}`;
  const reFail = `re_fail_${randomUUID().slice(0, 8)}`;
  const rePend = `re_pend_${randomUUID().slice(0, 8)}`;
  const reFresh = `re_fresh_${randomUUID().slice(0, 8)}`;

  let succCnId: string; // pre-seeded placeholder credit note for the succeeded path

  function stubSettings(slug: string): SweepStalePendingRefundsDeps['tenantSettingsRepo'] {
    // The real settings repo wraps reads in Next.js `unstable_cache`, which
    // throws outside a request context — stub it (same as refund-multi-partial).
    return {
      async getByTenantId() {
        return {
          tenantId: slug,
          processor: 'stripe' as const,
          processorEnvironment: 'test' as const,
          processorAccountId: `acct_test_${slug.slice(-8)}`,
          processorPublishableKey: `pk_test_${slug.slice(-8)}`,
          enabledMethods: ['card', 'promptpay'] as const,
          onlinePaymentEnabled: true,
          autoEmailOnPayment: true,
          promptpayQrExpirySeconds: 900,
          allowAnonymousPaylink: false,
        };
      },
      async findByProcessorAccountId() {
        return null;
      },
    } as unknown as SweepStalePendingRefundsDeps['tenantSettingsRepo'];
  }

  function fakeGateway(
    statusByRe: Readonly<Record<string, string>>,
  ): SweepStalePendingRefundsDeps['processorGateway'] {
    return {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(),
      retrieveRefund: vi.fn(async (refundId: string) => {
        const status = statusByRe[refundId];
        if (status === undefined) {
          return err({
            kind: 'permanent' as const,
            code: 'resource_missing',
            reason: 'no such refund',
          });
        }
        return ok({
          id: refundId,
          status,
          chargeId: 'ch_x',
          paymentIntentId: 'pi_x',
          amountSatang: asSatang(0n),
        });
      }),
    } as unknown as SweepStalePendingRefundsDeps['processorGateway'];
  }

  function stubBridge(
    cnId: string,
  ): SweepStalePendingRefundsDeps['invoicingBridge'] {
    return {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({ creditNoteId: cnId, creditNoteNumber: 'TC-2026-SWEEP1' }),
      ),
      // tax#5 (B.2) — the shared finaliser reads the F4-authoritative invoice
      // status on the succeeded path. The sweep outcome does not surface it, so
      // the value is inert here; must be present or the real finaliser throws.
      getInvoiceStatus: vi.fn(async () => ok('credited' as const)),
    } as unknown as SweepStalePendingRefundsDeps['invoicingBridge'];
  }

  async function seedPlaceholderCN(targetInvoiceId: string): Promise<string> {
    const cnId = randomUUID();
    const seq = Math.floor(Math.random() * 1_000_000);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO credit_notes (
          tenant_id, credit_note_id, original_invoice_id,
          fiscal_year, sequence_number, document_number,
          issue_date, issued_by_user_id, reason,
          credit_amount_satang, vat_satang, total_satang,
          tenant_identity_snapshot, member_identity_snapshot,
          pdf_blob_key, pdf_sha256, pdf_template_version,
          created_at, updated_at
        ) VALUES (
          ${tenant.ctx.slug}, ${cnId}, ${targetInvoiceId},
          2026, ${seq}, ${`TC-2026-${String(seq).padStart(6, '0')}`},
          '2026-04-15', ${user.userId}, 'sweep-stripe-aware test',
          1, 0, 1,
          '{}'::jsonb, '{}'::jsonb,
          'placeholder', ${'a'.repeat(64)}, 1,
          NOW(), NOW()
        )
      `);
    });
    return cnId;
  }

  async function seedPayment(id: PaymentId, invId: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id,
        tenantId: tenant.ctx.slug,
        invoiceId: invId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: asSatang(PAYMENT_AMOUNT),
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
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
        correlationId: `corr-${id}`,
      });
    });
  }

  async function refundStatusFields(
    refundId: string,
  ): Promise<{ status: string; failure_reason_code: string | null; credit_note_id: string | null }> {
    const rows = (await db.execute(sql`
      SELECT status, failure_reason_code, credit_note_id
      FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND id = ${refundId}
    `)) as unknown as Array<{
      status: string;
      failure_reason_code: string | null;
      credit_note_id: string | null;
    }>;
    return (
      rows[0] ?? { status: 'MISSING', failure_reason_code: null, credit_note_id: null }
    );
  }

  async function paymentStatus(id: PaymentId): Promise<string> {
    const [row] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, id)));
    return row?.status ?? 'MISSING';
  }

  async function auditCount(
    eventType: string,
    refundId: string,
    path?: string,
  ): Promise<number> {
    const pathClause = path
      ? sql` AND payload->>'path' = ${path}`
      : sql``;
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = ${eventType}::audit_event_type
        AND payload->>'refund_id' = ${refundId}${pathClause}
    `)) as unknown as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    invoiceId = randomUUID();
    paymentSucc = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);

    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'sweep-plan',
        planYear: 2026,
        planName: { en: 'Sweep Plan' },
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
        companyName: 'Sweep Co',
        country: 'TH',
        planId: 'sweep-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T',
        creditNoteNumberPrefix: 'TC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'sweep-plan',
        draftByUserId: user.userId,
      });
    });

    await seedPayment(paymentSucc, invoiceId);
    succCnId = await seedPlaceholderCN(invoiceId);

    // Seed 4 stale pending refunds.
    const repo = makeDrizzleRefundsRepo(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      await repo.insert(tx, {
        id: rfndSucc,
        tenantId: tenant.ctx.slug,
        paymentId: paymentSucc,
        invoiceId,
        amountSatang: asSatang(100_000n),
        reason: 'stale succeeded',
        status: 'pending',
        processorRefundId: reSucc,
        initiatorUserId: user.userId,
        correlationId: 'corr-succ',
        initiatedAt: STALE_INITIATED,
      });
      await repo.insert(tx, {
        id: rfndFail,
        tenantId: tenant.ctx.slug,
        paymentId: paymentSucc,
        invoiceId,
        amountSatang: asSatang(200_000n),
        reason: 'stale failed',
        status: 'pending',
        processorRefundId: reFail,
        initiatorUserId: user.userId,
        correlationId: 'corr-fail',
        initiatedAt: STALE_INITIATED,
      });
      await repo.insert(tx, {
        id: rfndPend,
        tenantId: tenant.ctx.slug,
        paymentId: paymentSucc,
        invoiceId,
        amountSatang: asSatang(50_000n),
        reason: 'stale still-pending',
        status: 'pending',
        processorRefundId: rePend,
        initiatorUserId: user.userId,
        correlationId: 'corr-pend',
        initiatedAt: STALE_INITIATED,
      });
      await repo.insert(tx, {
        id: rfndNull,
        tenantId: tenant.ctx.slug,
        paymentId: paymentSucc,
        invoiceId,
        amountSatang: asSatang(60_000n),
        reason: 'stale null-id aged',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-null',
        initiatedAt: AGED_INITIATED,
      });
      // Fresh row (initiated now, well within the default 24h cutoff) — MUST
      // be excluded by `listPendingOlderThan`'s `initiatedAt < cutoff`
      // clause. Regression guard restored from the deleted T130a test.
      await repo.insert(tx, {
        id: rfndFresh,
        tenantId: tenant.ctx.slug,
        paymentId: paymentSucc,
        invoiceId,
        amountSatang: asSatang(70_000n),
        reason: 'fresh — must NOT be swept',
        status: 'pending',
        processorRefundId: reFresh,
        initiatorUserId: user.userId,
        correlationId: 'corr-fresh',
        initiatedAt: new Date(),
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  it('reconciles each stale pending refund by its real Stripe status; never blind-fails', async () => {
    const deps: SweepStalePendingRefundsDeps = {
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      tenantSettingsRepo: stubSettings(tenant.ctx.slug),
      processorGateway: fakeGateway({
        [reSucc]: 'succeeded',
        [reFail]: 'failed',
        [rePend]: 'pending',
      }),
      invoicingBridge: stubBridge(succCnId),
      audit: f5AuditAdapter,
      clock: systemClock,
    };

    const result = await sweepStalePendingRefunds(deps, {
      tenantId: tenant.ctx.slug,
      requestId: 'req-sweep-stripe-aware',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sweptCount).toBe(2); // succeeded + failed
      expect(result.value.skippedCount).toBe(2); // pending + null-id
      expect(result.value.escalatedCount).toBe(1); // null-id aged 100h
    }

    // succeeded → refund succeeded + CN + payment partially_refunded.
    const succ = await refundStatusFields(rfndSucc);
    expect(succ.status).toBe('succeeded');
    expect(succ.credit_note_id).toBe(succCnId);
    expect(await paymentStatus(paymentSucc)).toBe('partially_refunded');
    expect(await auditCount('refund_succeeded', rfndSucc, 'sweep_recovery')).toBe(1);

    // failed → refund failed with the Stripe reason code.
    const fail = await refundStatusFields(rfndFail);
    expect(fail.status).toBe('failed');
    expect(fail.failure_reason_code).toBe('stripe_refund_failed');
    expect(await auditCount('refund_failed', rfndFail)).toBe(1);

    // pending → untouched (NEVER marked failed).
    expect((await refundStatusFields(rfndPend)).status).toBe('pending');

    // null-id aged → untouched (NEVER blind-failed).
    expect((await refundStatusFields(rfndNull)).status).toBe('pending');

    // Fresh (< 24h cutoff) → NOT picked up at all: status untouched, no
    // Stripe retrieve, no finalize. Regression guard for the
    // `initiatedAt < cutoff` WHERE clause (restored from the deleted T130a
    // test — every OTHER seeded row in this file is deliberately stale, so
    // without this row the cutoff clause had no coverage).
    expect((await refundStatusFields(rfndFresh)).status).toBe('pending');
    expect(vi.mocked(deps.processorGateway.retrieveRefund)).not.toHaveBeenCalledWith(
      reFresh,
      expect.anything(),
    );
    expect(
      vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund),
    ).not.toHaveBeenCalledWith(expect.objectContaining({ refundId: rfndFresh }));

    // Blind-fail is gone: NO stale_pending_refund_detected for ANY row.
    for (const id of [rfndSucc, rfndFail, rfndPend, rfndNull, rfndFresh]) {
      expect(await auditCount('stale_pending_refund_detected', id)).toBe(0);
    }
  }, 60_000);

  it('idempotent — a second run sweeps 0 (terminal rows gone; pending/null re-skipped)', async () => {
    const deps: SweepStalePendingRefundsDeps = {
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      tenantSettingsRepo: stubSettings(tenant.ctx.slug),
      processorGateway: fakeGateway({ [rePend]: 'pending' }),
      invoicingBridge: stubBridge(succCnId),
      audit: f5AuditAdapter,
      clock: systemClock,
    };

    const result = await sweepStalePendingRefunds(deps, {
      tenantId: tenant.ctx.slug,
      requestId: 'req-sweep-stripe-aware-2',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sweptCount).toBe(0);
      // pending (re-skipped) + null-id (re-skipped + re-escalated)
      expect(result.value.skippedCount).toBe(2);
      expect(result.value.escalatedCount).toBe(1);
    }
    // succeeded/failed rows keep their terminal state.
    expect((await refundStatusFields(rfndSucc)).status).toBe('succeeded');
    expect((await refundStatusFields(rfndFail)).status).toBe('failed');
  }, 60_000);

  it('RR-1 — a row finalised concurrently between list-read and lock is skipped (no false audit, no clobber)', async () => {
    // Fresh payment + pending refund + placeholder CN.
    const racePaymentId = asPaymentId(
      `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    );
    const raceInvoiceId = randomUUID();
    const raceRefundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const raceRe = `re_race_${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: raceInvoiceId,
        memberId,
        planYear: 2026,
        planId: 'sweep-plan',
        draftByUserId: user.userId,
      });
    });
    await seedPayment(racePaymentId, raceInvoiceId);
    const raceCnId = await seedPlaceholderCN(raceInvoiceId);

    const realRepo = makeDrizzleRefundsRepo(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      await realRepo.insert(tx, {
        id: raceRefundId,
        tenantId: tenant.ctx.slug,
        paymentId: racePaymentId,
        invoiceId: raceInvoiceId,
        amountSatang: asSatang(120_000n),
        reason: 'raced 30h',
        status: 'pending',
        processorRefundId: raceRe,
        initiatorUserId: user.userId,
        correlationId: 'corr-raced',
        initiatedAt: STALE_INITIATED,
      });
    });

    // Racing wrapper: after the sweep's list-read returns the pending row, a
    // concurrent writer finalises it to 'succeeded' in a SEPARATE committed
    // tx — BEFORE the sweep's per-row lock. Reproduces the delayed-webhook /
    // Phase-B race the under-lock re-check defends against.
    let flipped = false;
    const racingRepo = {
      ...realRepo,
      listPendingOlderThan: async (tx: unknown, tid: string, cutoff: Date) => {
        const rows = await realRepo.listPendingOlderThan(tx, tid, cutoff);
        if (!flipped) {
          flipped = true;
          await runInTenant(tenant.ctx, async (tx2) => {
            await realRepo.updateStatus(tx2, {
              refundId: raceRefundId,
              tenantId: tenant.ctx.slug,
              nextStatus: 'succeeded',
              processorRefundId: raceRe,
              creditNoteId: raceCnId,
              completedAt: new Date(),
            });
          });
        }
        // Only surface the raced refund so the assertions are deterministic.
        return rows.filter((r) => r.id === raceRefundId);
      },
    } as unknown as SweepStalePendingRefundsDeps['refundsRepo'];

    const deps: SweepStalePendingRefundsDeps = {
      refundsRepo: racingRepo,
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      tenantSettingsRepo: stubSettings(tenant.ctx.slug),
      processorGateway: fakeGateway({ [raceRe]: 'succeeded' }),
      invoicingBridge: stubBridge(raceCnId),
      audit: f5AuditAdapter,
      clock: systemClock,
    };

    const result = await sweepStalePendingRefunds(deps, {
      tenantId: tenant.ctx.slug,
      requestId: 'req-sweep-race',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sweptCount).toBe(0);
      expect(result.value.skippedCount).toBe(1);
    }
    // The sweep did NOT emit a sweep_recovery audit for the raced row (the
    // concurrent writer already owns the terminal state).
    expect(
      await auditCount('refund_succeeded', raceRefundId, 'sweep_recovery'),
    ).toBe(0);
    // The concurrently-set terminal state is intact (not clobbered).
    expect((await refundStatusFields(raceRefundId)).status).toBe('succeeded');
  }, 60_000);
});
