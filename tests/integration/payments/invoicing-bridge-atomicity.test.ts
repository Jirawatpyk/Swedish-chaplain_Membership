/**
 * T066 integration — InvoicingBridge atomicity (D-03 CLOSED).
 *
 * Exercises the F5 → F4 bridge against live Neon and asserts the
 * atomicity invariant is now preserved end-to-end.
 *
 * Two scenarios:
 *
 *   1. **Happy path** — bridge.getInvoiceForPayment returns the DTO;
 *      bridge.markPaidFromProcessor (no-tx) flips status to 'paid'.
 *      This asserts the wire-up through F4's public barrel works.
 *
 *   2. **D-03 atomicity** — call bridge.markPaidFromProcessor(tx) from
 *      inside an F5-owned runInTenant tx and force a rollback by
 *      throwing after the bridge call returns. F4 now reuses the
 *      caller's tx (Group E2b), so the rollback unwinds BOTH F5's
 *      payment row writes AND the F4 invoice `issued → paid` flip.
 *      Post-rollback we observe status='issued'. Previously pinned
 *      the D-03 gap (status='paid' after rollback); inverted here.
 *
 * Mocking policy: render/blob/outbox mocked (same as F4's
 * processor-bridge.test.ts) — the system under test is the bridge
 * composition + DB persistence, not the PDF/email round-trip.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments/domain/system-actors';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// Stub render/blob/outbox — same pattern as F4 processor-bridge.test.ts.
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
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    getSignedReadUrl: vi.fn(async () => 'https://blob.test/signed'),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: {
    enqueue: vi.fn(async () => undefined),
  },
}));

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

describe('InvoicingBridge (F5 → F4) — live Neon', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /**
   * Seed a parent chain + ISSUED invoice, ready for the bridge to mark
   * paid. Returns the fresh invoiceId.
   */
  async function seedIssuedInvoice(): Promise<{
    invoiceId: string;
    memberId: string;
  }> {
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    const planId = `plan-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Test Plan' },
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
        companyName: 'Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      // Upsert — settings/sequences may already exist from a prior test
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
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'issued',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `T-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
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
          legal_name: 'Test Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'Test Contact',
          // Valid zod email (TLD ≥ 2 chars) — `n@n.n` failed validation
          // after the repo-boundary zod guard landed in commit 9b1b374.
          primary_contact_email: 'test@example.com',
        },
        pdfBlobKey: 'invoices/test.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership fee',
        unitPriceSatang: 1_000_000n,
        quantity: '1',
        proRateFactor: null,
        totalSatang: 1_000_000n,
        position: 1,
      });
    });

    return { invoiceId, memberId };
  }

  it('happy path: getInvoiceForPayment + markPaidFromProcessor flip invoice to paid', async () => {
    const { invoiceId } = await seedIssuedInvoice();

    const dto = await invoicingBridge.getInvoiceForPayment({
      tenantId: tenant.ctx.slug,
      invoiceId,
    });
    expect(dto.ok).toBe(true);
    if (!dto.ok) return;
    expect(dto.value.id).toBe(invoiceId);
    expect(dto.value.status).toBe('issued');
    expect(dto.value.totalSatang).toBe(1_070_000n);

    const paid = await invoicingBridge.markPaidFromProcessor({
      tenantId: tenant.ctx.slug,
      invoiceId,
      requestId: 'req-bridge-happy',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      method: 'stripe_card',
      paymentIntentId: 'pi_test_bridge_happy',
      chargeId: 'ch_test_bridge_happy',
      settlementDate: '2026-04-10',
    });
    expect(paid.ok).toBe(true);

    const [row] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      );
    expect(row?.status).toBe('paid');
  });

  it('D-03 atomicity: F4 reuses F5 tx, so markPaid rolls back when F5 outer tx rolls back', async () => {
    const { invoiceId } = await seedIssuedInvoice();

    // Simulate the F5 use-case pattern: start an F5-owned runInTenant tx,
    // call the bridge with `tx`, then throw to trigger rollback. With
    // D-03 closed, F4's invoice-repo short-circuits its own `withTx` to
    // inline execution against the passed tx — so when the outer tx
    // rolls back, BOTH F5's payment-row update AND F4's invoice flip
    // to `paid` are reverted together.
    await expect(
      runInTenant(tenant.ctx, async (tx) => {
        const r = await invoicingBridge.markPaidFromProcessor(
          {
            tenantId: tenant.ctx.slug,
            invoiceId,
            requestId: 'req-d03-rollback',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            method: 'stripe_card',
            paymentIntentId: 'pi_test_d03_rollback',
            chargeId: 'ch_test_d03_rollback',
            settlementDate: '2026-04-11',
          },
          tx, // <-- D-03 closed: F4 reuses this tx
        );
        expect(r.ok).toBe(true);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const [row] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      );

    // D-03 closed: F4 inline-ran against F5's tx, so rollback reverts
    // the invoice `issued → paid` flip. Previously pinned as 'paid'
    // (the gap); inverted in Group E2b.
    expect(row?.status).toBe('issued');
  });

  /**
   * F5R1-T3 — F5 → F4 callback FAILURE direction.
   *
   * The D-03 atomicity test above proves the symmetric direction
   * (F5 outer tx fails → F4 invoice flip rolls back). T3 is the
   * complement: F4 returns ERR (e.g., the invoice doesn't exist
   * under the actor's tenant — RLS-cloaked or genuinely missing)
   * → the F5 caller MUST see a typed `Result.err` with the F4
   * error summarised by `summariseF4Error` into the stable
   * `{ code, detail }` shape, AND no F4-side row mutation lands.
   *
   * Pre-T3 the regression risk was: a future change to the bridge
   * adapter's error mapping (e.g., catching + swallowing the F4
   * error to "be helpful") would silently turn a failed callback
   * into a no-op success, leaving the F5 payment row succeeded but
   * the F4 invoice still issued — a SC-013 invariant break (no
   * succeeded-payment-without-paid-invoice).
   */
  it('F5R1-T3: F4 returns err → bridge surfaces typed { code, detail } + no DB mutation', async () => {
    // Use a random invoice id that doesn't exist in the tenant's
    // invoices table. F4's `markPaidFromProcessor` resolves the
    // invoice via the repo and returns an error variant when it
    // misses (`invoice_not_found` or similar — the exact code lives
    // inside F4 and is intentionally treated as opaque here; T3
    // pins the BRIDGE-LAYER contract, not the F4-internal error
    // taxonomy).
    const missingInvoiceId = randomUUID();

    // Capture the pre-call state of `invoices` rows for the tenant
    // so we can assert the failure path doesn't accidentally INSERT
    // a row (defence-in-depth: a bug that swallows the F4 error
    // could also create a stub row).
    const preRows = await db
      .select({ id: invoices.invoiceId })
      .from(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug));
    const preRowIds = new Set(preRows.map((r) => r.id));

    const result = await invoicingBridge.markPaidFromProcessor({
      tenantId: tenant.ctx.slug,
      invoiceId: missingInvoiceId,
      requestId: 'req-t3-callback-failure',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      method: 'stripe_card',
      paymentIntentId: 'pi_test_t3_callback_failure',
      chargeId: 'ch_test_t3_callback_failure',
      settlementDate: '2026-05-16',
    });

    // 1. Bridge must surface a typed err — never an ok with the
    //    invoice still issued.
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // 2. Stable `{ code, detail }` shape (per `summariseF4Error`
    //    contract in `invoicing-bridge.ts`). Both fields must be
    //    non-empty strings; PII-leak protection (the helper drops
    //    everything except scalar string fields on the discriminator).
    expect(typeof result.error.code).toBe('string');
    expect(result.error.code.length).toBeGreaterThan(0);
    expect(typeof result.error.detail).toBe('string');
    expect(result.error.detail.length).toBeGreaterThan(0);
    // Must NOT contain a JSON.stringify dump of the F4 error (the
    // pre-#16-fix behaviour leaked PII into F5 audit summaries).
    expect(result.error.detail).not.toMatch(/^\{.*\}$/);

    // 3. The missing invoice id must NOT have been inserted as a
    //    side-effect of the failed callback.
    const postRows = await db
      .select({ id: invoices.invoiceId })
      .from(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug));
    expect(postRows.map((r) => r.id)).toEqual(
      expect.arrayContaining([...preRowIds]),
    );
    expect(postRows.find((r) => r.id === missingInvoiceId)).toBeUndefined();
  });
});
