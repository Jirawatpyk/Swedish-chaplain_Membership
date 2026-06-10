/**
 * R1-CG-2 — Receipt PDF reconcile cron integration test.
 *
 * Verifies the full cron contract on live Neon:
 *   (1) attempts < MAX (3) → re-enqueues a fresh `receipt_pdf_render`
 *       outbox row under the row's tenant context.
 *   (2) attempts >= MAX → emits `pdf_render_permanently_failed` audit
 *       row (does NOT re-enqueue).
 *   (3) Dedupe by `payload->>'invoice_id'` — second cron tick on an
 *       already-alerted invoice MUST NOT re-emit the audit (single
 *       page-on-call signal per exhausted invoice).
 *
 * R1-I2 — also pins that the dedupe query runs INSIDE runInTenant so
 * RLS on audit_log resolves to the row's tenant. Pre-fix, this query
 * ran outside the tenant context; on a project that enforces RLS on
 * audit_log it returned zero rows every tick → re-page every 5 min.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { db, runInTenant } from '@/lib/db';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as reconcileCron } from '@/app/api/internal/cron/receipt-pdf-reconcile/route';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', () => ({
  reactPdfRenderAdapter: { render: vi.fn() },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(),
    signDownloadUrl: vi.fn(async (key: string) => `https://blob.test/${key}`),
    delete: vi.fn(),
    list: vi.fn(async () => []),
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

async function seedFailedInvoice(
  tenant: TestTenant,
  user: TestUser,
  attempts: number,
): Promise<{ invoiceId: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `r1cg2-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'R1-CG-2 Plan' },
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
        invoiceNumberPrefix: 'RC',
        creditNoteNumberPrefix: 'RCC',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'R1-CG-2 Co',
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
      status: 'paid',
      pdfDocKind: 'invoice',
      draftByUserId: user.userId,
      fiscalYear: 2026,
      sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
      documentNumber: `RC-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      paidAt: new Date(),
      paymentMethod: 'other',
      paymentDate: '2026-05-01',
      paymentRecordedByUserId: user.userId,
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
        legal_name: 'R1-CG-2 Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'CG2 Contact',
        primary_contact_email: 'cg2@example.com',
      },
      pdfBlobKey: 'invoicing/test/r1cg2.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      receiptPdfStatus: 'failed',
      receiptPdfRenderAttempts: attempts,
      receiptPdfLastError: 'simulated render error',
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

/**
 * review-20260428-102639.md B3 closure — seed an orphaned `pending`
 * invoice. updatedAt is forced to >1 hour in the past so the cron's
 * stuck-pending sweep query (`status='pending' AND updatedAt < now() -
 * interval '1 hour'`) picks it up.
 */
async function seedStuckPendingInvoice(
  tenant: TestTenant,
  user: TestUser,
  attempts: number,
): Promise<{ invoiceId: string }> {
  const result = await seedFailedInvoice(tenant, user, attempts);
  await runInTenant(tenant.ctx, async (tx) => {
    await tx
      .update(invoices)
      .set({
        receiptPdfStatus: 'pending',
        receiptPdfLastError: null,
        updatedAt: sql`now() - interval '2 hours'`,
      })
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, result.invoiceId),
        ),
      );
  });
  return result;
}

async function callCron(): Promise<Response> {
  const req = new NextRequest(
    'http://localhost/api/internal/cron/receipt-pdf-reconcile',
    { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
  );
  return reconcileCron(req);
}

describe('R1-CG-2 — receipt PDF reconcile cron', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  // R4-I2 pattern — restore spies after each test so a crash mid-run
  // doesn't leak the mocked enqueue into subsequent tests.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attempts<3 → re-enqueues a fresh receipt_pdf_render outbox row under tenant context', async () => {
    const { invoiceId } = await seedFailedInvoice(tenant, user, 1);

    const before = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
        ),
      );

    const resp = await callCron();
    expect(resp.status).toBe(200);
    // review-20260428-102639.md W13 closure — `body.reEnqueued` is a
    // global cross-tenant count and can be inflated by test-suite
    // leftovers. Assert exact match on this invoice's outbox rows
    // instead.
    await resp.json();

    const after = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
          eq(notificationsOutbox.status, 'pending'),
        ),
      );
    // Exactly one new pending row should land for our invoice.
    const matchedNew = after.filter(
      (r) =>
        (r.contextData as { invoice_id?: string }).invoice_id === invoiceId &&
        !before.some((b) => b.id === r.id),
    );
    expect(matchedNew.length).toBe(1);
  }, 60_000);

  it('attempts>=3 → emits pdf_render_permanently_failed audit (does NOT re-enqueue)', async () => {
    const { invoiceId } = await seedFailedInvoice(tenant, user, 3);

    const resp = await callCron();
    expect(resp.status).toBe(200);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'pdf_render_permanently_failed'),
        ),
      );
    const matched = auditRows.filter(
      (r) => (r.payload as { invoice_id?: string }).invoice_id === invoiceId,
    );
    expect(matched.length).toBe(1);
  }, 60_000);

  it('dedupe — second cron tick on already-alerted exhausted row does NOT re-emit', async () => {
    const { invoiceId } = await seedFailedInvoice(tenant, user, 3);

    // First tick — emits the alert.
    await callCron();
    // Second tick — must NOT emit a second one (R1-I2 dedupe inside
    // runInTenant ensures RLS sees the existing row).
    await callCron();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'pdf_render_permanently_failed'),
        ),
      );
    const matched = auditRows.filter(
      (r) => (r.payload as { invoice_id?: string }).invoice_id === invoiceId,
    );
    expect(matched.length).toBe(1);
  }, 90_000);

  // R5-C1 — atomicity regression. Reconcile re-enqueue path does TWO
  // writes (status flip 'failed'→'pending' + outbox INSERT). Both
  // MUST commit/rollback as a single Postgres tx via the `tx` handle
  // threaded through `runInTenant`. Pre-R5-C1 fix used bare `db`
  // for both writes — auto-commit independently → if outbox INSERT
  // throws, status flip stays committed → next reconcile filter
  // (`WHERE status='failed'`) misses the orphaned 'pending' row →
  // silent data loss.
  //
  // This test patches the enqueue adapter to throw on the next call.
  // Then asserts the invoice's `receipt_pdf_status` STAYED at
  // 'failed' (rolled back), not 'pending'.
  it('R5-C1 atomicity — enqueue throw rolls back the status flip (no orphan pending)', async () => {
    const { invoiceId } = await seedFailedInvoice(tenant, user, 1);

    // R4-I2 pattern — vi.spyOn restored automatically by afterEach.
    const { receiptPdfRenderEnqueueAdapter } = await import(
      '@/modules/invoicing/infrastructure/adapters/receipt-pdf-render-enqueue-adapter'
    );
    vi.spyOn(
      receiptPdfRenderEnqueueAdapter,
      'enqueue',
    ).mockImplementationOnce(async () => {
      throw new Error('R5-C1 simulated outbox INSERT failure');
    });

    // The cron handler catches per-row exceptions → still returns 200.
    const resp = await callCron();
    expect(resp.status).toBe(200);

    // The invoice's receipt_pdf_status MUST still be 'failed' (the
    // status flip was rolled back when enqueue threw inside the same
    // Postgres tx). Pre-R5-C1 fix this would have been 'pending'.
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
    expect(invRow?.receiptPdfStatus).toBe('failed');
  }, 60_000);

  // R5-C1 sibling — happy path verification: both writes succeed
  // together → status='pending', outbox row inserted, both visible.
  it('R5-C1 atomicity — happy path: both writes commit together', async () => {
    const { invoiceId } = await seedFailedInvoice(tenant, user, 1);

    const resp = await callCron();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reEnqueued: number };
    expect(body.reEnqueued).toBeGreaterThanOrEqual(1);

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
    // Status flipped to 'pending' (worker will pick up next).
    expect(invRow?.receiptPdfStatus).toBe('pending');
    // last_error cleared.
    expect(invRow?.receiptPdfLastError).toBeNull();

    const outboxRows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
        ),
      );
    const matchedOutbox = outboxRows.filter(
      (r) =>
        (r.contextData as { invoice_id?: string }).invoice_id === invoiceId &&
        r.status === 'pending',
    );
    expect(matchedOutbox.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // review-20260428-102639.md B3 closure — orphan-pending sweep.
  it('stuck-pending sweep — pending row >1h old is re-enqueued (orphan recovery)', async () => {
    const { invoiceId } = await seedStuckPendingInvoice(tenant, user, 0);

    const resp = await callCron();
    expect(resp.status).toBe(200);

    const outboxRows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
        ),
      );
    const matchedOutbox = outboxRows.filter(
      (r) =>
        (r.contextData as { invoice_id?: string }).invoice_id === invoiceId &&
        r.status === 'pending',
    );
    // Exactly one fresh outbox row should be enqueued for this invoice.
    expect(matchedOutbox.length).toBe(1);

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
    // Status remains 'pending' but updatedAt is bumped (orphan window
    // resets) so a second cron tick within 1h won't pick it up again.
    expect(invRow?.receiptPdfStatus).toBe('pending');
  }, 60_000);

  it('stuck-pending sweep — pending row <1h old is NOT picked up', async () => {
    // Seed a pending row with updatedAt ~now (no orphan); should not
    // be touched by the cron (mirrors normal in-flight worker state).
    const { invoiceId } = await seedFailedInvoice(tenant, user, 0);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(invoices)
        .set({
          receiptPdfStatus: 'pending',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, invoiceId),
          ),
        );
    });

    await callCron();

    const outboxRows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'receipt_pdf_render'),
        ),
      );
    const matchedOutbox = outboxRows.filter(
      (r) =>
        (r.contextData as { invoice_id?: string }).invoice_id === invoiceId,
    );
    expect(matchedOutbox.length).toBe(0);
  }, 60_000);
});
