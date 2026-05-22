/**
 * R3-S1 — record-payment Postgres rollback integration test.
 *
 * The unit-level rollback test (R1-CG-1 / R2-CG-1 in
 * `record-payment-async-pdf.test.ts`) uses an in-memory `opaqueTx`
 * mock that doesn't observe real commit/rollback semantics — it can
 * only prove the use-case propagates the error. This integration
 * test closes that gap by running on live Neon:
 *
 *   1. Seed an invoice in `status='issued'` (full snapshots).
 *   2. Mock `receiptPdfRenderEnqueueAdapter.enqueue` to throw.
 *   3. Call `recordPayment` via the real composition root
 *      (`makeRecordPaymentDeps`) under `runInTenant`.
 *   4. Assert the call rejects (error propagated).
 *   5. Re-read the invoice row → MUST still be `status='issued'`
 *      (Postgres rolled back the `applyPayment` UPDATE because the
 *      tx callback threw before commit).
 *   6. Assert NO `invoice_paid` audit row was committed.
 *
 * Without the real-tx observation, the use-case could in principle
 * be calling `applyPayment` outside the `withTx` callback (a refactor
 * mistake) — the unit test wouldn't catch this; only the live-DB
 * read of the post-throw state can.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import { receiptPdfRenderEnqueueAdapter } from '@/modules/invoicing/infrastructure/adapters/receipt-pdf-render-enqueue-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

async function seedIssuedInvoice(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ invoiceId: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `r3s1-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'R3-S1 Plan' },
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
        invoiceNumberPrefix: 'R3S1',
        creditNoteNumberPrefix: 'R3S1C',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'R3-S1 Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
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
      documentNumber: `R3S1-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
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
        legal_name: 'R3-S1 Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'R3-S1 Contact',
        primary_contact_email: 'r3s1@example.com',
      },
      pdfBlobKey: 'invoicing/test/r3s1.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership',
      unitPriceSatang: 1_000_000n,
      quantity: '1',
      proRateFactor: null,
      totalSatang: 1_000_000n,
      position: 1,
    });
  });
  return { invoiceId };
}

describe('R3-S1 — record-payment rollback observed on live Neon', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    // R4-I2 — defensive cleanup. afterEach restoreAll handles the
    // common case; this catches any straggler if a test crashed
    // before the per-test cleanup ran.
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  // R4-I2 — restore the spy after each test so a crash mid-test
  // doesn't leak the mocked enqueue into subsequent integration tests
  // (singleFork worker shares module state).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueue throws → recordPayment rejects + invoice stays issued + no invoice_paid audit committed', async () => {
    const { invoiceId } = await seedIssuedInvoice(tenant, user);

    // R4-I2 — `vi.spyOn` replaces in-place mutation. The spy is
    // tracked by Vitest's mock registry and restored automatically
    // by `vi.restoreAllMocks()` in afterEach/afterAll, so a crash
    // before the test's manual cleanup can't leak the mocked impl
    // to subsequent tests in the same singleFork worker.
    vi.spyOn(receiptPdfRenderEnqueueAdapter, 'enqueue').mockImplementation(
      async () => {
        throw new Error('R3-S1 simulated outbox insert failure');
      },
    );

    let thrown: unknown = null;
    try {
      await runInTenant(tenant.ctx, async () =>
        recordPayment(makeRecordPaymentDeps(tenant.ctx.slug), {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          invoiceId,
          paymentMethod: 'other',
          paymentDate: '2026-05-01',
          requestId: 'r3-s1-rollback',
        }),
      );
    } catch (e) {
      thrown = e;
    }

    // The error propagated out (use-case did NOT swallow). The exact
    // shape may be a wrapped TxAbort, the original Error, or a typed
    // err — what matters is something escaped, so Postgres rolled back.
    expect(thrown).not.toBeNull();

    // R3-S1 KEY ASSERTION — the invoice row stays in `issued`. If
    // `applyPayment` were running OUTSIDE the failing tx callback, the
    // status would be `paid` here despite the throw — proving rollback
    // didn't reach the payment write.
    const [invRow] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(invRow?.status).toBe('issued');
    expect(invRow?.paidAt).toBeNull();
    expect(invRow?.receiptPdfStatus).toBeNull();

    // No `invoice_paid` audit row should have committed for this invoice.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
        ),
      );
    const matched = auditRows.filter(
      (r) => (r.payload as { invoice_id?: string }).invoice_id === invoiceId,
    );
    expect(matched.length).toBe(0);
  }, 60_000);

  // F8 Phase 2 Wave A · D1 (verify-run remediation): real-DB proof that a
  // throwing `onPaidCallbacks` listener rolls back the issued→paid flip +
  // the invoice_paid audit row. The unit-level contract test
  // (`tests/contract/f4-on-paid-callbacks.contract.test.ts`) only proves
  // the use-case re-throws callback errors out of `withTx`; this closes
  // the gap by asserting the actual Postgres tx rollback semantics on
  // live Neon — same pattern + same key assertions as the enqueue case
  // above, but the throw point is now an F8-style cross-module callback.
  it('onPaidCallback throws → recordPayment rejects + invoice stays issued + no invoice_paid audit committed (F8 hook)', async () => {
    const { invoiceId } = await seedIssuedInvoice(tenant, user);

    let thrown: unknown = null;
    try {
      await runInTenant(tenant.ctx, async () =>
        recordPayment(
          makeRecordPaymentDeps(tenant.ctx.slug, undefined, [
            async () => {
              throw new Error(
                'D1 simulated F8 cross-module callback failure',
              );
            },
          ]),
          {
            tenantId: tenant.ctx.slug,
            actorUserId: user.userId,
            invoiceId,
            paymentMethod: 'other',
            paymentDate: '2026-05-01',
            requestId: 'wave-a-d1-callback-rollback',
          },
        ),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();

    // Same key assertion as R3-S1: the row MUST stay `issued` because
    // the callback ran inside the open `withTx` and the throw rolled
    // the entire transaction back. If the callback fired AFTER the tx
    // commit, the row would already be `paid` here.
    const [invRow] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(invRow?.status).toBe('issued');
    expect(invRow?.paidAt).toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
        ),
      );
    const matched = auditRows.filter(
      (r) => (r.payload as { invoice_id?: string }).invoice_id === invoiceId,
    );
    expect(matched.length).toBe(0);
  }, 60_000);
});
