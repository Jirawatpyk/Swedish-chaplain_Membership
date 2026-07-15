/**
 * 088-invoice-tax-flow-redesign (T052 / US8 / FR-023..025 / SC-008) — contract
 * test for the §80/1(5) embassy / int'l-org VAT zero-rate on issue-invoice.
 *
 * Use-case-level contract (mocked ports). Asserts:
 *   - a `zero_rated_80_1_5` issue with a missing/blank cert number is REJECTED
 *     `zero_rate_cert_required` (422, fail-closed — no invoice issued);
 *   - a MEMBERSHIP subject supplied as `zero_rated_80_1_5` is REJECTED
 *     `membership_cannot_be_zero_rated` (422 — reject, not silent coerce);
 *   - a zero-rate event sale WITH a cert ISSUES at VAT 0% (rate 0.0000, vat 0,
 *     total = base), records `vat_treatment` + `zero_rate_cert_no` in the
 *     serialised DTO AND the `invoice_issued` audit payload;
 *   - a zero-rate subtotal below ~5,000 THB WARNS (non-blocking) — the invoice
 *     still issues and the DTO carries `zero_rate_below_threshold_warning: true`.
 *
 * The live-Neon end-to-end proof is `zero-rate.integration.test.ts` (T053).
 */
import { describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import {
  issueInvoice,
  issueInvoiceSchema,
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
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { F4AuditEvent } from '@/modules/invoicing/application/ports/audit-port';
import type { EventRegistrationView } from '@/modules/invoicing/application/ports/event-registration-lookup-port';
import { serialiseInvoice } from '@/app/api/invoices/_serialise';

const INVOICE_ID = '08800000-0000-4000-8000-0000000000e8';

function eventLine(totalSatang: bigint): InvoiceLine {
  return {
    lineId: asInvoiceLineId('line-e1'),
    kind: 'event_fee',
    descriptionTh: 'ค่าออกบูธ',
    descriptionEn: 'Expo booth',
    unitPrice: Money.fromSatangUnsafe(totalSatang),
    quantity: '1.0000',
    proRateFactor: null,
    total: Money.fromSatangUnsafe(totalSatang),
    position: 1,
  };
}

/** Non-member EVENT draft with a pinned TIN buyer snapshot (zero-rate is non-membership). */
function eventDraft(totalSatang: bigint): Invoice {
  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: null,
    planId: null,
    planYear: null,
    invoiceSubject: 'event',
    vatInclusive: false,
    eventId: '08800000-0000-4000-8000-0000000000f1',
    eventRegistrationId: '08800000-0000-4000-8000-0000000000f2',
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
    memberIdentitySnapshot: Object.freeze({
      legal_name: 'Embassy of Sweden (Simulated)',
      tax_id: '0994000000001',
      address: '1 Wireless Rd, Bangkok',
      primary_contact_name: 'Sim Attaché',
      primary_contact_email: 'sim@embassy.test',
      member_number: null,
      member_number_display: null,
    }),
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
    lines: [eventLine(totalSatang)],
    createdAt: '2026-03-15T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
  } as Invoice;
}

/** MEMBERSHIP draft — used only for the membership_cannot_be_zero_rated reject. */
function membershipDraft(): Invoice {
  return {
    ...eventDraft(1_200_000n),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    invoiceSubject: 'membership',
    eventId: null,
    eventRegistrationId: null,
    memberIdentitySnapshot: null,
    lines: [
      {
        lineId: asInvoiceLineId('line-m1'),
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership',
        unitPrice: Money.fromSatangUnsafe(1_200_000n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(1_200_000n),
        position: 1,
      },
    ],
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
    brandName: null,
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

function reg(): EventRegistrationView {
  return {
    registrationId: '08800000-0000-4000-8000-0000000000f2',
    eventId: '08800000-0000-4000-8000-0000000000f1',
    attendeeName: 'Sim Attaché',
    attendeeEmail: 'sim@embassy.test',
    attendeeCompany: 'Embassy of Sweden (Simulated)',
    ticketPriceThb: 12000,
    paymentStatus: 'paid',
    matchType: 'non_member',
    matchedMemberId: null,
    pseudonymised: false,
  };
}

interface Captured {
  renderInputs: PdfRenderInput[];
  applyIssueInputs: Array<Record<string, unknown>>;
  auditEvents: Array<F4AuditEvent & { tenantId: string }>;
}

function makeDeps(draft: Invoice, cap: Captured): IssueInvoiceDeps {
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
          billDocumentNumberRaw:
            (input.billDocumentNumberRaw as string | null | undefined) ?? null,
          issueDate: input.issueDate as string,
          dueDate: input.dueDate as string,
          // Echo the computed money + pinned treatment so serialiseInvoice reads them.
          subtotal: Money.fromSatangUnsafe(BigInt(input.subtotalSatang as string | bigint)),
          vat: Money.fromSatangUnsafe(BigInt(input.vatSatang as string | bigint)),
          total: Money.fromSatangUnsafe(BigInt(input.totalSatang as string | bigint)),
          vatRate: VatRate.ofUnsafe(input.vatRate as string),
          vatTreatment: (input.vatTreatment ?? 'standard') as never,
          zeroRateCertNo: (input.zeroRateCertNo as string | null | undefined) ?? null,
          zeroRateCertDate: (input.zeroRateCertDate as string | null | undefined) ?? null,
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
      getForIssue: vi.fn(),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    eventRegistrationLookup: {
      findById: vi.fn(async () => ok(reg())),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 7),
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
    clock: { nowIso: () => '2026-03-15T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 8,
    taxAtPayment: 'on',
  };
}

function emptyCap(): Captured {
  return { renderInputs: [], applyIssueInputs: [], auditEvents: [] };
}

const baseInput = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-zr',
  invoiceId: INVOICE_ID,
};

describe('issue-invoice zero-rate contract (088 US8)', () => {
  it('schema — an IMPOSSIBLE zeroRateCertDate is rejected at parse (typed 4xx, not a 500); optional/omit + real dates accepted', () => {
    // `^\d{4}-\d{2}-\d{2}$` alone accepts 2026-02-30; that date then persists
    // into the Postgres `date` column → DB rejects → unhandled 500. The
    // `.refine(isValidCalendarDate)` rejects it at parse.
    expect(
      issueInvoiceSchema.safeParse({
        ...baseInput,
        vatTreatment: 'zero_rated_80_1_5',
        zeroRateCertNo: 'กต 0404/1234',
        zeroRateCertDate: '2026-02-30',
      }).success,
    ).toBe(false);
    // A real date is accepted.
    expect(
      issueInvoiceSchema.safeParse({
        ...baseInput,
        vatTreatment: 'zero_rated_80_1_5',
        zeroRateCertNo: 'กต 0404/1234',
        zeroRateCertDate: '2026-03-10',
      }).success,
    ).toBe(true);
    // Still optional — an omitted cert date bypasses the refine (undefined
    // short-circuits before it runs).
    expect(issueInvoiceSchema.safeParse(baseInput).success).toBe(true);
  });

  it('FR-024 fail-closed — zero-rate WITHOUT a cert number is rejected (no invoice issued)', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      // zeroRateCertNo omitted
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('zero_rate_cert_required');
    // Fail-closed: no allocation / render / applyIssue happened.
    expect(cap.applyIssueInputs).toHaveLength(0);
    expect(cap.renderInputs).toHaveLength(0);
  });

  it('FR-024 — a blank/whitespace cert number is also rejected', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: '   ',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('zero_rate_cert_required');
  });

  it('FR-025 — a MEMBERSHIP subject set to zero-rated is rejected (reject, not coerce)', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(membershipDraft(), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('membership_cannot_be_zero_rated');
    expect(cap.applyIssueInputs).toHaveLength(0);
  });

  it('SC-008 — a zero-rate event sale WITH a cert issues at VAT 0% + records treatment/cert', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertDate: '2026-03-10',
    });
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error('unreachable');

    // VAT DRIVEN to 0% by the treatment (FR-025 / G3).
    const applied = cap.applyIssueInputs[0]!;
    expect(applied.vatTreatment).toBe('zero_rated_80_1_5');
    expect(applied.vatRate).toBe('0.0000');
    expect(String(applied.vatSatang)).toBe('0');
    expect(String(applied.subtotalSatang)).toBe('1200000');
    expect(String(applied.totalSatang)).toBe('1200000'); // total = base
    expect(applied.zeroRateCertNo).toBe('กต 0404/1234');
    expect(applied.zeroRateCertDate).toBe('2026-03-10');

    // The render input carries the pinned zero-rate treatment (note gate).
    expect(cap.renderInputs[0]!.vatTreatment).toBe('zero_rated_80_1_5');
    expect(cap.renderInputs[0]!.vatRate.raw).toBe('0.0000');

    // Serialised DTO records treatment + cert; NOT below the 5,000-THB floor.
    const dto = serialiseInvoice(r.value);
    expect(dto.vat_treatment).toBe('zero_rated_80_1_5');
    expect(dto.zero_rate_cert_no).toBe('กต 0404/1234');
    expect(dto.vat_rate).toBe('0.0000');
    expect(dto.vat_satang).toBe('0');
    expect(dto.zero_rate_below_threshold_warning).toBe(false);

    // Audit `invoice_issued` records vat_treatment + zero_rate_cert_no.
    const issued = cap.auditEvents.find((e) => e.eventType === 'invoice_issued');
    expect(issued).toBeDefined();
    const p = issued!.payload as Record<string, unknown>;
    expect(p.vat_treatment).toBe('zero_rated_80_1_5');
    expect(p.zero_rate_cert_no).toBe('กต 0404/1234');
  });

  it('UX-B1 review (SEC/CWE-639) — an INJECTED cert blob key outside this invoice cert namespace is rejected, no invoice issued', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      // A key pointing at ANOTHER tenant's / an arbitrary never-scanned blob.
      zeroRateCertBlobKey: 'invoicing/other-tenant/zero-rate-certs/deadbeef_1.pdf',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('zero_rate_cert_blob_key_invalid');
    // Fail-fast BEFORE any pin/render — the bad key never lands on the row.
    expect(cap.applyIssueInputs).toHaveLength(0);
    expect(cap.renderInputs).toHaveLength(0);
  });

  it("UX-B1 review — a VALID cert blob key under this invoice's server-derived namespace is accepted + pinned", async () => {
    const cap = emptyCap();
    const validKey = `invoicing/${baseInput.tenantId}/zero-rate-certs/${INVOICE_ID}_1700000000000.pdf`;
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertBlobKey: validKey,
    });
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(cap.applyIssueInputs[0]!.zeroRateCertBlobKey).toBe(validKey);
  });

  it('FR-024 advisory — a zero-rate subtotal < 5,000 THB WARNS but still issues', async () => {
    const cap = emptyCap();
    // 4,000.00 THB = 400,000 satang < 500,000 threshold.
    const r = await issueInvoice(makeDeps(eventDraft(400_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertDate: '2026-03-10',
    });
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // The invoice STILL issued (non-blocking) …
    expect(r.value.status).toBe('issued');
    // … and the DTO carries the advisory warning.
    const dto = serialiseInvoice(r.value);
    expect(dto.zero_rate_below_threshold_warning).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 088 SEC-MED — the §80/1(5) zero rate is a FEATURE_088_TAX_AT_PAYMENT feature.
// The issue form hides the toggle when the flag is dark, but a crafted request
// could still forward `vatTreatment: 'zero_rated_80_1_5'` and mint a 0%-VAT
// §86/4 document (burning a §87 number) while the feature is off. The
// use-case MUST gate `vatTreatment !== 'standard'` on `deps.taxAtPayment ===
// true`, PRE-SEQUENCE (no number burned, cert fields not persisted), so the
// env.ts invariant "flag off → every invoice is standard 7%" holds
// server-side, not only in the UI.
// ---------------------------------------------------------------------------
describe('issue-invoice zero-rate server flag-gate (088 SEC-MED)', () => {
  it('flag OFF + zero_rated → zero_rate_requires_flag (no invoice issued, no number burned)', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(
      { ...makeDeps(eventDraft(1_200_000n), cap), taxAtPayment: 'off' },
      {
        ...baseInput,
        vatTreatment: 'zero_rated_80_1_5',
        zeroRateCertNo: 'กต 0404/1234',
        zeroRateCertDate: '2026-03-10',
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('zero_rate_requires_flag');
    // Pre-sequence: no allocation / render / applyIssue happened.
    expect(cap.applyIssueInputs).toHaveLength(0);
    expect(cap.renderInputs).toHaveLength(0);
  });

  it('flag OFF + standard treatment → unaffected (issues normally)', async () => {
    const cap = emptyCap();
    const r = await issueInvoice(
      { ...makeDeps(eventDraft(1_200_000n), cap), taxAtPayment: 'off' },
      {
        ...baseInput,
        // vatTreatment omitted → resolves to 'standard'.
      },
    );
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.status).toBe('issued');
  });

  it('flag ON + zero_rated + cert → still succeeds (happy path unaffected by the gate)', async () => {
    const cap = emptyCap();
    // makeDeps hardcodes taxAtPayment: 'on'.
    const r = await issueInvoice(makeDeps(eventDraft(1_200_000n), cap), {
      ...baseInput,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertDate: '2026-03-10',
    });
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(cap.applyIssueInputs[0]!.vatTreatment).toBe('zero_rated_80_1_5');
  });
});
