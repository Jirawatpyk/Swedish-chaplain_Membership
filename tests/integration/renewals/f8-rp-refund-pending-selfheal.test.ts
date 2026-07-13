/**
 * A.18 (#5) — F8-RP round-trip: admin-reject → refund_pending → F5 settles →
 * reconcile cron self-heals the cycle. Live Neon.
 *
 * F8-RP (2026-07-11): when an admin rejects a `pending_admin_reactivation`
 * cycle whose refund settles ASYNCHRONOUSLY (PromptPay), the F5 bridge returns
 * `refund_pending`, the cycle is LEFT pending (no transition, not a
 * timeout-failure), and it self-heals on a later reconcile pass once the
 * refund settles. This drives the full cross-module lifecycle end-to-end:
 *
 *   1. `adminRejectReactivation` → F5 `issueRefund` returns `pending` (Stripe
 *      async) → bridge `refund_pending` → cycle STAYS
 *      `pending_admin_reactivation`; a refund row is `pending`, NO credit note.
 *   2. `processRefundUpdated(succeeded)` settles the refund → exactly ONE F4
 *      credit note (§87 +1), refund `succeeded`, payment `refunded`.
 *   3. `reconcilePendingReactivations` → the cycle still carries the reject-
 *      refund marker (stamped in step 1), so `processCycle` routes it to the
 *      MARKED branch (`processMarkedRejectRefund`), which resolves the settled
 *      refund and converges the cycle to CANCELLED
 *      (`closed_reason='admin_rejected_with_refund'`) with the admin as actor +
 *      a post_refund_review task. An explicit admin reject is NEVER recorded as
 *      a system timeout/lapse. (Round-2 review corrected this test's earlier
 *      `lapsed`/`timed_out` expectation, which contradicted the marked-branch
 *      convergence shipped in the same PR.)
 *
 * MONEY-SAFETY: exactly ONE succeeded refund + ONE credit note survive the
 * whole round-trip (no double-refund, no CN loss). Every assertion reads DB
 * state directly.
 *
 * Mocking policy: live Postgres for all F5/F8 DB writes + the REAL F4
 * credit-note bridge (PDF/Blob/outbox stubbed). The Stripe gateway (returns an
 * async `pending` refund) and the F5 tenant-payment-settings repo (its real
 * form wraps reads in `unstable_cache`, which throws outside a request context)
 * are module-mocked so the REAL `f5RefundBridge` production adapter can run.
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/renewals/f8-rp-refund-pending-selfheal.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { db, runInTenant } from '@/lib/db';

// Shared, hoisted Stripe refund id so the gateway mock and the webhook driver
// agree. UNIQUE per run — `refunds.processor_refund_id` carries a partial unique
// index (global, not tenant-scoped), and a prior run's refund row leaks past
// tenant cleanup (a CN FK-references it via source_refund_id), so a fixed id
// would collide on re-run. `vi.hoisted` runs before imports, so use `Math.random`
// (no import) rather than `randomUUID`.
const h = vi.hoisted(() => ({
  reId: `re_a18f8rp${Math.random().toString(36).slice(2, 14)}`,
}));

// The F8 bridge calls the PRODUCTION `makeIssueRefundDeps`, which wires the real
// Stripe gateway. Mock it so `createRefund` returns an ASYNC `pending` refund.
vi.mock('@/modules/payments/infrastructure/stripe/stripe-gateway', () => ({
  stripeGateway: {
    createPaymentIntent: async () => {
      throw new Error('unused in f8-rp test');
    },
    retrievePaymentIntent: async () => {
      throw new Error('unused in f8-rp test');
    },
    cancelPaymentIntent: async () => {
      throw new Error('unused in f8-rp test');
    },
    createRefund: async () => ({
      ok: true,
      value: { id: h.reId, status: 'pending', amountSatang: 0n },
    }),
    retrieveRefund: async () => {
      throw new Error('unused in f8-rp test');
    },
  },
}));

// The real settings repo wraps reads in Next.js `unstable_cache` (throws outside
// a request context). Replace the factory with an inline stub returning the
// seeded processor settings so `issueRefund` (via the bridge) can read them.
vi.mock('@/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo', () => ({
  makeDrizzleTenantPaymentSettingsRepo: () => ({
    async getByTenantId(tenantId: string) {
      return {
        tenantId,
        processor: 'stripe' as const,
        processorEnvironment: 'test' as const,
        processorAccountId: 'acct_test_f8rp',
        processorPublishableKey: 'pk_test_f8rp',
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
  }),
  updateTenantPaymentSettings: async () => {},
  __resetTenantPaymentSettingsRepoCache: () => {},
}));

// F4 external adapters (real CN chain, mocked I/O) — for step 2's credit note.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: S.ofUnsafe('b'.repeat(64)),
      })),
    },
  };
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: { enqueue: vi.fn(async () => {}) },
}));

import {
  adminRejectReactivation,
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { f5RefundBridge } from '@/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { payments } from '@/modules/payments/infrastructure/schema';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const FISCAL_YEAR = 2026;
const PLAN_ID = 'f8rp-plan';
const NOW = new Date('2026-06-01T07:00:00Z');
const ENTERED_PENDING_AT = new Date(NOW.getTime() - 40 * 86_400_000); // 40 days → past 30-day timeout

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'F8RP Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('F8-RP refund_pending → settle → reconcile self-heal — live Neon (A.18 #5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;
  let paymentId: PaymentId;
  let cycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    memberId = randomUUID();
    invoiceId = randomUUID();
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    cycleId = randomUUID();
    const seq = Math.floor(Math.random() * 900_000) + 1;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: PLAN_ID,
        planName: { en: 'F8-RP Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'F8RP',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'F8RP Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
      });
      // PAID membership invoice — the cycle's linked invoice + refund target.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId: PLAN_ID,
        draftByUserId: user.userId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        fiscalYear: FISCAL_YEAR,
        sequenceNumber: seq,
        documentNumber: `F8RP-2026-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-04-15',
        dueDate: '2026-05-14',
        subtotalSatang: INVOICE_SUBTOTAL,
        vatRateSnapshot: '0.0700',
        vatSatang: INVOICE_VAT,
        totalSatang: INVOICE_TOTAL,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: 'invoicing/x/2026/seed.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'promptpay',
        paymentReference: 'seed-ref',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-04-20',
        paidAt: new Date('2026-04-20T03:00:00Z'),
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: INVOICE_SUBTOTAL,
        totalSatang: INVOICE_SUBTOTAL,
        position: 1,
      });
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        status: 'succeeded',
        amountSatang: INVOICE_TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: null,
        cardLast4: null,
        cardExpMonth: null,
        cardExpYear: null,
        initiatedAt: new Date('2026-04-20T03:00:00Z'),
        completedAt: new Date('2026-04-20T03:00:10Z'),
        actorUserId: user.userId,
        correlationId: 'corr-f8rp-pay',
      });
      // Cycle stuck pending, past the 30-day timeout, linked to the paid invoice.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'pending_admin_reactivation',
        periodFrom: new Date('2026-01-01T00:00:00Z'),
        periodTo: new Date('2027-01-01T00:00:00Z'),
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: PLAN_ID,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        enteredPendingAt: ENTERED_PENDING_AT,
        linkedInvoiceId: invoiceId,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function cycleRow(): Promise<{ status: string; closedReason: string | null }> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status, closedReason: renewalCycles.closedReason })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    return rows[0] ?? { status: 'MISSING', closedReason: null };
  }
  async function refundRowByRe(): Promise<{ id: string; status: string; creditNoteId: string | null }> {
    const rows = (await db.execute(sql`
      SELECT id, status, credit_note_id FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND processor_refund_id = ${h.reId}
    `)) as unknown as Array<{ id: string; status: string; credit_note_id: string | null }>;
    const row = rows[0];
    return {
      id: row?.id ?? 'MISSING',
      status: row?.status ?? 'MISSING',
      creditNoteId: row?.credit_note_id ?? null,
    };
  }
  async function succeededRefundCount(): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND payment_id = ${paymentId} AND status = 'succeeded'
    `)) as unknown as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  }
  async function cnCountForInvoice(): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: creditNotes.creditNoteId })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.tenantId, tenant.ctx.slug),
            eq(creditNotes.originalInvoiceId, invoiceId),
          ),
        ),
    );
    return rows.length;
  }
  async function paymentStatus(): Promise<string> {
    const [row] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)));
    return row?.status ?? 'MISSING';
  }

  it('reject→refund_pending (cycle stays pending) → settle → reconcile converges to CANCELLED via marked branch; no double-refund, no CN loss', async () => {
    // Step 1 — admin rejects; F5 refund settles async → refund_pending.
    const reject = await adminRejectReactivation(
      { ...makeRenewalsDeps(tenant.ctx.slug), f5RefundBridge },
      {
        tenantId: tenant.ctx.slug,
        cycleId,
        reason: 'duplicate payment — async refund',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      },
    );
    expect(reject.ok).toBe(true);
    if (!reject.ok) return;
    expect(reject.value.outcome).toBe('refund_pending');
    if (reject.value.outcome === 'refund_pending') {
      expect(reject.value.processorRefundId).toBe(h.reId);
    }
    // Cycle LEFT pending (no transition); refund row pending; NO credit note.
    expect((await cycleRow()).status).toBe('pending_admin_reactivation');
    const pendingRefund = await refundRowByRe();
    expect(pendingRefund.status).toBe('pending');
    expect(await cnCountForInvoice()).toBe(0);
    expect(await paymentStatus()).toBe('succeeded');

    // Step 2 — the async charge.refund.updated(succeeded) settles the refund.
    const settle = await processRefundUpdated(
      {
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        processorEventsRepo: makeDrizzleProcessorEventsRepo(),
        invoicingBridge,
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      {
        tenantId: tenant.ctx.slug,
        requestId: 'req-f8rp-webhook',
        eventId: `evt_${randomUUID().slice(0, 12)}`,
        processorRefundId: h.reId,
        chargeId: 'ch_x',
        refundStatus: 'succeeded',
        amountSatang: asSatang(INVOICE_TOTAL),
        processorEnv: 'test',
      },
    );
    expect(settle.ok).toBe(true);
    if (!settle.ok) return;
    expect(settle.value.kind).toBe('reconciled_succeeded');
    // Exactly ONE credit note, refund succeeded, payment fully refunded.
    const settledRefund = await refundRowByRe();
    expect(settledRefund.status).toBe('succeeded');
    expect(settledRefund.creditNoteId).not.toBeNull();
    expect(await cnCountForInvoice()).toBe(1);
    expect(await succeededRefundCount()).toBe(1);
    expect(await paymentStatus()).toBe('refunded');
    // Cycle still pending (F5 settlement does not touch the F8 cycle).
    expect((await cycleRow()).status).toBe('pending_admin_reactivation');

    // Step 3 — next reconcile pass. The cycle still carries the reject-refund
    // marker (stamped in step 1), so `processCycle` routes it to the MARKED
    // branch (`processMarkedRejectRefund`), NOT the timeout path. That branch
    // resolves the now-settled refund and converges the cycle to CANCELLED
    // (`admin_rejected_with_refund`) with the rejecting admin as actor + a
    // post_refund_review task. An admin who explicitly rejected must NEVER be
    // recorded as a system timeout/lapse. (Round-2 review, HIGH: the timeout
    // path must never lapse a marked cycle — see reconcile Step-1/Step-3 marker
    // guards. Superseded the earlier `timed_out`/`lapsed` expectation of this
    // test, which contradicted the marked-branch convergence shipped in the
    // same PR and would have re-introduced exactly that misattribution bug.)
    const reconcile = await reconcilePendingReactivations(
      { ...makeRenewalsDeps(tenant.ctx.slug), f5RefundBridge },
      {
        tenantId: tenant.ctx.slug,
        now: NOW,
        correlationId: randomUUID(),
      },
    );
    expect(reconcile.ok).toBe(true);
    if (!reconcile.ok) return;
    expect(reconcile.value.asyncRejectSettledCancelled).toBe(1);
    expect(reconcile.value.timedOut).toBe(0);
    expect(reconcile.value.timeoutRefundPending).toBe(0);
    expect(reconcile.value.timeoutRefundFailures).toBe(0);

    // Cycle converged to CANCELLED via the admin-reject marked branch (NOT
    // lapsed) — attributed to the admin, distinct from a system timeout.
    const healed = await cycleRow();
    expect(healed.status).toBe('cancelled');
    expect(healed.closedReason).toBe('admin_rejected_with_refund');

    // MONEY-SAFETY: exactly ONE succeeded refund + ONE credit note survive; no
    // double-refund on the convergence; payment stays fully refunded.
    expect(await succeededRefundCount()).toBe(1);
    expect(await cnCountForInvoice()).toBe(1);
    expect(await paymentStatus()).toBe('refunded');
  }, 120_000);
});
