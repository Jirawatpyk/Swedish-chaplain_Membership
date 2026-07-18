/**
 * T098 — Void-invoice integration test (F4 / US5 Phase 9).
 *
 * Covers US5 AS1–AS3 + FR-036 cancellation-outbox enqueue:
 *  - Happy path: issued → void transitions cleanly, PDF re-uploaded
 *    (allowOverwrite=true), pdf_sha256 flipped to the re-rendered
 *    value, audit row emitted with `member_id`, cancellation outbox
 *    row enqueued when `auto_email_on_issue` resolves true.
 *  - Refusals: paid → `invalid_status` (admin directed to CN); void
 *    → `invalid_status` (re-void blocked); no mutation in either case.
 *  - Cross-tenant probe audit on RLS-hidden / truly-missing invoice.
 *  - Void KEEPS the sequential number; a later issue in the same
 *    fiscal year takes the NEXT number (no reuse, §87 no-gap).
 *
 * Uses live Neon Singapore via `runInTenant`. PDF/Blob/outbox mocked
 * to keep the test fast; DB + RLS + audit are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { voidInvoice } from '@/modules/invoicing/application/use-cases/void-invoice';
import type { VoidInvoiceDeps } from '@/modules/invoicing/application/use-cases/void-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
// 064 W1 S32 — direct-insert legacy event fixture (non-member void path).
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Void Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};
const ORIGINAL_SHA = 'a'.repeat(64);
const RERENDERED_SHA = 'b'.repeat(64);
// 088 T068 — distinct receipt shas so a two-blob void proves BOTH the bill
// `pdf_sha256` (RERENDERED_SHA) AND the receipt `receipt_pdf_sha256`
// (RERENDERED_RECEIPT_SHA) changed off their originals.
const RECEIPT_SHA = 'd'.repeat(64);
const RERENDERED_RECEIPT_SHA = 'e'.repeat(64);
const ORIGINAL_BLOB_KEY = 'invoicing/x/2026/seed.pdf';

async function seedInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  status: 'issued' | 'paid' | 'void',
  sequenceNumber = 1,
  autoEmail: boolean | null = true,
): Promise<{ invoiceId: string; memberId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Void Test Co',
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
      draftByUserId: user.userId,
      status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber,
      documentNumber: `VDIT-2026-${String(sequenceNumber).padStart(6, '0')}`,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: autoEmail,
      pdfBlobKey: ORIGINAL_BLOB_KEY,
      pdfSha256: ORIGINAL_SHA,
      pdfTemplateVersion: 1,
      paymentMethod: status === 'paid' ? 'bank_transfer' : null,
      paymentReference: status === 'paid' ? 'seed-ref' : null,
      paymentRecordedByUserId: status === 'paid' ? user.userId : null,
      paymentDate: status === 'paid' ? '2026-02-01' : null,
      paidAt: status === 'paid' ? new Date('2026-02-01T03:00:00Z') : null,
      // T166 — migration 0056 CHECK `invoices_paid_has_receipt_status`
      // requires paid invoices to carry a non-null receipt_pdf_status.
      // Seed as 'rendered' (the steady-state for paid + receipt-emailed
      // rows) so void-on-paid tests don't trip the constraint.
      receiptPdfStatus: status === 'paid' ? 'rendered' : null,
      voidedAt: status === 'void' ? new Date('2026-03-01T03:00:00Z') : null,
      voidReason: status === 'void' ? 'seed void' : null,
      voidedByUserId: status === 'void' ? user.userId : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return { invoiceId, memberId };
}

/**
 * 088 T068 — seed a NEW-FLOW row (FEATURE_088_TAX_AT_PAYMENT shape):
 *  - `kind: 'bill'`         → ISSUED ใบแจ้งหนี้ bill (documentNumber NULL, SC
 *                             bill number, ONE blob).
 *  - `kind: 'paid2'`        → PAID membership with a DISTINCT §86/4 receipt blob
 *                             (bill `pdf` + separate `receiptPdf`) — two-blob void.
 *  - `kind: 'paid_pending'` → PAID membership whose async §86/4 receipt has NOT
 *                             rendered yet (receiptPdfStatus='pending',
 *                             receiptPdf=null) — the FIX-3 TOCTOU shape.
 */
async function seedNewFlowRow(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  kind: 'bill' | 'paid2' | 'paid_pending',
  billNumber: string,
  receiptNumber: string,
): Promise<{ invoiceId: string; memberId: string; receiptBlobKey: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  const receiptBlobKey = `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_receipt_v8.pdf`;
  const billBlobKey = `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_v8.pdf`;
  const isPaid = kind === 'paid2' || kind === 'paid_pending';
  const hasReceiptBlob = kind === 'paid2';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Void NewFlow Co',
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
      draftByUserId: user.userId,
      status: isPaid ? 'paid' : 'issued',
      // Main blob is the NON-tax ใบแจ้งหนี้ bill.
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      // NEW FLOW — no §87 invoice-stream number; the bill number rides
      // bill_document_number_raw, the §86/4 RC rides receipt_document_number_raw.
      sequenceNumber: null,
      documentNumber: null,
      billDocumentNumberRaw: billNumber,
      receiptDocumentNumberRaw: isPaid ? receiptNumber : null,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: true,
      pdfBlobKey: billBlobKey,
      pdfSha256: ORIGINAL_SHA,
      pdfTemplateVersion: 8,
      paymentMethod: isPaid ? 'bank_transfer' : null,
      paymentReference: isPaid ? 'seed-ref' : null,
      paymentRecordedByUserId: isPaid ? user.userId : null,
      paymentDate: isPaid ? '2026-02-01' : null,
      paidAt: isPaid ? new Date('2026-02-01T03:00:00Z') : null,
      receiptPdfStatus: isPaid
        ? kind === 'paid_pending'
          ? 'pending'
          : 'rendered'
        : null,
      // The SEPARATE §86/4 receipt blob exists only on the paid two-blob shape;
      // the paid_pending shape has the RC number allocated but NO blob yet.
      receiptPdfBlobKey: hasReceiptBlob ? receiptBlobKey : null,
      receiptPdfSha256: hasReceiptBlob ? RECEIPT_SHA : null,
      receiptPdfTemplateVersion: hasReceiptBlob ? 8 : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return { invoiceId, memberId, receiptBlobKey };
}

function makeDeps(tenantId: string): VoidInvoiceDeps & {
  renderCalls: unknown[];
  uploadCalls: unknown[];
  outboxCalls: unknown[];
} {
  const renderCalls: unknown[] = [];
  const uploadCalls: unknown[] = [];
  const outboxCalls: unknown[] = [];
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: {
      render: vi.fn(async (input) => {
        renderCalls.push(input);
        // Kind-aware sha: the SEPARATE §86/4 receipt re-render
        // (voidUnderlyingKind='receipt_combined') gets its own hash so a
        // two-blob void proves both sha columns updated independently.
        const isReceipt =
          (input as { voidUnderlyingKind?: string }).voidUnderlyingKind ===
          'receipt_combined';
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
          sha256: Sha256Hex.ofUnsafe(
            isReceipt ? RERENDERED_RECEIPT_SHA : RERENDERED_SHA,
          ),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async (input) => {
        uploadCalls.push(input);
        return { key: input.key, url: `https://blob.test/${input.key}` };
      }),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-03-15T10:00:00Z' },
    outbox: {
      enqueue: vi.fn(async (_tx, input) => {
        outboxCalls.push(input);
      }),
    },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    renderCalls,
    uploadCalls,
    outboxCalls,
  };
}

describe('F4 US5 — void-invoice (T098)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'void-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Void Plan' },
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
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'VDIT',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('voids an issued invoice, re-renders PDF, emits audit + outbox', async () => {
    const { invoiceId, memberId } = await seedInvoice(tenant, user, planId, 'issued');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Wrong tier selected',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');
    expect(r.value.voidReason).toBe('Wrong tier selected');
    expect(r.value.voidedByUserId).toBe(user.userId);

    // DB row updated with new sha + status = void
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          pdfSha256: invoices.pdfSha256,
          pdfBlobKey: invoices.pdfBlobKey,
          voidReason: invoices.voidReason,
          voidedByUserId: invoices.voidedByUserId,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.pdfSha256).toBe(RERENDERED_SHA);
    // Blob key PRESERVED (content-addressed; overwrite at same key)
    expect(row?.pdfBlobKey).toBe(ORIGINAL_BLOB_KEY);
    expect(row?.voidReason).toBe('Wrong tier selected');
    expect(row?.voidedByUserId).toBe(user.userId);

    // Render called with void_stamped_invoice kind + PINNED version
    expect(deps.renderCalls).toHaveLength(1);
    const renderIn = deps.renderCalls[0] as { kind: string; templateVersion: number; voidReason?: string };
    expect(renderIn.kind).toBe('void_stamped_invoice');
    expect(renderIn.templateVersion).toBe(1);
    expect(renderIn.voidReason).toBe('Wrong tier selected');

    // Blob overwrite at SAME key with allowOverwrite
    expect(deps.uploadCalls).toHaveLength(1);
    const up = deps.uploadCalls[0] as { key: string; allowOverwrite?: boolean };
    expect(up.key).toBe(ORIGINAL_BLOB_KEY);
    expect(up.allowOverwrite).toBe(true);

    // Audit row with member_id (US7 F3-timeline coupling)
    const auditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_voided'),
          ),
        ),
    );
    expect(auditRows).toHaveLength(1);
    const payload = auditRows[0]!.payload as Record<string, unknown>;
    expect(payload.invoice_id).toBe(invoiceId);
    expect(payload.member_id).toBe(memberId);
    // N-1 — B-1 redaction: audit carries SHA-256 of the void reason,
    // NOT the plaintext. Plaintext must be absent from the payload to
    // prevent free-text PII from accumulating in the append-only audit
    // log (GDPR Art. 5(1)(c) minimisation / PDPA §23).
    expect(payload.void_reason).toBeUndefined();
    expect(payload.void_reason_sha256).toBe(
      createHash('sha256').update('Wrong tier selected').digest('hex'),
    );
    expect(payload.new_pdf_sha256).toBe(RERENDERED_SHA);

    // Outbox enqueued (auto_email_on_issue=true). T-2 — documentNumber
    // MUST propagate so `buildInvoiceAutoEmail` can interpolate it into
    // the cancellation email subject/body; without it the member would
    // receive a literal "{docNumber}" placeholder (FR-036 regression).
    expect(deps.outboxCalls).toHaveLength(1);
    const ob = deps.outboxCalls[0] as {
      eventType: string;
      invoiceId: string;
      pdfBlobKey: string;
      documentNumber?: string;
    };
    expect(ob.eventType).toBe('invoice_voided');
    expect(ob.invoiceId).toBe(invoiceId);
    expect(ob.pdfBlobKey).toBe(ORIGINAL_BLOB_KEY);
    expect(ob.documentNumber).toBe('VDIT-2026-000001');
    // B-1 / FR-036 — voidReason MUST propagate so the cancellation
    // email body can render the "Reason: X" clause per spec.
    expect((ob as { voidReason?: string }).voidReason).toBe(
      'Wrong tier selected',
    );

    // T-R1b — after Phase 2 success the returned in-memory Invoice
    // MUST reflect the freshly-committed pdf_sha256 (not the Phase-1
    // RETURNING value which captured the old sha). Route handlers
    // serialise this object to JSON — a stale value would drift from
    // the actual Blob contents until the next fetch.
    expect(r.value.pdf?.sha256).toBe(RERENDERED_SHA);

    // T-1 — §87 no-reuse invariant. `VoidInvoiceDeps` does not include
    // a `sequenceAllocator`, so the use case is STRUCTURALLY unable to
    // consume a fiscal-year sequence slot. Belt-and-suspenders DB
    // check: the invoice row's sequenceNumber + documentNumber stay
    // pinned to the issue-time values. A subsequent real-allocator
    // call would take seq=2; seq=1 is retired with the voided row.
    const [rowAfter] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          sequenceNumber: invoices.sequenceNumber,
          documentNumber: invoices.documentNumber,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(rowAfter?.sequenceNumber).toBe(1);
    expect(rowAfter?.documentNumber).toBe('VDIT-2026-000001');
  }, 60_000);

  it('088 T068 — voids a PAID single-blob invoice (legacy combined): status→void, ONE blob re-stamped', async () => {
    // Paid legacy-shape row: documentNumber set, pdf_doc_kind 'invoice', NO
    // separate receipt blob (receiptPdf null). Voiding a paid membership is the
    // 088 § F.3 edge path — it stamps its single blob (Target A only).
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'paid');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Duplicate payment recorded',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status, pdfSha256: invoices.pdfSha256 })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.pdfSha256).toBe(RERENDERED_SHA);

    // Exactly ONE blob stamped — no separate receipt to re-render.
    expect(deps.renderCalls).toHaveLength(1);
    const renderIn = deps.renderCalls[0] as {
      kind: string;
      voidUnderlyingKind?: string;
      billMode?: boolean;
    };
    expect(renderIn.kind).toBe('void_stamped_invoice');
    expect(renderIn.voidUnderlyingKind).toBe('invoice');
    expect(renderIn.billMode).toBeUndefined();
    expect(deps.uploadCalls).toHaveLength(1);
  }, 60_000);

  it('088 T068 — voids an UNPAID new-flow ใบแจ้งหนี้ bill: documentNumber NULL → bill number + billMode, ONE blob', async () => {
    const { invoiceId } = await seedNewFlowRow(
      tenant,
      user,
      planId,
      'bill',
      'SC-2026-000123',
      'RC-2026-000123',
    );
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Wrong plan on the bill',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          pdfSha256: invoices.pdfSha256,
          documentNumber: invoices.documentNumber,
          billRaw: invoices.billDocumentNumberRaw,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.pdfSha256).toBe(RERENDERED_SHA);
    // §87 no-number invariant: the bill has NO document_number; its bill number
    // survives untouched.
    expect(row?.documentNumber).toBeNull();
    expect(row?.billRaw).toBe('SC-2026-000123');

    // ONE render, billMode + bill number.
    expect(deps.renderCalls).toHaveLength(1);
    const renderIn = deps.renderCalls[0] as {
      voidUnderlyingKind?: string;
      billMode?: boolean;
      documentNumber?: { raw: string };
    };
    expect(renderIn.voidUnderlyingKind).toBe('invoice');
    expect(renderIn.billMode).toBe(true);
    expect(renderIn.documentNumber?.raw).toBe('SC-2026-000123');

    // Outbox + audit carry the bill number (not a null document_number).
    expect(deps.outboxCalls).toHaveLength(1);
    expect((deps.outboxCalls[0] as { documentNumber?: string }).documentNumber).toBe(
      'SC-2026-000123',
    );
  }, 60_000);

  it('088 T068 / CHK027 — voids a PAID membership with a separate §86/4 receipt: BOTH pdf_sha256 AND receipt_pdf_sha256 change, both blobs re-stamped', async () => {
    const { invoiceId, memberId, receiptBlobKey } = await seedNewFlowRow(
      tenant,
      user,
      planId,
      'paid2',
      'SC-2026-000200',
      'RC-2026-000200',
    );
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Sale cancelled after payment',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    // BOTH sha columns updated off their originals.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          pdfSha256: invoices.pdfSha256,
          receiptPdfSha256: invoices.receiptPdfSha256,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.pdfSha256).toBe(RERENDERED_SHA);
    expect(row?.receiptPdfSha256).toBe(RERENDERED_RECEIPT_SHA);

    // TWO renders: [0] bill (billMode, SC), [1] §86/4 receipt (RC, payment-dated).
    expect(deps.renderCalls).toHaveLength(2);
    const billRender = deps.renderCalls[0] as {
      voidUnderlyingKind?: string;
      billMode?: boolean;
      documentNumber?: { raw: string };
    };
    const receiptRender = deps.renderCalls[1] as {
      voidUnderlyingKind?: string;
      billMode?: boolean;
      documentNumber?: { raw: string };
      issueDate?: string;
    };
    expect(billRender.voidUnderlyingKind).toBe('invoice');
    expect(billRender.billMode).toBe(true);
    expect(billRender.documentNumber?.raw).toBe('SC-2026-000200');
    expect(receiptRender.voidUnderlyingKind).toBe('receipt_combined');
    expect(receiptRender.billMode).toBeUndefined();
    expect(receiptRender.documentNumber?.raw).toBe('RC-2026-000200');
    expect(receiptRender.issueDate).toBe('2026-02-01'); // payment date (D7)

    // BOTH blobs overwritten at their own keys.
    expect(deps.uploadCalls).toHaveLength(2);
    const uploadKeys = (deps.uploadCalls as { key: string }[]).map((u) => u.key);
    expect(uploadKeys).toContain(receiptBlobKey);

    // Audit carries BOTH before/after shas + member_id.
    const [voidedRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_voided'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    const payload = voidedRow!.payload as Record<string, unknown>;
    expect(payload.member_id).toBe(memberId);
    expect(payload.document_number).toBe('SC-2026-000200');
    expect(payload.original_pdf_sha256).toBe(ORIGINAL_SHA);
    expect(payload.new_pdf_sha256).toBe(RERENDERED_SHA);
    expect(payload.original_receipt_pdf_sha256).toBe(RECEIPT_SHA);
    expect(payload.new_receipt_pdf_sha256).toBe(RERENDERED_RECEIPT_SHA);

    // Returned in-memory Invoice reflects BOTH freshly-synced shas.
    expect(r.value.pdf?.sha256).toBe(RERENDERED_SHA);
    expect(r.value.receiptPdf?.sha256).toBe(RERENDERED_RECEIPT_SHA);
  }, 60_000);

  it('088 T068 (async TOCTOU) — a receipt render CANNOT land on a VOID row: applyReceiptPdf is a NO-OP, no un-stamped receipt served', async () => {
    // Race Case B: a paid membership is voided while its async §86/4 receipt is
    // still 'pending' (receiptPdf=null → Target B skipped, only the bill
    // stamped). A late worker then tries to write the un-stamped receipt bytes.
    const { invoiceId } = await seedNewFlowRow(
      tenant,
      user,
      planId,
      'paid_pending',
      'SC-2026-000300',
      'RC-2026-000300',
    );
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Voided before async receipt rendered',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');
    // Only the bill was stamped — the pending receipt had no blob to stamp.
    expect(deps.renderCalls).toHaveLength(1);

    // The late async worker attempts to land the (un-stamped) receipt bytes.
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const receiptBlobKey = `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_receipt_v8.pdf`;
    const updated = await repo.withTx((tx) =>
      repo.applyReceiptPdf(tx, {
        tenantId: tenant.ctx.slug,
        invoiceId: asInvoiceId(invoiceId),
        blobKey: receiptBlobKey,
        sha256: Sha256Hex.ofUnsafe('f'.repeat(64)),
        templateVersion: 8,
      }),
    );
    // NO-OP: the WHERE now excludes status='void' → the un-stamped receipt never
    // lands. The void row still has NO receipt blob (nothing un-stamped to serve).
    expect(updated.status).toBe('void');
    expect(updated.receiptPdf).toBeNull();

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          blobKey: invoices.receiptPdfBlobKey,
          rcSha: invoices.receiptPdfSha256,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.blobKey).toBeNull();
    expect(row?.rcSha).toBeNull();
  }, 60_000);

  it('088 T068 — control: a receipt render DOES land on a still-PAID row (only void is blocked)', async () => {
    // Proves the guard is surgical: a non-void async receipt render still works
    // (a paid→credited receipt re-render must not be collateral-damaged; credit
    // requires receiptPdfStatus='rendered' first, so that race can't even occur).
    const { invoiceId } = await seedNewFlowRow(
      tenant,
      user,
      planId,
      'paid_pending',
      'SC-2026-000301',
      'RC-2026-000301',
    );
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const receiptBlobKey = `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_receipt_v8.pdf`;
    const updated = await repo.withTx((tx) =>
      repo.applyReceiptPdf(tx, {
        tenantId: tenant.ctx.slug,
        invoiceId: asInvoiceId(invoiceId),
        blobKey: receiptBlobKey,
        sha256: Sha256Hex.ofUnsafe('f'.repeat(64)),
        templateVersion: 8,
      }),
    );
    expect(updated.status).toBe('paid');
    expect(updated.receiptPdf?.blobKey).toBe(receiptBlobKey);
    expect(updated.receiptPdfStatus).toBe('rendered');
  }, 60_000);

  it('refuses to re-void a voided invoice (terminal state)', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'void');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Trying to re-void',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_status');
    if (r.error.code === 'invalid_status') expect(r.error.status).toBe('void');
    expect(deps.renderCalls).toHaveLength(0);
  }, 60_000);

  it('T-PH2 — Phase 2 blob upload failure keeps void committed, emits invoice_pdf_sync_failed', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued');
    const deps = makeDeps(tenant.ctx.slug);
    // Force Phase 2 blob upload to throw. Phase 1 (render, applyVoid,
    // audit, outbox) is ALREADY committed by the time this fires — so
    // the invoice MUST still reflect void state, pdf_sha256 MUST stay
    // at ORIGINAL_SHA (blob bytes unchanged), and a new audit row
    // `invoice_pdf_sync_failed` MUST document the partial state.
    deps.blob.uploadPdf = vi.fn(async () => {
      throw new Error('simulated blob outage');
    });

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Phase 2 blob fail test',
    });

    // Void IS committed — caller sees ok=true despite blob failure.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          pdfSha256: invoices.pdfSha256,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    // Blob never accepted the new bytes, so DB's pdf_sha256 was NEVER
    // updated (Phase 2 never reached applyInvoicePdfRegeneration).
    // State: (old sha + old bytes) — CONSISTENT but INCOMPLETE.
    expect(row?.pdfSha256).toBe(ORIGINAL_SHA);

    // R-1a audit event documents the partial state via the umbrella
    // `pdf_render_failed` type + `context: 'invoice_void_phase2_sync'`
    // discriminator (see void-invoice.ts Phase 2 catch comment for
    // rationale — DB enum reuse vs new migration).
    const syncFailedRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'pdf_render_failed'),
            sql`${auditLog.payload}->>'context' = 'invoice_void_phase2_sync'`,
          ),
        ),
    );
    expect(syncFailedRows).toHaveLength(1);
    const pl = syncFailedRows[0]!.payload as Record<string, unknown>;
    expect(pl.phase).toBe('blob_upload');
    expect(pl.blob_bytes_uploaded).toBe(false);
    expect(pl.invoice_id).toBe(invoiceId);
  }, 60_000);

  it('does not enqueue outbox when auto_email_on_issue=false', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued', 1, false);
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Silent void',
    });
    expect(r.ok).toBe(true);
    expect(deps.outboxCalls).toHaveLength(0);
  }, 60_000);

  it('T-DISP — auto_email_on_issue=null falls back to tenant settings.autoEmailEnabled', async () => {
    // The use-case resolves `loaded.autoEmailOnIssue ?? settings.
    // autoEmailEnabled`. When the invoice-level override is NULL
    // (the default for tenants who have not overridden), the tenant
    // settings value decides. The seeded tenant has autoEmailEnabled
    // defaulting to true (tenant_invoice_settings row seeded in
    // beforeAll), so the outbox MUST enqueue even without the
    // per-invoice explicit boolean.
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued', 1, null);
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Fallback branch test',
    });
    expect(r.ok).toBe(true);
    // Fallback branch reached the tenant-level default (true) →
    // outbox row enqueued.
    expect(deps.outboxCalls).toHaveLength(1);
  }, 60_000);

  it('emits cross-tenant probe audit on unknown invoice id', async () => {
    const deps = makeDeps(tenant.ctx.slug);
    const fakeId = randomUUID();

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId: fakeId,
      voidReason: 'Probe test',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invoice_not_found');

    const probeRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
            sql`${auditLog.payload}->>'route' = 'void-invoice'`,
          ),
        ),
    );
    expect(probeRows.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('064 W1 S32 — LEGACY non-member issued no-TIN event row voids end-to-end (remediation Step 2.1) with non-timeline audit + kind-true re-render', async () => {
    // Direct-insert fixture (record-payment-event-invoice.test.ts pattern):
    // a PRE-064 legacy event row — issued, INVOICE-stream number, no-TIN
    // buyer snapshot, pdf_doc_kind backfilled to 'receipt_separate'
    // (migration 0211). The real flow can no longer produce this shape;
    // these are exactly the rows the remediation runbook voids.
    const eventId = randomUUID();
    const regId = randomUUID();
    const legacyInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-void-legacy-${regId.slice(0, 8)}`,
        name: 'Void Legacy Gala',
        startDate: new Date('2026-03-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: `att-void-legacy-${regId.slice(0, 8)}`,
        attendeeEmail: 'sim.walkin@void.test',
        attendeeName: 'Sim Walk-in',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 1070,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-03-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: legacyInvoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
        vatInclusive: true,
        memberId: null,
        planYear: null,
        planId: null,
        draftByUserId: user.userId,
        status: 'issued',
        // Pre-064 shape: the issue-time main PDF already IS the §105 receipt.
        pdfDocKind: 'receipt_separate',
        fiscalYear: 2026,
        sequenceNumber: 999_101,
        documentNumber: 'VDIT-2026-999101',
        issueDate: '2026-03-18',
        dueDate: '2026-04-17',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: null,
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: {
          legal_name: 'Sim Walk-in',
          tax_id: null,
          address: '50 Simulated Road, Bangkok',
          primary_contact_name: 'Sim Walk-in',
          primary_contact_email: 'sim.walkin@void.test',
        },
        autoEmailOnIssue: true,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${legacyInvoiceId}_v1.pdf`,
        pdfSha256: ORIGINAL_SHA,
        pdfTemplateVersion: 1,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: legacyInvoiceId,
        kind: 'event_fee',
        descriptionTh: 'ค่าเข้าร่วมงาน Void Legacy Gala (2026-03-10)',
        descriptionEn: 'Event: Void Legacy Gala (2026-03-10)',
        unitPriceSatang: 107_000n,
        totalSatang: 107_000n,
        position: 1,
      });
    });

    const deps = makeDeps(tenant.ctx.slug);
    const voidReqId = `int-void-legacy-${legacyInvoiceId}`;
    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: voidReqId,
      invoiceId: legacyInvoiceId,
      voidReason: 'legacy no-TIN event document — 064 remediation',
    });
    expect(r.ok, r.ok ? 'ok' : `void err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);

    // Row committed as void; §87 number retained (never reused).
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, legacyInvoiceId),
          ),
        ),
    );
    expect(row!.status).toBe('void');
    expect(row!.sequenceNumber).toBe(999_101);
    expect(row!.voidReason).toBe('legacy no-TIN event document — 064 remediation');

    // S31 — the VOID re-render is kind-true: the template gets the
    // persisted pdf_doc_kind so a §105 receipt original keeps its title.
    const renderInput = deps.renderCalls[0] as {
      kind: string;
      voidUnderlyingKind?: string;
    };
    expect(renderInput.kind).toBe('void_stamped_invoice');
    expect(renderInput.voidUnderlyingKind).toBe('receipt_separate');

    // Non-timeline audit branch: payload has event_registration_id, NO
    // member_id (the F3 timeline filter keys on payload->>'member_id').
    const voidedRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_voided'),
            eq(auditLog.requestId, voidReqId),
          ),
        ),
    );
    expect(voidedRows).toHaveLength(1);
    const payload = voidedRows[0]!.payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(regId);
    expect(payload.invoice_id).toBe(legacyInvoiceId);

    // Cancellation outbox enqueued to the walk-in buyer.
    expect(deps.outboxCalls).toHaveLength(1);

    // 088 duplicate-CTA — once voided, this invoice must stop being offered as
    // the "an invoice already exists" link target. The lookup's
    // `status <> 'void'` predicate mirrors the partial unique index
    // `invoices_event_registration_uniq`, so the two must agree: the index now
    // permits a NEW event invoice for this registration, and the CTA must not
    // point the admin at the dead document. Asserted here rather than in a
    // dedicated suite because voiding requires a genuinely issued row — this
    // fixture is the only place one exists.
    expect(
      await makeDrizzleInvoiceRepo(tenant.ctx.slug).findEventInvoiceIdByRegistration(
        regId,
        tenant.ctx.slug,
      ),
    ).toBeNull();
  }, 60_000);
});
