/**
 * T102 — Refund use-case integration on live Neon (F5 / FR-011b + US4).
 *
 * Exercises the FULL `issueRefund` orchestration against real Postgres
 * with the following scenarios per spec § 3 / FR-011b:
 *
 *   1. **Multi-partial accumulation** — 2 partial refunds summing < total
 *      → payment.status='partially_refunded'; cumulative sum tracked.
 *   2. **Pre-flight rejection (FR-011b)** — 3rd refund exceeds remaining
 *      → IssueRefundError 'refund_exceeds_remaining' BEFORE Stripe call.
 *   3. **Exhausting refund** — 4th refund makes cumulative === payment.amount
 *      → payment.status='refunded' (terminal).
 *   4. **Concurrent race** — Promise.all() of two issueRefund calls
 *      against the same payment → exactly one wins, other gets
 *      'refund_in_progress' (FOR UPDATE serialisation + countPending
 *      gate inside the lock).
 *
 * Mocking policy: live Postgres for paymentsRepo + refundsRepo +
 * tenantSettingsRepo + audit (so the FOR UPDATE locking, partial unique
 * index, CHECK constraints, and cumulative-sum aggregation are real).
 * `processorGateway` and `invoicingBridge` are stubbed so the test does
 * not hit Stripe SDK / F4 PDF chain — those paths are covered by
 * dedicated unit tests + the F4-bridge integration test.
 *
 * F4 invoice-status assertions (`partially_credited` / `credited`) are
 * NOT made here because the F5 invariant "payment.amount === invoice
 * .total under one-PI-per-invoice" makes the F5 derivation
 * (`isFullyRefunded ? 'credited' : 'partially_credited'`) deterministic
 * — the value is asserted in the use-case unit test and propagates to
 * the success envelope unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { issueRefund } from '@/modules/payments';
import { ok } from '@/lib/result';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
// Note: NOT importing `makeDrizzleTenantPaymentSettingsRepo` —
// it wraps reads in Next.js `unstable_cache` which throws
// `Invariant: incrementalCache missing` outside a request context.
// We stub it inline below with a plain object that returns the
// settings row we seeded.
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
import type {
  IssueRefundDeps,
  IssueRefundError,
  IssueRefundSuccess,
} from '@/modules/payments';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import type { Result } from '@/lib/result';

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

const TOTAL_SATANG = 5_350_000n; // THB 53,500.00 — three partial slices fit

/**
 * Build deps with real Drizzle repos but stubbed external systems.
 *
 * `processorGateway.createRefund` returns a fresh synthetic Stripe
 * refund id per call so the partial-UNIQUE constraint on
 * `refunds.processor_refund_id` is honoured across the multi-partial
 * sequence. `invoicingBridge.issueCreditNoteFromRefund` returns a
 * fresh synthetic CN id + number per call so the CHECK constraint
 * `refunds_succeeded_iff_complete` (status='succeeded' iff both ids
 * non-null) holds on every successful row.
 */
function buildHybridDeps(tenantId: string): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    // Stub — see import-site comment above. The real repo wraps reads
    // in Next.js `unstable_cache` which throws outside a request
    // context. The settings row was seeded in beforeAll; return it
    // verbatim.
    tenantSettingsRepo: {
      async getByTenantId() {
        return {
          tenantId,
          processor: 'stripe' as const,
          processorEnvironment: 'test' as const,
          processorAccountId: `acct_test_${tenantId.slice(-8)}`,
          processorPublishableKey: `pk_test_${tenantId.slice(-8)}`,
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
    },
    processorGateway: {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(async () =>
        ok({
          id: `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: 'succeeded',
          amountSatang: asSatang(0n),
        }),
      ),
    },
    invoicingBridge: {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({
          // F4 credit_notes.credit_note_id is uuid; satisfy the
          // refunds.credit_note_id FK with a fresh uuid each call.
          // The FK target row does not need to exist for THIS test
          // because we never actually insert into credit_notes (F4
          // chain mocked); the FK is DEFERRABLE / not validated at
          // INSERT time? Actually it IS validated — the cleanest
          // path is to insert a stub credit_notes row for each
          // mocked CN id, but for this F5-only integration we
          // accept the FK violation by NOT testing the FK; instead
          // we mock the bridge AND the refunds.update_status call
          // bypasses the FK by writing a NULL credit_note_id.
          //
          // Actually the simpler route: drop the credit_note_id
          // assertion from this test and let the use-case write
          // null (CHECK then fails — succeeded must have CN id).
          //
          // The PRAGMATIC approach used here: the bridge mock
          // returns a synthetic CN id but the test SETUP also
          // pre-seeds a placeholder credit_notes row per refund so
          // the FK passes. See `seedPlaceholderCN` below.
          creditNoteId: '__will_be_replaced__',
          creditNoteNumber: 'TC-2026-000001',
        }),
      ),
    },
    audit: f5AuditAdapter,
    clock: systemClock,
    generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    idempotencyKeyFactory: (k) => k,
  };
}

describe('issueRefund — multi-partial + race (T102)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;
  let paymentId: PaymentId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    invoiceId = randomUUID();

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
        planId: 'rfnd-mp-plan',
        planYear: 2026,
        planName: { en: 'Refund Multi-Partial Plan' },
        description: { en: '' },
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
        companyName: 'Refund MP Co',
        country: 'TH',
        planId: 'rfnd-mp-plan',
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
        planId: 'rfnd-mp-plan',
        draftByUserId: user.userId,
      });
    });

    // Seed a SUCCEEDED F5 payment (the refund target). Insert directly
    // via Drizzle in tenant-scoped tx — the Drizzle repo's `insert`
    // method only supports pending rows; we need succeeded.
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    const now = new Date();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: TOTAL_SATANG,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: now,
        completedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-pay-rfnd-mp',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /**
   * Pre-seed a placeholder credit_notes row that the bridge mock can
   * point its returned `creditNoteId` at, satisfying the
   * `refunds.credit_note_id` FK constraint. Returns the fresh CN id.
   * The placeholder row carries minimal valid values; the actual F4
   * issuance flow is mocked so its content is never read.
   */
  async function seedPlaceholderCN(): Promise<string> {
    const ids = await seedPlaceholderCNs(1, invoiceId);
    return ids[0]!;
  }

  /**
   * Batch variant — seeds N placeholder credit_notes rows in ONE
   * INSERT…VALUES. Drops 2 roundtrips per multi-partial test (R001
   * polish, prior staff review).
   */
  async function seedPlaceholderCNs(
    count: number,
    targetInvoiceId: string,
  ): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    const pdfSha = 'a'.repeat(64);
    await runInTenant(tenant.ctx, async (tx) => {
      // F4 credit_notes table seed — parameterised per row via
      // Drizzle's `sql.join` so a single round-trip covers all
      // placeholder rows. Test fixture (F4 issuance chain mocked).
      const valueRows = ids.map((cnId) => {
        const seq = Math.floor(Math.random() * 1_000_000);
        const docNumber = `TC-2026-${String(seq).padStart(6, '0')}`;
        return sql`(
          ${tenant.ctx.slug},
          ${cnId},
          ${targetInvoiceId},
          2026, ${seq},
          ${docNumber},
          '2026-04-15', ${user.userId}, 'integration test',
          1, 0, 1,
          '{}'::jsonb, '{}'::jsonb,
          'placeholder', ${pdfSha}, 1,
          NOW(), NOW()
        )`;
      });
      await tx.execute(sql`
        INSERT INTO credit_notes (
          tenant_id, credit_note_id, original_invoice_id,
          fiscal_year, sequence_number, document_number,
          issue_date, issued_by_user_id, reason,
          credit_amount_satang, vat_satang, total_satang,
          tenant_identity_snapshot, member_identity_snapshot,
          pdf_blob_key, pdf_sha256, pdf_template_version,
          created_at, updated_at
        ) VALUES ${sql.join(valueRows, sql`, `)}
      `);
    });
    return ids;
  }

  /**
   * Bind the bridge mock to return a freshly-seeded placeholder CN id
   * + a fresh CN number. Each scenario call (re)wires this so the
   * sequence ids stay unique.
   */
  function rebindBridgeForNextRefund(deps: IssueRefundDeps, cnId: string, cnNumber: string) {
    deps.invoicingBridge.issueCreditNoteFromRefund = vi.fn(async () =>
      ok({ creditNoteId: cnId, creditNoteNumber: cnNumber }),
    );
  }

  async function readPaymentStatus(): Promise<string> {
    const [row] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(
        and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)),
      );
    return row?.status ?? '';
  }

  async function countSucceededRefunds(): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM refunds
        WHERE tenant_id = ${tenant.ctx.slug}
          AND payment_id = ${paymentId}
          AND status = 'succeeded'
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  it('multi-partial accumulation: 2 partials → partially_refunded; 3rd > remaining → rejected; 4th exhausts → refunded', async () => {
    const deps = buildHybridDeps(tenant.ctx.slug);

    // R001 polish: pre-seed all 3 placeholder CNs in ONE INSERT
    // instead of 3 sequential roundtrips per refund step.
    const cnIds = await seedPlaceholderCNs(3, invoiceId);

    // ---- Partial #1 — 1,000,000 satang (THB 10,000) ----
    rebindBridgeForNextRefund(deps, cnIds[0]!, 'TC-2026-100001');
    const r1 = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(1_000_000n),
      reason: 'first partial',
      actorUserId: user.userId,
      correlationId: 'corr-r1',
      requestId: 'req-r1',
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.payment.status).toBe('partially_refunded');
      expect(r1.value.payment.refundedAmountSatang).toBe(1_000_000n);
      expect(r1.value.payment.remainingRefundableSatang).toBe(4_350_000n);
      expect(r1.value.invoice.status).toBe('partially_credited');
    }
    expect(await readPaymentStatus()).toBe('partially_refunded');

    // ---- Partial #2 — 1,500,000 satang (cumulative = 2,500,000) ----
    rebindBridgeForNextRefund(deps, cnIds[1]!, 'TC-2026-100002');
    const r2 = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(1_500_000n),
      reason: 'second partial',
      actorUserId: user.userId,
      correlationId: 'corr-r2',
      requestId: 'req-r2',
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.payment.status).toBe('partially_refunded');
      expect(r2.value.payment.refundedAmountSatang).toBe(2_500_000n);
      expect(r2.value.payment.remainingRefundableSatang).toBe(2_850_000n);
    }
    expect(await countSucceededRefunds()).toBe(2);

    // ---- Pre-flight rejection (FR-011b) — 3rd refund 3M > remaining 2.85M ----
    const r3: Result<IssueRefundSuccess, IssueRefundError> = await issueRefund(
      deps,
      {
        tenantId: tenant.ctx.slug,
        paymentId,
        amountSatang: asSatang(3_000_000n),
        reason: 'over-limit attempt',
        actorUserId: user.userId,
        correlationId: 'corr-r3',
        requestId: 'req-r3',
      },
    );
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('refund_exceeds_remaining');
      if (r3.error.code === 'refund_exceeds_remaining') {
        expect(r3.error.requestedSatang).toBe(3_000_000n);
        expect(r3.error.remainingSatang).toBe(2_850_000n);
      }
    }
    // Pre-flight: NO Stripe call, NO refund row inserted, NO state change.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(2); // only #1+#2 reached Stripe
    expect(await readPaymentStatus()).toBe('partially_refunded');
    expect(await countSucceededRefunds()).toBe(2);

    // ---- Exhausting refund — 2,850,000 satang → cumulative = TOTAL → 'refunded' ----
    rebindBridgeForNextRefund(deps, cnIds[2]!, 'TC-2026-100003');
    const r4 = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(2_850_000n),
      reason: 'final exhausting partial',
      actorUserId: user.userId,
      correlationId: 'corr-r4',
      requestId: 'req-r4',
    });
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.value.payment.status).toBe('refunded');
      expect(r4.value.payment.refundedAmountSatang).toBe(TOTAL_SATANG);
      expect(r4.value.payment.remainingRefundableSatang).toBe(0n);
      expect(r4.value.invoice.status).toBe('credited');
    }
    expect(await readPaymentStatus()).toBe('refunded');
    expect(await countSucceededRefunds()).toBe(3);
  }, 60_000);

  it('concurrent race: Promise.all on same payment — exactly one wins, other rejects with refund_in_progress', async () => {
    // Fresh succeeded payment for an isolated test — the prior test's
    // payment is now in `refunded` terminal state.
    const racePaymentId = asPaymentId(
      `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    );
    const raceInvoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: raceInvoiceId,
        memberId,
        planYear: 2026,
        planId: 'rfnd-mp-plan',
        draftByUserId: user.userId,
      });
      await tx.insert(payments).values({
        id: racePaymentId,
        tenantId: tenant.ctx.slug,
        invoiceId: raceInvoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: TOTAL_SATANG,
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
        correlationId: 'corr-pay-race',
      });
    });

    const deps = buildHybridDeps(tenant.ctx.slug);
    rebindBridgeForNextRefund(deps, await seedPlaceholderCN(), 'TC-2026-200001');

    // Two concurrent refund requests against the same payment. The
    // Phase-A `paymentsRepo.withTx` opens a serialisable tx + takes
    // `SELECT … FOR UPDATE` on payments(id). Postgres serialises the
    // two locks: the first inserts the pending refund row + commits;
    // the second sees `pendingCount > 0` and returns
    // `refund_in_progress` (409). Both resolve to typed Results — no
    // throws, no deadlock.
    const [a, b] = await Promise.all([
      issueRefund(deps, {
        tenantId: tenant.ctx.slug,
        paymentId: racePaymentId,
        amountSatang: asSatang(1_000_000n),
        reason: 'race A',
        actorUserId: user.userId,
        correlationId: 'corr-race-a',
        requestId: 'req-race-a',
      }),
      issueRefund(deps, {
        tenantId: tenant.ctx.slug,
        paymentId: racePaymentId,
        amountSatang: asSatang(1_000_000n),
        reason: 'race B',
        actorUserId: user.userId,
        correlationId: 'corr-race-b',
        requestId: 'req-race-b',
      }),
    ]);

    const okResults = [a, b].filter((r): r is { ok: true; value: IssueRefundSuccess } => r.ok);
    const errResults = [a, b].filter(
      (r): r is { ok: false; error: IssueRefundError } => !r.ok,
    );
    expect(okResults.length).toBe(1);
    expect(errResults.length).toBe(1);
    const errResult = errResults[0];
    expect(errResult).toBeDefined();
    if (errResult) {
      expect(errResult.error.code).toBe('refund_in_progress');
    }
  }, 60_000);
});
