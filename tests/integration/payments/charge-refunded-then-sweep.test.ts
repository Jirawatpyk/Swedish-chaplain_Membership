/**
 * A.18 (#4) — charge.refunded is a no-op for a pending refund; the A.14 sweep
 * is the backstop that finalises it. Live Neon.
 *
 * A.12 (#2, RR-5) removed the old `charge.refunded` finalisation: a `pending`
 * refund row that receives ONLY `charge.refunded` (and never the
 * `charge.refund.updated` that owns finalisation) is LEFT pending — no credit
 * note, no flip. This test proves that removed backstop is covered by the A.14
 * Stripe-aware sweep:
 *
 *   1. `processChargeRefunded` for a matched `pending` refund → no finalize,
 *      no CN, refund stays `pending`, payment stays `succeeded`.
 *   2. `sweepStalePendingRefunds` (Stripe `retrieveRefund` → `succeeded`) →
 *      finalises via the REAL F4 credit-note bridge: exactly ONE CN (§87 +1),
 *      refund flips `succeeded`, payment flips `partially_refunded`, and a
 *      `refund_succeeded` audit with `payload.path='sweep_recovery'` lands.
 *
 * This is also the live-Neon regression guard for the A.18 lock fix: the sweep
 * holds `FOR NO KEY UPDATE` on the refund across `finalizeSucceededRefund`,
 * whose F4 bridge FK-inserts `credit_notes.source_refund_id` — under the old
 * `FOR UPDATE` this deadlocked (see the async-refund test + task report).
 *
 * Mocking policy: live Postgres for every DB write + the real F4 CN chain
 * (PDF/Blob/outbox stubbed). The Stripe gateway is a FAKE (keyed by `re_…`);
 * the tenant-settings repo is inline-stubbed (the real one wraps reads in
 * `unstable_cache`, which throws outside a request context).
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/payments/charge-refunded-then-sweep.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';

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
  sweepStalePendingRefunds,
  type SweepStalePendingRefundsDeps,
} from '@/modules/payments';
import { processChargeRefunded } from '@/modules/payments/application/use-cases/process-charge-refunded';
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
const PLAN_ID = 'backstop-plan';
const STALE_INITIATED = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30h ago

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Backstop Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('charge.refunded no-op + A.14 sweep backstop — live Neon (A.18 #4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  let paymentId: PaymentId;
  let refundId: string;
  const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    const memberId = randomUUID();
    invoiceId = randomUUID();
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    refundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const seq = Math.floor(Math.random() * 900_000) + 1;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
        planName: { en: 'Backstop Plan' },
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
        invoiceNumberPrefix: 'BST',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Backstop Co',
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
        documentNumber: `BST-2026-${String(seq).padStart(6, '0')}`,
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
        correlationId: 'corr-backstop-pay',
      });
      // A stale pending refund with its Stripe id attached (the async
      // refund that got `charge.refunded` but never `charge.refund.updated`).
      await makeDrizzleRefundsRepo(tenant.ctx.slug).insert(tx, {
        id: refundId,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(REFUND_AMOUNT),
        reason: 'async refund awaiting settlement',
        status: 'pending',
        processorRefundId: reId,
        initiatorUserId: user.userId,
        correlationId: 'corr-backstop-refund',
        initiatedAt: STALE_INITIATED,
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  function stubSettings(): SweepStalePendingRefundsDeps['tenantSettingsRepo'] {
    return {
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
    } as unknown as SweepStalePendingRefundsDeps['tenantSettingsRepo'];
  }

  function fakeGateway(statusByRe: Readonly<Record<string, string>>) {
    return {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(),
      retrieveRefund: vi.fn(async (rid: string) => {
        const status = statusByRe[rid];
        if (status === undefined) {
          return err({ kind: 'permanent' as const, code: 'resource_missing', reason: 'no such refund' });
        }
        return ok({ id: rid, status, chargeId: 'ch_x', paymentIntentId: 'pi_x', amountSatang: asSatang(0n) });
      }),
    } as unknown as SweepStalePendingRefundsDeps['processorGateway'];
  }

  async function refundRow(): Promise<{ status: string; creditNoteId: string | null }> {
    const rows = (await db.execute(sql`
      SELECT status, credit_note_id FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND id = ${refundId}
    `)) as unknown as Array<{ status: string; credit_note_id: string | null }>;
    const row = rows[0];
    return { status: row?.status ?? 'MISSING', creditNoteId: row?.credit_note_id ?? null };
  }
  async function cnCount(): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: creditNotes.creditNoteId })
        .from(creditNotes)
        .where(and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.sourceRefundId, refundId))),
    );
    return rows.length;
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
  async function paymentStatus(): Promise<string> {
    const [row] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)));
    return row?.status ?? 'MISSING';
  }
  async function sweepRecoveryAuditCount(): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = 'refund_succeeded'::audit_event_type
        AND payload->>'refund_id' = ${refundId}
        AND payload->>'path' = 'sweep_recovery'
    `)) as unknown as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  }

  it('charge.refunded leaves a matched pending refund pending (no CN); the A.14 sweep finalises it', async () => {
    const seqBefore = await readCreditNoteSeq();

    // Step 1 — charge.refunded arrives for the matched pending refund. Post-A.12
    // it does NOT finalise: no CN, refund stays pending, payment untouched.
    const chargeResult = await processChargeRefunded(
      {
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        processorEventsRepo: makeDrizzleProcessorEventsRepo(),
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      {
        tenantId: tenant.ctx.slug,
        requestId: 'req-charge-refunded',
        eventId: `evt_${randomUUID().slice(0, 12)}`,
        chargeId: 'ch_x',
        refundIds: [reId],
        // Charge total refunded == the refund amount → no amount-mismatch flag.
        amountSatang: REFUND_AMOUNT,
        processorEnv: 'test',
      },
    );
    expect(chargeResult.ok).toBe(true);

    expect((await refundRow()).status).toBe('pending');
    expect(await cnCount()).toBe(0);
    expect(await paymentStatus()).toBe('succeeded');
    expect(await readCreditNoteSeq()).toBe(seqBefore); // no §87 number burned
    expect(await sweepRecoveryAuditCount()).toBe(0);

    // Step 2 — the A.14 Stripe-aware sweep is the backstop: retrieve → succeeded
    // → finalise via the REAL F4 credit-note bridge.
    const sweepDeps: SweepStalePendingRefundsDeps = {
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      tenantSettingsRepo: stubSettings(),
      processorGateway: fakeGateway({ [reId]: 'succeeded' }),
      invoicingBridge,
      audit: f5AuditAdapter,
      clock: systemClock,
    };
    const sweepResult = await sweepStalePendingRefunds(sweepDeps, {
      tenantId: tenant.ctx.slug,
      requestId: 'req-sweep-backstop',
    });
    expect(sweepResult.ok).toBe(true);
    if (!sweepResult.ok) return;
    expect(sweepResult.value.sweptCount).toBe(1);

    // Finalised: refund succeeded + CN, exactly one CN, §87 +1, payment flipped.
    const settled = await refundRow();
    expect(settled.status).toBe('succeeded');
    expect(settled.creditNoteId).not.toBeNull();
    expect(await cnCount()).toBe(1);
    expect((await readCreditNoteSeq()) - seqBefore).toBe(1);
    expect(await paymentStatus()).toBe('partially_refunded');
    expect(await sweepRecoveryAuditCount()).toBe(1);
  }, 90_000);
});
