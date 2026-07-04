/**
 * 088-invoice-tax-flow-redesign — US1 carry-forward invariants (live Neon),
 * requested by the drizzle-migration-reviewer for migrations 0230/0231:
 *
 *  1. IMMUTABILITY — `bill_document_number_raw` is locked once the row is
 *     non-draft: an UPDATE on an issued bill raises (incl. under
 *     `SET LOCAL app.allow_pii_redaction='true'` — the bill number is NOT a
 *     redaction-exempt column).
 *  2. CROSS-TENANT — the per-tenant partial unique indexes let tenant A and
 *     tenant B BOTH hold `SC-2026-000001`, with no collision; RLS keeps A from
 *     reading B's row (tenant isolation, Constitution I).
 *  3. LEGACY NO-REGRESSION + FR-017 — a legacy §87-numbered row (issued under
 *     the flag-off flow, no bill number) still passes the widened CHECKs; paying
 *     it in the new flow is REJECTED (`legacy_invoice_needs_reissue`) so it can
 *     never carry two §87 numbers.
 *
 * REAL allocator + repo + audit; PDF/Blob mocked. Migrations 0230 + 0231 first.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TaxAtPaymentFlag } from '@/modules/invoicing';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
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

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PLAN_ID = 'invariants-plan';
const PLAN_YEAR = 2026;

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_i: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
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
function issueDeps(slug: string, taxAtPayment: TaxAtPaymentFlag) {
  return { ...makeIssueInvoiceDeps(slug), ...mockPdfBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment };
}
function recordDeps(slug: string, taxAtPayment: TaxAtPaymentFlag) {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment,
    asyncReceiptPdf: false,
  };
}

async function seedTenant(): Promise<{ tenant: TestTenant; user: TestUser; memberId: string }> {
  const user = await createActiveTestUser('admin');
  const tenant = await createTestTenant('test-swecham');
  const memberId = randomUUID();
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
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      planName: { en: 'Invariants Plan' },
      description: { en: 'Plan for the 088 numbering-invariants test' },
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
      companyName: `Invariants Member ${memberId.slice(0, 8)}`,
      country: 'TH',
      taxId: '9999999999999',
      addressLine1: '99 Rama IV Road',
      city: 'Sathon',
      province: 'Bangkok',
      postalCode: '10120',
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Inv',
      lastName: 'Member',
      email: `inv.${memberId.slice(0, 8)}@member.example`,
      isPrimary: true,
    });
  });
  return { tenant, user, memberId };
}

async function issueBill(t: { tenant: TestTenant; user: TestUser; memberId: string }, taxAtPayment: TaxAtPaymentFlag): Promise<string> {
  const slug = t.tenant.ctx.slug;
  const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(slug), {
    tenantId: slug,
    actorUserId: t.user.userId,
    requestId: `inv-draft-${t.memberId}`,
    memberId: t.memberId,
    planId: PLAN_ID,
    planYear: PLAN_YEAR,
  });
  if (!draft.ok) throw new Error(`draft: ${draft.error.code}`);
  const invoiceId = draft.value.invoiceId;
  const issued = await issueInvoice(issueDeps(slug, taxAtPayment), {
    tenantId: slug,
    actorUserId: t.user.userId,
    requestId: `inv-issue-${invoiceId}`,
    invoiceId,
  });
  if (!issued.ok) throw new Error(`issue: ${JSON.stringify(issued)}`);
  return invoiceId;
}

describe('088 US1 — bill/receipt numbering invariants (live Neon)', () => {
  const created: TestTenant[] = [];
  afterAll(async () => {
    for (const t of created) await t.cleanup().catch(() => {});
  });

  it('immutability — bill_document_number_raw is locked on an issued row (even under the redaction GUC)', async () => {
    const t = await seedTenant();
    created.push(t.tenant);
    const slug = t.tenant.ctx.slug;
    const invoiceId = await issueBill(t, 'on');

    // Normal UPDATE → rejected by invoices_enforce_immutability.
    await expect(
      runInTenant(t.tenant.ctx, (tx) =>
        tx.execute(
          sql`UPDATE invoices SET bill_document_number_raw = 'SC-2026-999999'
              WHERE tenant_id = ${slug} AND invoice_id = ${invoiceId}`,
        ),
      ),
    ).rejects.toThrow();

    // Under the PII-redaction GUC it is STILL locked (bill number is not an
    // exempt column, unlike member_identity_snapshot / pii_blob_purged_at).
    await expect(
      runInTenant(t.tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(
          sql`UPDATE invoices SET bill_document_number_raw = 'SC-2026-888888'
              WHERE tenant_id = ${slug} AND invoice_id = ${invoiceId}`,
        );
      }),
    ).rejects.toThrow();

    // The bill number is unchanged.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.billDocumentNumberRaw).toMatch(/^SC-2026-\d{6}$/);
    expect(row!.billDocumentNumberRaw).not.toBe('SC-2026-999999');
  }, 90_000);

  it('cross-tenant — tenant A and B both hold SC-2026-000001 with no collision + RLS isolation', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    created.push(a.tenant, b.tenant);

    const aInvoice = await issueBill(a, 'on');
    const bInvoice = await issueBill(b, 'on');

    const [aRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, a.tenant.ctx.slug), eq(invoices.invoiceId, aInvoice)));
    const [bRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, b.tenant.ctx.slug), eq(invoices.invoiceId, bInvoice)));

    // First bill in each tenant's FY-2026 → the SAME SC number, no collision
    // (the partial unique index is per-tenant).
    expect(aRow!.billDocumentNumberRaw).toBe('SC-2026-000001');
    expect(bRow!.billDocumentNumberRaw).toBe('SC-2026-000001');

    // RLS — tenant A cannot read tenant B's bill row through A's tenant context.
    const leaked = await runInTenant(a.tenant.ctx, (tx) =>
      tx
        .select({ id: invoices.invoiceId })
        .from(invoices)
        .where(eq(invoices.invoiceId, bInvoice)),
    );
    expect(leaked).toHaveLength(0);
  }, 120_000);

  it('legacy no-regression + FR-017 — a legacy §87 row passes the CHECKs but the new-flow pay path rejects it', async () => {
    const t = await seedTenant();
    created.push(t.tenant);
    const slug = t.tenant.ctx.slug;

    // Issue under the LEGACY flow (flag off) → §87 invoice number, no bill
    // number. The issue succeeding proves the widened non-draft CHECK still
    // accepts a pre-088 §87-numbered row (no regression).
    const invoiceId = await issueBill(t, 'off');
    const [legacyRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, invoiceId)));
    expect(legacyRow!.status).toBe('issued');
    expect(legacyRow!.sequenceNumber).not.toBeNull();
    expect(legacyRow!.documentNumber).toMatch(/^SC-2026-\d{6}$/);
    expect(legacyRow!.billDocumentNumberRaw).toBeNull();

    // Paying it under the NEW flow (flag on) is REJECTED — otherwise it would
    // mint a 2nd §87 number (the RC) on top of the legacy §87 invoice number.
    const paid = await recordPayment(recordDeps(slug, 'on'), {
      tenantId: slug,
      actorUserId: t.user.userId,
      requestId: `inv-legacy-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: '2026-07-01',
    });
    expect(paid.ok).toBe(false);
    if (paid.ok) throw new Error('expected legacy_invoice_needs_reissue');
    expect(paid.error.code).toBe('legacy_invoice_needs_reissue');

    // The row is untouched (still issued, no receipt number burned).
    const [afterRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, invoiceId)));
    expect(afterRow!.status).toBe('issued');
    expect(afterRow!.receiptDocumentNumberRaw).toBeNull();
  }, 90_000);

  it('immutability — receipt_document_number_raw (§87 RC) is frozen once minted (even under the redaction GUC)', async () => {
    // 088 INFO / migration 0235 — the §87 RC number must be immutable on a paid
    // row, symmetric with bill_document_number_raw / document_number. The
    // NULL→RC write at payment is permitted; every subsequent change rejects.
    const t = await seedTenant();
    created.push(t.tenant);
    const slug = t.tenant.ctx.slug;
    const invoiceId = await issueBill(t, 'on');

    const paid = await recordPayment(recordDeps(slug, 'on'), {
      tenantId: slug,
      actorUserId: t.user.userId,
      requestId: `inv-freeze-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: '2026-07-01',
    });
    expect(paid.ok, paid.ok ? 'ok' : JSON.stringify(paid)).toBe(true);
    if (!paid.ok) throw new Error('pay failed');
    const rc = paid.value.receiptDocumentNumberRaw;
    expect(rc).toMatch(/^RC-2026-\d{6}$/);

    // Normal UPDATE of the minted RC → rejected.
    await expect(
      runInTenant(t.tenant.ctx, (tx) =>
        tx.execute(
          sql`UPDATE invoices SET receipt_document_number_raw = 'RC-2026-999999'
              WHERE tenant_id = ${slug} AND invoice_id = ${invoiceId}`,
        ),
      ),
    ).rejects.toThrow();

    // Under the PII-redaction GUC it is STILL frozen (an RC is a §87 tax number,
    // not redactable PII).
    await expect(
      runInTenant(t.tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(
          sql`UPDATE invoices SET receipt_document_number_raw = 'RC-2026-888888'
              WHERE tenant_id = ${slug} AND invoice_id = ${invoiceId}`,
        );
      }),
    ).rejects.toThrow();

    // Unchanged.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.receiptDocumentNumberRaw).toBe(rc);
  }, 90_000);
});
