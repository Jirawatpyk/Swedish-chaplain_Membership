/**
 * A.18 (#1) — concurrent admin-refund + webhook race → exactly ONE credit note.
 *
 * CRITICAL-1's teeth (Review-Gate blocker). A single PARTIAL refund is driven
 * to its terminal `succeeded` state by TWO writers racing on `Promise.all`:
 *
 *   - `issueRefund` (A.9, admin) — Stripe `createRefund` returns `succeeded`
 *     synchronously, so the admin path books the F4 credit note itself.
 *   - `processRefundUpdated` (A.11, webhook) — a `charge.refund.updated(succeeded)`
 *     for the SAME Stripe refund id arrives concurrently and also tries to
 *     finalise the refund into a credit note.
 *
 * Against real Postgres the money invariant MUST hold in EVERY interleaving:
 *
 *   - EXACTLY ONE `credit_notes` row for the refund (`source_refund_id`), backed
 *     by migration 0242's partial unique index + the finaliser's
 *     `expectedCurrentStatus='pending'` guard.
 *   - The §87 credit-note counter advances by EXACTLY 1 (no gap, no
 *     double-alloc) — the loser's `allocateNext` rolls back and returns its
 *     number to the pool (RR-2 fresh-tx reconcile).
 *   - `credited_total` = the partial refund amount; payment flips
 *     `partially_refunded`; exactly ONE succeeded refund row (no double-refund).
 *
 * The race GENUINELY occurs — both writers are dispatched before either
 * resolves (no artificial serialisation). Depending on scheduling the webhook
 * may resolve `reconciled_succeeded` / `already_finalized` (row already
 * present) OR `out_of_band` (row not yet visible when it locks); in ALL cases
 * the admin path books the sole credit note and the invariant holds. Every
 * assertion reads DB state directly.
 *
 * Mocking policy: live Postgres for the F5 repos + F4 credit-note repo + §87
 * allocator + audit. Only the Stripe gateway (returns `succeeded`) and F4's
 * PDF/Blob/outbox adapters are stubbed.
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/payments/concurrent-double-cn.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';

// --- Module-level mocks of F4 external adapters (real CN path, mocked I/O) ---
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

import { issueRefund, type IssueRefundDeps } from '@/modules/payments';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { payments } from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
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

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const REFUND_AMOUNT = 53_500n; // partial
const FISCAL_YEAR = 2026;
const PLAN_ID = 'concurrent-cn-plan';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Concurrent CN Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('concurrent admin-refund + webhook → exactly ONE credit note (A.18 #1)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
        planName: { en: 'Concurrent CN Plan' },
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
        invoiceNumberPrefix: 'CCN',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function seedPaidInvoice(): Promise<{ invoiceId: string; paymentId: PaymentId }> {
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    const paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    const seq = Math.floor(Math.random() * 900_000) + 1;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Concurrent CN Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
      });
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
        documentNumber: `CCN-2026-${String(seq).padStart(6, '0')}`,
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
        paymentMethod: 'card',
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
        method: 'card',
        status: 'succeeded',
        amountSatang: INVOICE_TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date('2026-04-20T03:00:00Z'),
        completedAt: new Date('2026-04-20T03:00:10Z'),
        actorUserId: user.userId,
        correlationId: 'corr-concurrent-pay',
      });
    });
    return { invoiceId, paymentId };
  }

  /** issueRefund deps whose Stripe gateway returns a SYNCHRONOUS `succeeded`. */
  function adminRefundDeps(processorRefundId: string): IssueRefundDeps {
    return {
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      tenantSettingsRepo: {
        async getByTenantId() {
          return {
            tenantId: tenant.ctx.slug,
            processor: 'stripe' as const,
            processorEnvironment: 'test' as const,
            processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
            processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
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
          ok({ id: processorRefundId, status: 'succeeded', amountSatang: asSatang(0n) }),
        ),
        retrieveRefund: vi.fn(),
      },
      invoicingBridge,
      audit: f5AuditAdapter,
      clock: systemClock,
      generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      idempotencyKeyFactory: (k) => k,
    };
  }

  function webhookDeps() {
    return {
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      processorEventsRepo: makeDrizzleProcessorEventsRepo(),
      invoicingBridge,
      audit: f5AuditAdapter,
      clock: systemClock,
    };
  }

  async function readCreditNoteSeq(): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ next: tenantDocumentSequences.nextSequenceNumber })
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'credit_note'),
            eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
          ),
        ),
    );
    return rows[0]?.next ?? 1;
  }

  async function cnCountForRefund(refundId: string): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: creditNotes.creditNoteId })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.tenantId, tenant.ctx.slug),
            eq(creditNotes.sourceRefundId, refundId),
          ),
        ),
    );
    return rows.length;
  }

  async function succeededRefundCount(paymentId: PaymentId): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug}
        AND payment_id = ${paymentId}
        AND status = 'succeeded'
    `)) as unknown as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  }

  it('Promise.all(issueRefund succeeded, charge.refund.updated succeeded) → one CN, §87 +1, no double-refund', async () => {
    const { invoiceId, paymentId } = await seedPaidInvoice();
    const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const seqBefore = await readCreditNoteSeq();

    // Both writers dispatched BEFORE either resolves — a genuine race.
    const [refundResult, webhookResult] = await Promise.all([
      issueRefund(adminRefundDeps(reId), {
        tenantId: tenant.ctx.slug,
        paymentId,
        amountSatang: asSatang(REFUND_AMOUNT),
        reason: 'concurrent partial refund',
        actorUserId: user.userId,
        correlationId: 'corr-cc-admin',
        requestId: 'req-cc-admin',
      }),
      processRefundUpdated(webhookDeps(), {
        tenantId: tenant.ctx.slug,
        requestId: 'req-cc-webhook',
        eventId: `evt_${randomUUID().slice(0, 12)}`,
        processorRefundId: reId,
        chargeId: 'ch_x',
        refundStatus: 'succeeded',
        amountSatang: REFUND_AMOUNT,
        processorEnv: 'test',
      }),
    ]);

    // The admin path always books the sole credit note (Stripe returned
    // succeeded synchronously). It resolves ok — `kind:'succeeded'`, possibly
    // with `siblingWon` if the webhook flipped the refund first.
    expect(refundResult.ok).toBe(true);
    if (!refundResult.ok || refundResult.value.kind !== 'succeeded') {
      throw new Error(
        `admin refund did not succeed: ${JSON.stringify(
          refundResult.ok ? refundResult.value : refundResult.error,
        )}`,
      );
    }
    const refundId = refundResult.value.refund.id;
    // The webhook resolves cleanly in every interleaving (reconciled_succeeded /
    // already_finalized when the row is visible; out_of_band when it locks
    // before Phase A commits). It NEVER errors and NEVER double-books.
    expect(webhookResult.ok).toBe(true);
    if (webhookResult.ok) {
      expect(
        ['reconciled_succeeded', 'already_finalized', 'out_of_band'],
      ).toContain(webhookResult.value.kind);
    }

    // MONEY INVARIANTS (asserted against DB state directly):
    // 1) exactly ONE credit note for this refund.
    expect(await cnCountForRefund(refundId)).toBe(1);
    // 2) §87 credit-note counter advanced by EXACTLY 1 (no gap, no double-alloc).
    expect((await readCreditNoteSeq()) - seqBefore).toBe(1);
    // 3) exactly ONE succeeded refund row (no double-refund).
    expect(await succeededRefundCount(paymentId)).toBe(1);

    // 4) payment flipped partially_refunded; refund succeeded with a CN id.
    const [pay] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)));
    expect(pay?.status).toBe('partially_refunded');

    const refundRows = (await db.execute(sql`
      SELECT status, credit_note_id FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND id = ${refundId}
    `)) as unknown as Array<{ status: string; credit_note_id: string | null }>;
    expect(refundRows[0]?.status).toBe('succeeded');
    expect(refundRows[0]?.credit_note_id).not.toBeNull();

    // 5) credited_total == the partial refund amount; invoice partially_credited.
    const [inv] = await db
      .select({ status: invoices.status, credited: invoices.creditedTotalSatang })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(inv?.status).toBe('partially_credited');
    expect(BigInt((inv?.credited ?? 0n) as unknown as string)).toBe(REFUND_AMOUNT);
  }, 90_000);

  /**
   * Seed the EXACT state a finalise-under-contention loser meets: a PENDING
   * refund whose F4 credit note is ALREADY committed for its
   * `source_refund_id`. F4 books the CN in its OWN tx (committed + durable);
   * a finalise whose outer tx then rolls back before flipping the refund row
   * leaves precisely this pair — a live CN + a still-`pending` refund. Returns
   * the refund id, its Stripe `re_` id, the paid-invoice's payment id, and the
   * pre-booked credit note id.
   */
  async function seedPendingRefundWithCommittedCn(): Promise<{
    refundId: string;
    reId: string;
    paymentId: PaymentId;
    creditNoteId: string;
  }> {
    const { invoiceId, paymentId } = await seedPaidInvoice();
    const refundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // 1) A pending refund row carrying the Stripe re_ id — the FK target the
    //    CN's `source_refund_id` will point at.
    await runInTenant(tenant.ctx, async (tx) => {
      await makeDrizzleRefundsRepo(tenant.ctx.slug).insert(tx, {
        id: refundId,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(REFUND_AMOUNT),
        reason: 'finalize-under-contention seed',
        status: 'pending',
        processorRefundId: reId,
        initiatorUserId: user.userId,
        correlationId: 'corr-cc-guard-seed',
        initiatedAt: new Date(),
      });
    });

    // 2) Book the REAL F4 credit note via the SAME bridge the finaliser calls.
    //    Burns ONE §87 number + inserts ONE CN and does NOT touch the refund
    //    row's status (that is the finaliser's step 2), so the refund stays
    //    `pending` with a live CN — the contention-loser state.
    const cn = await invoicingBridge.issueCreditNoteFromRefund({
      tenantId: tenant.ctx.slug,
      invoiceId,
      refundId,
      amountSatang: asSatang(REFUND_AMOUNT),
      reason: 'finalize-under-contention seed',
      actorUserId: user.userId,
      requestId: 'req-cc-guard-seed',
    });
    if (!cn.ok) {
      throw new Error(`seed credit note failed: ${JSON.stringify(cn.error)}`);
    }
    return { refundId, reId, paymentId, creditNoteId: cn.value.creditNoteId };
  }

  it('deterministic guard: webhook reaches CN-issue with a CN already committed for source_refund_id → reuses it, no double-book, §87 unchanged', async () => {
    const { refundId, reId, paymentId, creditNoteId: seededCnId } =
      await seedPendingRefundWithCommittedCn();

    // Post-seed baseline: exactly ONE CN, and the §87 counter has ALREADY
    // advanced for the seed CN. From here the finalise-under-contention guard
    // MUST NOT burn a second number or insert a second row.
    expect(await cnCountForRefund(refundId)).toBe(1);
    const seqAfterSeed = await readCreditNoteSeq();

    // The async `charge.refund.updated(succeeded)` webhook finalises the
    // still-`pending` refund. `finalizeSucceededRefund` step 1 calls
    // `issueCreditNoteFromRefund`, which — DETERMINISTICALLY, every run —
    // finds the committed CN via the `(tenant_id, source_refund_id)`
    // idempotency read (backed by the `credit_notes_source_refund_id_uniq`
    // partial unique index) and returns it WITHOUT allocating a new §87 number
    // or inserting a second row. This is the exact finalise-time double-book
    // guard the genuine race test above only *sometimes* exercises (it can
    // resolve `out_of_band` and never reach the CN-issue point); here the
    // webhook is GUARANTEED to reach it against a live CN + pending row, so
    // "exactly one CN" is a proven backstop, not a "only one writer tried"
    // artefact.
    const settle = await processRefundUpdated(webhookDeps(), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-cc-guard-webhook',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      processorRefundId: reId,
      chargeId: 'ch_x',
      refundStatus: 'succeeded',
      amountSatang: REFUND_AMOUNT,
      processorEnv: 'test',
    });

    expect(settle.ok).toBe(true);
    if (!settle.ok) {
      throw new Error(`webhook finalise failed: ${JSON.stringify(settle.error)}`);
    }
    // The refund WAS pending, so this is a genuine reconcile — but the CN it
    // reports is the SEEDED one (idempotent reuse), which is the guard firing.
    expect(settle.value.kind).toBe('reconciled_succeeded');
    if (settle.value.kind === 'reconciled_succeeded') {
      expect(settle.value.creditNoteId).toBe(seededCnId);
    }

    // GUARD PROOF (all DB-direct reads):
    // 1) still EXACTLY ONE credit note for the refund — no double-book.
    expect(await cnCountForRefund(refundId)).toBe(1);
    // 2) the §87 credit-note counter did NOT advance — the finaliser reused
    //    the existing number rather than burning a fresh one.
    expect((await readCreditNoteSeq()) - seqAfterSeed).toBe(0);
    // 3) exactly ONE succeeded refund (the finalise flipped it, not a dup).
    expect(await succeededRefundCount(paymentId)).toBe(1);

    // The refund flipped succeeded and points at the SEEDED CN (not a new one).
    const refundRows = (await db.execute(sql`
      SELECT status, credit_note_id FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND id = ${refundId}
    `)) as unknown as Array<{ status: string; credit_note_id: string | null }>;
    expect(refundRows[0]?.status).toBe('succeeded');
    expect(refundRows[0]?.credit_note_id).toBe(seededCnId);

    // The finalise completed end-to-end: the payment flipped partially_refunded.
    const [pay] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)));
    expect(pay?.status).toBe('partially_refunded');
  }, 90_000);
});
