/**
 * 088-invoice-tax-flow-redesign — T012 [US1] Contract test for issue-invoice
 * per `specs/088-invoice-tax-flow-redesign/contracts/issue-invoice.md`.
 *
 * Asserts the CONTRACT of `issueInvoice` under FEATURE_088_TAX_AT_PAYMENT:
 *
 *   flag ON  — the pre-payment document is a NON-tax ใบแจ้งหนี้:
 *     • the number is allocated from the `bill` stream (NOT the §87 `invoice`
 *       stream) — no §87 tax number is consumed at issue;
 *     • it lands in `bill_document_number_raw` with `sequence_number` +
 *       `document_number` NULL (disjoint from the §87 uniqueness index, SC-003);
 *     • the PDF renders in `billMode` (ใบแจ้งหนี้, not §86/4);
 *     • the `invoice_issued` audit payload carries the bill number + records
 *       that no §87 tax number was consumed.
 *   flag OFF — the legacy §86/4-at-issue behaviour is byte-identical (the §87
 *     `invoice` stream is allocated, `bill_document_number_raw` stays NULL).
 *
 * Use-case-level contract (mocked ports) — the live-Neon end-to-end proof is
 * `tests/integration/invoicing/bill-to-receipt.integration.test.ts` (T014).
 */
import { describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { F4AuditEvent } from '@/modules/invoicing/application/ports/audit-port';
import { serialiseInvoice } from '@/app/api/invoices/_serialise';

const INVOICE_ID = '08800000-0000-4000-8000-0000000000aa';

function membershipDraft(): Invoice {
  const line: InvoiceLine = {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก',
    descriptionEn: 'Membership',
    unitPrice: Money.fromTHB(12000),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromTHB(12000),
    position: 1,
  };
  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'draft',
    draftByUserId: 'actor-user',
    fiscalYear: null,
    sequenceNumber: null,
    documentNumber: null,
    issueDate: null,
    dueDate: null,
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: null,
    vatRate: null,
    vat: null,
    total: null,
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: null,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: false,
    pdf: null,
    pdfDocKind: null,
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  } as Invoice;
}

function settings(): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(0n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberPrefix: 'RC',
    receiptNumberingMode: 'separate',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: false,
    identity: Object.freeze({
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0994000187203',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    }),
  };
}

function member(): MemberIdentityView {
  return {
    memberId: 'member-1',
    isActive: true,
    isArchived: false,
    memberTypeScope: 'company',
    registrationDate: '2026-01-15',
    registrationFeePaid: true,
    snapshot: Object.freeze({
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: '123 Road, Bangkok',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    }),
  };
}

interface Captured {
  renderInputs: PdfRenderInput[];
  applyIssueInputs: Array<Record<string, unknown>>;
  auditEvents: Array<F4AuditEvent & { tenantId: string }>;
  allocateCalls: Array<{ documentType: string; fiscalYear: number }>;
}

function makeDeps(taxAtPayment: boolean, cap: Captured): IssueInvoiceDeps {
  const draft = membershipDraft();
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(Symbol('tx'))),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(async (_tx, input: Record<string, unknown>) => {
        cap.applyIssueInputs.push(input);
        return {
          ...draft,
          status: 'issued' as InvoiceStatus,
          fiscalYear: input.fiscalYear as never,
          sequenceNumber: (input.sequenceNumber as number | null) ?? null,
          documentNumber:
            input.documentNumber === null
              ? null
              : ({ raw: input.documentNumber } as never),
          billDocumentNumberRaw:
            (input.billDocumentNumberRaw as string | null | undefined) ?? null,
          issueDate: input.issueDate as string,
          dueDate: input.dueDate as string,
          subtotal: Money.fromTHB(12000),
          vat: Money.fromTHB(840),
          total: Money.fromTHB(12840),
          vatRate: VatRate.ofUnsafe('0.0700'),
          pdf: input.pdf as never,
          pdfDocKind: input.pdfDocKind as never,
        } as Invoice;
      }),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'draft' as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyReceiptPdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings()),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    memberIdentity: {
      getForIssue: vi.fn(async () => member()),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    eventRegistrationLookup: {
      findById: vi.fn(async () => ok(null)),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async (_tx, i: { documentType: string; fiscalYear: number }) => {
        cap.allocateCalls.push({ documentType: i.documentType, fiscalYear: i.fiscalYear });
        return 42;
      }),
    },
    pdfRender: {
      render: vi.fn(async (i: PdfRenderInput) => {
        cap.renderInputs.push(i);
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
    audit: {
      emit: vi.fn(async (_tx, e: F4AuditEvent & { tenantId: string }) => {
        cap.auditEvents.push(e);
      }),
    },
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 4,
    taxAtPayment,
  };
}

function emptyCap(): Captured {
  return { renderInputs: [], applyIssueInputs: [], auditEvents: [], allocateCalls: [] };
}

describe('issue-invoice contract (088 US1) — bill (ใบแจ้งหนี้) at issue', () => {
  const input = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    requestId: 'req-1',
    invoiceId: INVOICE_ID,
  };

  it('flag ON — allocates the `bill` stream (SC), NOT the §87 `invoice` stream', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(true, cap), input);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    expect(cap.allocateCalls).toHaveLength(1);
    expect(cap.allocateCalls[0]!.documentType).toBe('bill');
    expect(cap.allocateCalls[0]!.fiscalYear).toBe(2026);
  });

  it('flag ON — renders the ใบแจ้งหนี้ (billMode, kind=invoice)', async () => {
    const cap = emptyCap();
    await issueInvoice(makeDeps(true, cap), input);
    expect(cap.renderInputs).toHaveLength(1);
    expect(cap.renderInputs[0]!.kind).toBe('invoice');
    expect(cap.renderInputs[0]!.billMode).toBe(true);
    expect(cap.renderInputs[0]!.documentNumber?.raw).toBe('SC-2026-000042');
  });

  it('flag ON — bill number lands in bill_document_number_raw; §87 seq/doc NULL', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(true, cap), input);
    expect(r.ok).toBe(true);
    const applied = cap.applyIssueInputs[0]!;
    expect(applied.billDocumentNumberRaw).toBe('SC-2026-000042');
    expect(applied.sequenceNumber).toBeNull();
    expect(applied.documentNumber).toBeNull();

    // Serialised DTO reflects the disjoint numbering (contract § Response).
    if (!r.ok) throw new Error('unreachable');
    const dto = serialiseInvoice(r.value);
    expect(dto.bill_document_number_raw).toBe('SC-2026-000042');
    expect(dto.document_number).toBeNull();
    expect(dto.sequence_number).toBeNull();
  });

  it('flag ON — invoice_issued audit records the bill number + no §87 consumed', async () => {
    const cap = emptyCap();
    await issueInvoice(makeDeps(true, cap), input);
    const issued = cap.auditEvents.find((e) => e.eventType === 'invoice_issued');
    expect(issued).toBeDefined();
    const p = issued!.payload as Record<string, unknown>;
    expect(p.bill_document_number_raw).toBe('SC-2026-000042');
    expect(p.tax_number_consumed).toBe(false);
    expect(p.sequence_number).toBeNull();
    expect(p.document_number).toBeNull();
  });

  it('flag OFF — legacy §86/4-at-issue: §87 `invoice` stream, bill number NULL', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(false, cap), input);
    expect(r.ok).toBe(true);
    expect(cap.allocateCalls[0]!.documentType).toBe('invoice');
    expect(cap.renderInputs[0]!.billMode).toBe(false);
    const applied = cap.applyIssueInputs[0]!;
    expect(applied.sequenceNumber).toBe(42);
    expect(applied.documentNumber).toBe('SC-2026-000042');
    expect(applied.billDocumentNumberRaw).toBeNull();
  });
});
