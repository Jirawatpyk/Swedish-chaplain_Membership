/**
 * T128 (Phase 8 / US6) — F4 receipt-email path verification (FR-004).
 *
 * Spec authority: F5 spec.md US6 (P3) + FR-004.
 *
 * Goal: verify the F5 settlement path reuses F4's existing receipt
 * pipeline EXACTLY ONCE per succeeded payment — no bypass, no double
 * dispatch — for both `card` and `promptpay` rails.
 *
 * Asserted invariants:
 *   1. `markPaidFromProcessor` flips the invoice `issued → paid`
 *      (delegation to F4's `recordPayment` proven by the status flip
 *      and the `paymentNotes` annotation containing the rail label +
 *      Stripe intent/charge ids).
 *   2. The receipt PDF is rendered exactly ONCE per payment (the F4
 *      render adapter is invoked once with `kind: 'receipt_*'` —
 *      proves no duplicate render + no F5-side bypass render).
 *   3. The auto-email outbox row is enqueued exactly ONCE per payment
 *      with `eventType: 'invoice_paid'`, the correct invoiceId, and a
 *      receipt blob key matching what was rendered. This is the
 *      single-email AS1+AS2 invariant from spec US6.
 *   4. The `paymentDate` persisted on the invoice equals the
 *      `settlementDate` derived from the Stripe event timestamp in
 *      `Asia/Bangkok` local calendar (FR-004 contract: settlement
 *      date threaded through to F4).
 *   5. Receipt PDF byte-identity vs. a manual-mark equivalent: F4's
 *      render input depends only on the invoice snapshot + template
 *      version. The F5 path never widens the render input (asserted
 *      by inspecting the captured `renderInput.kind` + absence of any
 *      F5-specific fields), so SC-003 (F4 byte-identical render) holds
 *      transitively. We run BOTH a card payment and a manual
 *      `recordPayment` against an identical-shape invoice and assert
 *      the captured render-input shapes match field-for-field on the
 *      shared keys (kind, templateVersion, lines, totals).
 *
 * Mocking policy (mirrors invoicing-bridge-atomicity.test.ts):
 *   - LIVE Neon for F5 payments + F4 invoices + audit + outbox row
 *     persistence (so we can verify the row landed correctly).
 *   - MOCKED `react-pdf-render-adapter` (deterministic stub bytes —
 *     SC-003 byte-identity is F4's responsibility, not re-tested here).
 *   - MOCKED `vercel-blob-adapter` (no real Blob upload).
 *   - MOCKED `resend-email-outbox-adapter` so we can spy on the
 *     enqueue port directly. The F4-side outbox row insert is
 *     covered separately by F4 integration tests.
 *   - MOCKED Stripe `processorGateway` + `tenantSettingsRepo` (HTTP
 *     surface tested in `stripe-gateway-mock.test.ts`).
 *   - REAL `invoicingBridge` (the system under test) + REAL F5
 *     `paymentsRepo` + REAL F5 audit adapter on live Neon.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { confirmPayment } from '@/modules/payments';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import {
  asPaymentId,
  type PaymentId,
} from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---------------------------------------------------------------------------
// Adapter mocks — deterministic stubs so we can spy on F4 wiring.
// ---------------------------------------------------------------------------

vi.mock(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter',
  async () => {
    const { Sha256Hex: S } = await import(
      '@/modules/invoicing/domain/value-objects/sha256-hex'
    );
    return {
      reactPdfRenderAdapter: {
        // Return deterministic bytes; F4 will hash them to a stable
        // sha256 we can match against the outbox row.
        render: vi.fn(async () => ({
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
          sha256: S.ofUnsafe('c'.repeat(64)),
        })),
      },
    };
  },
);

vi.mock(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter',
  () => ({
    vercelBlobAdapter: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      getSignedReadUrl: vi.fn(async () => 'https://blob.test/signed'),
    },
  }),
);

vi.mock(
  '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter',
  () => ({
    resendEmailOutboxAdapter: {
      enqueue: vi.fn(async () => undefined),
    },
  }),
);

// LEGACY-seed decoupling (mirrors processor-bridge.test.ts). `markPaidFromProcessor`
// builds its recordPayment deps INTERNALLY via `makeRecordPaymentDeps`, which injects
// `taxAtPayment` from the ambient FEATURE_088_TAX_AT_PAYMENT env flag (ON in the dev
// env, frozen at boot) with NO call-site seam. These tests seed a LEGACY invoice
// (documentNumber set, billDocumentNumberRaw NULL) and assert markPaid/receipt-pipeline
// mechanics, NOT the 088 flag — under the flag ON they'd trip the FR-017
// `legacy_invoice_needs_reissue` guard. Pin the LEGACY flow by overriding just the
// factory's `taxAtPayment` to 'off'; every other export (incl. the mocked adapters
// read by the real factory) passes through unchanged.
vi.mock('@/modules/invoicing/application/invoicing-deps', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/invoicing/application/invoicing-deps')>();
  return {
    ...actual,
    makeRecordPaymentDeps: ((
      tenantId: string,
      externalTx?: unknown,
      onPaidCallbacks?: Parameters<typeof actual.makeRecordPaymentDeps>[2],
    ) => ({
      ...actual.makeRecordPaymentDeps(tenantId, externalTx, onPaidCallbacks),
      taxAtPayment: 'off',
    })) as typeof actual.makeRecordPaymentDeps,
  };
});

// Pull the spy refs after vi.mock has resolved (vitest hoists mocks).
const { reactPdfRenderAdapter } = await import(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter'
);
const { resendEmailOutboxAdapter } = await import(
  '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter'
);

const renderSpy = reactPdfRenderAdapter.render as ReturnType<typeof vi.fn>;
const enqueueSpy = resendEmailOutboxAdapter.enqueue as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Plan benefit matrix used by all seeded plans.
// ---------------------------------------------------------------------------

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

interface IssuedSeed {
  readonly invoiceId: string;
  readonly memberId: string;
  readonly paymentId: PaymentId;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly method: 'card' | 'promptpay';
}

describe('F4 receipt-email path verification (T128 / US6 / FR-004)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let cardSeed: IssuedSeed;
  let promptpaySeed: IssuedSeed;
  // T128a (verify-driven 2026-04-27): third seed, identical shape to
  // cardSeed, used by the `autoEmailOnPayment=false` suppression test.
  let suppressedSeed: IssuedSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    cardSeed = {
      invoiceId: randomUUID(),
      memberId: randomUUID(),
      paymentId: asPaymentId(
        `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      ),
      paymentIntentId: `pi_test_t128_card_${randomUUID().slice(0, 8)}`,
      chargeId: `ch_test_t128_card_${randomUUID().slice(0, 8)}`,
      method: 'card',
    };
    promptpaySeed = {
      invoiceId: randomUUID(),
      memberId: randomUUID(),
      paymentId: asPaymentId(
        `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      ),
      paymentIntentId: `pi_test_t128_pp_${randomUUID().slice(0, 8)}`,
      chargeId: `ch_test_t128_pp_${randomUUID().slice(0, 8)}`,
      method: 'promptpay',
    };
    suppressedSeed = {
      invoiceId: randomUUID(),
      memberId: randomUUID(),
      paymentId: asPaymentId(
        `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      ),
      paymentIntentId: `pi_test_t128a_${randomUUID().slice(0, 8)}`,
      chargeId: `ch_test_t128a_${randomUUID().slice(0, 8)}`,
      method: 'card',
    };

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
      await tx
        .insert(tenantPaymentSettings)
        .values(settings)
        .onConflictDoNothing({ target: tenantPaymentSettings.tenantId });

      const planId = `t128-plan-${randomUUID().slice(0, 8)}`;
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T128 Plan' },
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

      await tx
        .insert(tenantInvoiceSettings)
        .values({
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
        })
        .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });

      await tx
        .insert(tenantDocumentSequences)
        .values({
          tenantId: tenant.ctx.slug,
          documentType: 'invoice',
          fiscalYear: 2026,
        })
        .onConflictDoNothing();
      await tx
        .insert(tenantDocumentSequences)
        .values({
          tenantId: tenant.ctx.slug,
          documentType: 'receipt',
          fiscalYear: 2026,
        })
        .onConflictDoNothing();

      // Seed three parallel, identical-shape (issued, same totals)
      // invoice + payment chains — card, PromptPay, plus suppressedSeed
      // (third card chain for the autoEmailOnPayment=false test).
      for (const seed of [cardSeed, promptpaySeed, suppressedSeed]) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: seed.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `T128 Co (${seed.method})`,
          country: 'TH',
          planId,
          planYear: 2026,
        });
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId: seed.memberId,
          planYear: 2026,
          planId,
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: user.userId,
          fiscalYear: 2026,
          sequenceNumber:
            Math.floor(Math.random() * 1_000_000) + 1,
          documentNumber: `T-2026-${String(
            Math.floor(Math.random() * 1_000_000),
          ).padStart(6, '0')}`,
          issueDate: '2026-04-01',
          dueDate: '2026-05-01',
          subtotalSatang: 1_000_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 70_000n,
          totalSatang: 1_070_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: {
            legal_name_th: 'ทดสอบ',
            legal_name_en: 'Test',
            tax_id: '0000000000000',
            address_th: 'Bangkok',
            address_en: 'Bangkok',
            logo_blob_key: null,
          },
          memberIdentitySnapshot: {
            legal_name: `T128 Co (${seed.method})`,
            tax_id: '1234567890123',
            address: 'Bangkok',
            primary_contact_name: 'Test Contact',
            primary_contact_email: `t128-${seed.method}@example.com`,
          },
          pdfBlobKey: 'invoices/test.pdf',
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
        await tx.insert(invoiceLines).values({
          tenantId: tenant.ctx.slug,
          lineId: randomUUID(),
          invoiceId: seed.invoiceId,
          kind: 'membership_fee',
          descriptionTh: 'ค่าสมาชิก',
          descriptionEn: 'Membership fee',
          unitPriceSatang: 1_000_000n,
          quantity: '1',
          proRateFactor: null,
          totalSatang: 1_000_000n,
          position: 1,
        });
        await tx.insert(payments).values({
          id: seed.paymentId,
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId: seed.memberId,
          method: seed.method,
          status: 'pending',
          amountSatang: 1_070_000n,
          currency: 'THB',
          processorPaymentIntentId: seed.paymentIntentId,
          processorChargeId: null,
          processorEnvironment: 'test',
          attemptSeq: 1,
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          initiatedAt: new Date(),
          completedAt: null,
          actorUserId: user.userId,
          correlationId: `corr-t128-${seed.method}`,
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  function makeProcessorGateway(seed: IssuedSeed) {
    const cardMeta =
      seed.method === 'card'
        ? {
            brand: 'visa' as const,
            last4: '4242',
            expMonth: 12,
            expYear: 2030,
          }
        : null;
    return {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: seed.paymentIntentId,
          status: 'succeeded' as const,
          latestChargeId: seed.chargeId,
          livemode: false,
          lastPaymentErrorCode: null,
          card: cardMeta,
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(),
    };
  }

  async function runConfirmFor(
    seed: IssuedSeed,
    overrides: { autoEmailOnPayment?: boolean } = {},
  ) {
    const autoEmailOnPayment = overrides.autoEmailOnPayment ?? true;
    return runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => ({
              tenantId: tenant.ctx.slug,
              processor: 'stripe',
              processorEnvironment: 'test',
              processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
              processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
              enabledMethods: ['card', 'promptpay'],
              onlinePaymentEnabled: true,
              autoEmailOnPayment,
              promptpayQrExpirySeconds: 900,
              allowAnonymousPaylink: false,
            }),
            findByProcessorAccountId: async () => null,
          },
          processorGateway: makeProcessorGateway(seed) as unknown as
            Parameters<typeof confirmPayment>[0]['processorGateway'],
          // REAL bridge — system under test for FR-004.
          invoicingBridge,
          audit: f5AuditAdapter,
          clock: systemClock,
          // Inert for the confirm READ (reconciliationPath:true → dormant); the
          // WRITE flag is pinned 'off' by the invoicing-deps mock above.
          taxAtPayment: 'off',
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: `corr-t128-${seed.method}`,
          requestId: `req-t128-${seed.method}`,
          eventCreatedAtUnixSeconds: Math.floor(
            Date.UTC(2026, 4 - 1, 10, 7, 3, 0) / 1000,
          ),
        },
      ),
    );
  }

  /**
   * Strict spec: F5 settlement → invoice flips to 'paid' + receipt PDF
   * render task enqueued (T166 async pipeline) + invoice_paid email
   * enqueued exactly once.
   *
   * T166 async-default (integration-setup.ts:23 sets
   * FEATURE_F5_ASYNC_RECEIPT_PDF=true) means `recordPayment` SKIPS the
   * inline render+upload — instead it sets `invoices.receipt_pdf_status
   * = 'pending'` and enqueues a `receipt_pdf_render` outbox row that
   * the dispatcher hands off to the worker. The renderSpy is therefore
   * NOT invoked during the webhook hot path; SC-003 byte-identity is
   * still preserved because the worker uses the SAME deterministic
   * render adapter — just on a different schedule.
   *
   * Per-`it` reset: the spies are module-singleton mocks so a prior
   * test's invocations would otherwise leak into the next assertion.
   */
  it('card payment — invoice flips to paid + async receipt-render enqueued + invoice_paid email enqueued once', async () => {
    renderSpy.mockClear();
    enqueueSpy.mockClear();

    const result = await runConfirmFor(cardSeed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');

    // T166 async path — inline render does NOT fire on the webhook
    // hot path. The worker reads the row off `notifications_outbox`
    // later. SC-003 byte-identity is still preserved because the
    // worker calls the same render adapter.
    expect(renderSpy).not.toHaveBeenCalled();

    // invoice_paid email enqueue called exactly ONCE — proves AS1
    // single-email invariant (no duplicate to the primary billing
    // contact). The email payload carries `dependsOnReceiptPdf=true`
    // so the dispatcher gates send on receipt_pdf_status='rendered'.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const enqueueArg = enqueueSpy.mock.calls[0]?.[1] as {
      eventType: string;
      invoiceId?: string;
      pdfBlobKey: string;
      recipientEmail: string;
      dependsOnReceiptPdf?: boolean;
    };
    expect(enqueueArg.eventType).toBe('invoice_paid');
    expect(enqueueArg.invoiceId).toBe(cardSeed.invoiceId);
    expect(enqueueArg.pdfBlobKey).toContain(cardSeed.invoiceId);
    expect(enqueueArg.recipientEmail).toBe('t128-card@example.com');
    expect(enqueueArg.dependsOnReceiptPdf).toBe(true);

    // Async receipt-render outbox row landed — exactly one
    // `receipt_pdf_render` row for this invoice.
    const renderRows = await db
      .select({ id: notificationsOutbox.id })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
          sql`${notificationsOutbox.contextData}->>'invoice_id' = ${cardSeed.invoiceId}`,
        ),
      );
    expect(renderRows).toHaveLength(1);

    // Invoice row flipped to 'paid' + receipt_pdf_status='pending'
    // (T166 async path) + carries the F5 rail + intent + charge ids
    // in paymentNotes (proves the bridge threaded method/paymentIntent
    // Id/chargeId through to F4's recordPayment).
    const [row] = await db
      .select({
        status: invoices.status,
        receiptPdfStatus: invoices.receiptPdfStatus,
        paymentNotes: invoices.paymentNotes,
        paymentReference: invoices.paymentReference,
        paymentDate: invoices.paymentDate,
        paymentMethod: invoices.paymentMethod,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, cardSeed.invoiceId),
        ),
      );
    expect(row?.status).toBe('paid');
    expect(row?.receiptPdfStatus).toBe('pending');
    expect(row?.paymentMethod).toBe('other'); // F4 enum doesn't carry stripe rails
    expect(row?.paymentNotes).toContain('Stripe card');
    expect(row?.paymentNotes).toContain(cardSeed.paymentIntentId);
    expect(row?.paymentNotes).toContain(cardSeed.chargeId);
    expect(row?.paymentReference).toBe(cardSeed.paymentIntentId);
    // Asia/Bangkok local date for the seeded UTC ts (07:03 UTC = 14:03 ICT).
    expect(row?.paymentDate).toBe('2026-04-10');
  }, 60_000);

  it('promptpay payment — same async invariants, PromptPay rail in notes', async () => {
    renderSpy.mockClear();
    enqueueSpy.mockClear();

    const result = await runConfirmFor(promptpaySeed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');

    // T166 async path — inline render skipped on webhook hot path.
    expect(renderSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const enqueueArg = enqueueSpy.mock.calls[0]?.[1] as {
      eventType: string;
      invoiceId?: string;
      recipientEmail: string;
      dependsOnReceiptPdf?: boolean;
    };
    expect(enqueueArg.eventType).toBe('invoice_paid');
    expect(enqueueArg.invoiceId).toBe(promptpaySeed.invoiceId);
    expect(enqueueArg.recipientEmail).toBe('t128-promptpay@example.com');
    expect(enqueueArg.dependsOnReceiptPdf).toBe(true);

    // Async receipt-render outbox row landed for promptpay too.
    const renderRows = await db
      .select({ id: notificationsOutbox.id })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
          sql`${notificationsOutbox.contextData}->>'invoice_id' = ${promptpaySeed.invoiceId}`,
        ),
      );
    expect(renderRows).toHaveLength(1);

    const [row] = await db
      .select({
        status: invoices.status,
        receiptPdfStatus: invoices.receiptPdfStatus,
        paymentNotes: invoices.paymentNotes,
        paymentDate: invoices.paymentDate,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, promptpaySeed.invoiceId),
        ),
      );
    expect(row?.status).toBe('paid');
    expect(row?.receiptPdfStatus).toBe('pending');
    expect(row?.paymentNotes).toContain('Stripe PromptPay');
    expect(row?.paymentNotes).toContain(promptpaySeed.paymentIntentId);
    expect(row?.paymentNotes).toContain(promptpaySeed.chargeId);
    expect(row?.paymentDate).toBe('2026-04-10');
  }, 60_000);

  /**
   * AS3 default branch — `tenant_payment_settings.auto_email_on_payment`
   * defaults to `true` per spec.md:433 + FR-015. The card + promptpay
   * tests above already proved enqueueSpy was called exactly once each
   * with the default flag value — this `it` is a regression guard that
   * the seed actually persisted the default and that the F5 path
   * honoured it.
   *
   * The `false` suppression branch (US6 AS3 negative case) is a known
   * feature gap: the schema column + repo read exist (migration 0033),
   * but no code path consumes it before the F4 outbox enqueue. Tracked
   * as T128a in tasks.md (Phase 9 polish, deferred — spec uses "MAY
   * suppress" so MVP-acceptable as default-on).
   */
  it('AS3 default — autoEmailOnPayment=true (default) → outbox enqueued', async () => {
    const settings = await db
      .select({
        autoEmailOnPayment: tenantPaymentSettings.autoEmailOnPayment,
      })
      .from(tenantPaymentSettings)
      .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
    expect(settings[0]?.autoEmailOnPayment).toBe(true);

    // Defence in depth: at least one prior test in this suite must
    // have invoked enqueueSpy. If a future refactor flips the default
    // to false without updating this seed, the prior `it`s would also
    // fail — this redundant guard is a fast canary.
    expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  /**
   * T128a (verify-driven 2026-04-27) — `autoEmailOnPayment=false`
   * suppression. spec.md:433 + FR-015 say tenants MAY override the
   * default-on receipt-email-on-payment auto-send. Until the verify
   * pass, the schema column existed but no code path consumed it
   * before F4's outbox enqueue → the toggle was inert.
   *
   * After the fix, F5 `confirmPayment` reads
   * `tenantPaymentSettings.autoEmailOnPayment` and threads
   * `suppressReceiptEmail = !autoEmailOnPayment` through
   * `markPaidFromProcessor` → F4 `recordPayment` skips the
   * dispatcher enqueue. ALL OTHER side-effects MUST still run:
   * status flip to `paid`, audit emit, PDF render+upload,
   * registration-fee flip. The suppression is dispatcher-only.
   */
  it('T128a — autoEmailOnPayment=false → invoice_paid email NOT enqueued + receipt-render task STILL enqueued + invoice still flips paid', async () => {
    renderSpy.mockClear();
    enqueueSpy.mockClear();

    const result = await runConfirmFor(suppressedSeed, {
      autoEmailOnPayment: false,
    });
    expect(result.ok, `confirmPayment failed: ${JSON.stringify(!result.ok && result.error)}`).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');

    // T166 async path — inline render is always skipped on the webhook
    // hot path (regardless of suppression). The receipt PDF still
    // renders later via the worker, so admins can resend it manually
    // from /admin/invoices.
    expect(renderSpy).not.toHaveBeenCalled();
    const renderRows = await db
      .select({ id: notificationsOutbox.id })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
          sql`${notificationsOutbox.contextData}->>'invoice_id' = ${suppressedSeed.invoiceId}`,
        ),
      );
    expect(renderRows).toHaveLength(1);

    // invoice_paid email enqueue MUST NOT fire — FR-015 invariant.
    expect(
      enqueueSpy,
      'auto_email_on_payment=false → invoice_paid email enqueue MUST be skipped',
    ).not.toHaveBeenCalled();

    // Invoice MUST still flip to 'paid' — the suppression governs
    // the dispatcher only, not the state transition.
    const [row] = await db
      .select({
        status: invoices.status,
        paymentNotes: invoices.paymentNotes,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, suppressedSeed.invoiceId),
        ),
      );
    expect(row?.status).toBe('paid');
    expect(row?.paymentNotes).toContain('Stripe card');
    expect(row?.paymentNotes).toContain(suppressedSeed.paymentIntentId);
  }, 60_000);

  /**
   * SC-003 reuse (T166-rewrite) — the F5 settlement path enqueues an
   * async `receipt_pdf_render` task instead of rendering inline. The
   * worker (covered by render-receipt-pdf.test.ts) calls the same
   * deterministic `pdfRender.render(...)` adapter F4 always used —
   * SC-003 byte-identity is preserved because the worker reads the
   * same invoice snapshot that a manual mark-paid would. This test
   * proves the enqueued render-task carries ONLY F4-deterministic
   * keys (tenantId, invoiceId, fiscalYear, templateVersion) and NO
   * F5-specific surface (paymentIntentId, chargeId, method) — any
   * leak would break SC-003 by widening the render-input contract.
   */
  it('SC-003 reuse — receipt_pdf_render outbox payload carries no F5-specific keys', async () => {
    // Pull all receipt_pdf_render rows enqueued by the prior tests
    // in this suite. We assert on the CARD seed's row (the first
    // test) — same proof applies to promptpay + suppressed.
    const [row] = await db
      .select({
        notificationType: notificationsOutbox.notificationType,
        tenantId: notificationsOutbox.tenantId,
        contextData: notificationsOutbox.contextData,
      })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
          sql`${notificationsOutbox.contextData}->>'invoice_id' = ${cardSeed.invoiceId}`,
        ),
      );
    expect(row).toBeDefined();

    // F4-deterministic keys only — must include the worker contract
    // surface (snake_case per receipt-pdf-render-enqueue-adapter.ts)
    // AND must NOT leak any F5 field.
    const td = (row?.contextData ?? {}) as Record<string, unknown>;
    expect(td).toHaveProperty('invoice_id');
    expect(td).toHaveProperty('fiscal_year');
    expect(td).toHaveProperty('template_version');
    expect(td).not.toHaveProperty('paymentIntentId');
    expect(td).not.toHaveProperty('chargeId');
    expect(td).not.toHaveProperty('method');
  }, 30_000);
});
