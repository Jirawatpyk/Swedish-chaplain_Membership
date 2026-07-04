/**
 * 088-invoice-tax-flow-redesign — T071b [SC-012 / FR-030] Integration (live Neon):
 * the member timeline + AR/overdue surfaces handle an issued-unpaid ใบแจ้งหนี้
 * (document_number NULL) correctly.
 *
 * SC-012 has two limbs, both regression-guarded here:
 *
 *   (a) TIMELINE — after payment the member timeline shows a `tax_receipt_issued`
 *       entry carrying the §87 `RC` number, the bill's `invoice_issued` entry
 *       (the ใบแจ้งหนี้) exists exactly once, and the payment moment is not
 *       doubled (`invoice_paid` + `tax_receipt_issued` each fire once). Each
 *       event carries `member_id` so the F3/F9 member-timeline filter
 *       (`payload->>'member_id'`) surfaces it.
 *
 *   (b) AR / OVERDUE COUNT — an issued 088 bill has `document_number` NULL
 *       (the §87 pair is only minted at payment) yet MUST still be COUNTED by
 *       the status-based AR/overdue surfaces (never dropped by a
 *       `document_number IS NOT NULL` filter — the FR-030 defect class), and
 *       MUST DROP out of "overdue" once paid:
 *         - F9 AR: `invoiceSourceAdapter.countOverdue` (real production code) —
 *           status='issued' + `computeIsOverdue` (due-date based).
 *         - F8 at-risk `invoicesOverdueCount`: the exact production FILTER
 *           predicate `status='issued' AND created_at < NOW() - INTERVAL '30 days'`
 *           (mirrors `drizzle-at-risk-scorer.ts` + `drizzle-member-renewal-flags-repo.ts`).
 *
 * The bill is issued with a past clock so it is genuinely overdue at read-time,
 * and its `created_at` is back-dated 40 days so the F8 30-day predicate counts
 * it. PDF render + Blob upload are mocked (same pattern as
 * bill-to-receipt.integration.test.ts). `taxAtPayment: true` overrides the
 * default-OFF env flag so the new bill→RC flow runs.
 *
 * Migrations 0230 + 0231 + 0234 MUST be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
// Deep-import the F9 InvoiceSource adapter — the real production code behind the
// dashboard "overdue invoices" needs-attention count (compute-dashboard-snapshot
// → invoiceSource.countOverdue). Not re-exported from the insights barrel; the
// integration test reaches the adapter directly (same posture as the Drizzle
// repos other integration suites import).
import { invoiceSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-source-adapter';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
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

// Issue far enough in the past that the bill is overdue at REAL read-time
// (`countOverdue` uses `new Date()`), whatever the tenant's net-days / fiscal
// start; pay before real-today so record-payment's date clamp is satisfied.
const ISSUE_NOW = '2026-01-15T09:00:00Z';
const PAY_NOW = '2026-06-15T09:00:00Z';
const PAYMENT_DATE = '2026-06-15';

function mockPdfBlob(captured?: PdfRenderInput[]) {
  return {
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        captured?.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDepsFlagOn(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => ISSUE_NOW },
    taxAtPayment: 'on',
  };
}

function recordDepsFlagOn(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => PAY_NOW },
    taxAtPayment: 'on',
    // Force the SYNCHRONOUS receipt render so the RC + tax_receipt_issued land
    // in-tx deterministically (this dev env has async receipt PDF on).
    asyncReceiptPdf: false,
  };
}

/** Production F8 at-risk `invoicesOverdueCount` predicate (verbatim from
 *  drizzle-at-risk-scorer.ts:~148 / drizzle-member-renewal-flags-repo.ts:~570).
 *  Explicit tenant_id + member_id filter — matches the production LATERAL join. */
async function f8OverdueCount(ctx: TestTenant['ctx'], memberId: string): Promise<number> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx.execute<{ overdue_count: string }>(sql`
      SELECT count(*) FILTER (
        WHERE status = 'issued'
          AND created_at < NOW() - INTERVAL '30 days'
      )::text AS overdue_count
      FROM invoices
      WHERE tenant_id = ${ctx.slug}
        AND member_id = ${memberId}
    `);
    return Number(rows[0]!.overdue_count);
  });
}

describe('088 T071b — timeline + AR/overdue regression for a document_number-NULL bill (live Neon, SC-012)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'timeline-ar-plan';
  const planYear = 2026;
  let memberId: string;
  let invoiceId: string;
  let billNumber: string;
  let receiptNumber: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Timeline/AR Plan' },
        description: { en: 'Plan for the 088 timeline+AR regression test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
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
        companyName: 'Timeline AR Member Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Timeline',
        lastName: 'Contact',
        email: 'timeline.contact@ar.example',
        isPrimary: true,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function readRow(id: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, id)));
    return row;
  }

  it('issues an overdue 088 bill (document_number NULL) that the AR + at-risk counts still include', async () => {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `tar-draft-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    invoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `tar-issue-${invoiceId}`,
      invoiceId,
    });
    expect(issued.ok, issued.ok ? 'ok' : `issue err: ${JSON.stringify(issued)}`).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const billRow = await readRow(invoiceId);
    expect(billRow!.status).toBe('issued');
    // The defect class: an issued bill carries its SC number with the §87 pair
    // NULL. A surface that keys on `document_number` would treat it as a draft.
    expect(billRow!.billDocumentNumberRaw).toMatch(/^SC-\d{4}-\d{6}$/);
    expect(billRow!.documentNumber).toBeNull();
    expect(billRow!.sequenceNumber).toBeNull();
    billNumber = billRow!.billDocumentNumberRaw!;

    // Back-date created_at so the F8 30-day overdue predicate counts the bill.
    // created_at is not in the immutability lock list → the UPDATE is permitted
    // on a non-draft row.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({ createdAt: sql`NOW() - INTERVAL '40 days'` })
        .where(eq(invoices.invoiceId, invoiceId)),
    );

    // (b) AR / overdue counts include the document_number-NULL bill.
    // Fresh tenant → the ONLY issued invoice is this bill, so the counts are
    // deterministic 1.
    const f9Overdue = await invoiceSourceAdapter.countOverdue(tenant.ctx);
    expect(f9Overdue).toBe(1);
    const f8Overdue = await f8OverdueCount(tenant.ctx, memberId);
    expect(f8Overdue).toBe(1);
  }, 90_000);

  it('paying mints the RC, drops the bill from both overdue counts, and does not double the timeline', async () => {
    const paid = await recordPayment(recordDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `tar-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok, paid.ok ? 'ok' : `pay err: ${JSON.stringify(paid)}`).toBe(true);
    if (!paid.ok) throw new Error('pay failed');

    const paidRow = await readRow(invoiceId);
    expect(paidRow!.status).toBe('paid');
    expect(paidRow!.receiptDocumentNumberRaw).toMatch(/^RC-\d{4}-\d{6}$/);
    // The bill number survives; the §87 invoice pair is NEVER filled (SC-001/003).
    expect(paidRow!.billDocumentNumberRaw).toBe(billNumber);
    expect(paidRow!.documentNumber).toBeNull();
    receiptNumber = paidRow!.receiptDocumentNumberRaw!;

    // (b) once paid, the bill drops out of BOTH overdue counts.
    const f9Overdue = await invoiceSourceAdapter.countOverdue(tenant.ctx);
    expect(f9Overdue).toBe(0);
    const f8Overdue = await f8OverdueCount(tenant.ctx, memberId);
    expect(f8Overdue).toBe(0);

    // (a) TIMELINE — the bill's `invoice_issued` fired once (at issue).
    const issuedEvents = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_issued'),
          eq(auditLog.requestId, `tar-issue-${invoiceId}`),
        ),
      );
    expect(issuedEvents).toHaveLength(1);
    expect((issuedEvents[0]!.payload as Record<string, unknown>).member_id).toBe(memberId);

    // The payment moment is not doubled: `invoice_paid` once …
    const paidEvents = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
          eq(auditLog.requestId, `tar-pay-${invoiceId}`),
        ),
      );
    expect(paidEvents).toHaveLength(1);

    // … and exactly one `tax_receipt_issued` carrying the RC number + member_id.
    const taxReceiptEvents = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tax_receipt_issued'),
          eq(auditLog.requestId, `tar-pay-${invoiceId}`),
        ),
      );
    expect(taxReceiptEvents).toHaveLength(1);
    const payload = taxReceiptEvents[0]!.payload as Record<string, unknown>;
    expect(payload.receipt_document_number_raw).toBe(receiptNumber);
    expect(payload.member_id).toBe(memberId);
  }, 90_000);
});
