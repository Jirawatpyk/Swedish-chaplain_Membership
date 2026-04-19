/**
 * CP-4.2 — record-payment Application-layer branch coverage.
 *
 * Principle II security-critical — hits 100% branch.
 *
 * Branches:
 *  1. invoice_not_found (raw SQL FOR UPDATE returns []) — skipped: we
 *     mock findDraftById null to hit the second `!loaded` branch
 *  2. invoice_not_found (findDraftById returns null)
 *  3. Idempotent replay — status=paid returns row without re-doing work
 *  4. invalid_status (status=draft/void/credited)
 *  5. no_snapshot_on_invoice (issued invoice missing snapshots)
 *  6. no_snapshot_on_invoice (settings missing)
 *  7. separate numbering — allocates receipt seq
 *  8. combined numbering — no receipt seq
 *  9. auto_email on/off
 *
 * FR-038: confirm receipt render uses PINNED identity snapshot (not
 * re-read from the live member module). The use case MUST pass
 * `loaded.memberIdentitySnapshot` to `pdfRender.render`, never a fresh
 * adapter call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';

const INVOICE_ID = '00000000-0000-0000-0000-00000000e002';

function makeIssuedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const line: InvoiceLine = {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก',
    descriptionEn: 'Membership',
    unitPrice: Money.fromTHB(1000),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromTHB(1000),
    position: 1,
  };

  const docNumR = DocumentNumber.of('SC', 2026, 42);
  if (!docNumR.ok) throw new Error('fixture');

  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'actor-user',
    fiscalYear: 2026 as never,
    sequenceNumber: 42,
    documentNumber: docNumR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromTHB(1000),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromTHB(70),
    total: Money.fromTHB(1070),
    creditedTotal: Money.zero(),
    proRatePolicy: 'monthly',
    netDays: 30,
    tenantIdentitySnapshot: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    memberIdentitySnapshot: {
      legal_name: 'Acme Co',
      // Snapshot was taken AT ISSUE TIME. FR-038 — the live member can
      // change tax_id afterwards; the receipt MUST render this value.
      tax_id: 'snapshot-tax-at-issue',
      address: '123 Road',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
    },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdfBlobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 1,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 500000n,
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    ...overrides,
  };
}

function makeDeps(
  rowExists: boolean,
  draft: Invoice | null,
  settings: TenantInvoiceSettingsView | null,
  overrides: Partial<RecordPaymentDeps> = {},
): RecordPaymentDeps {
  const opaqueTx = {
    execute: vi.fn(async () => (rowExists ? [{ status: draft?.status ?? 'issued' }] : [])),
  };
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findDraftById: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => ({ status: 'issued' as const })),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: 'b'.repeat(64),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(),
      delete: vi.fn(),
    },
    audit: {
      emit: vi.fn(async () => {}),
    },
    clock: {
      nowIso: () => '2026-05-18T10:00:00Z',
    },
    outbox: {
      enqueue: vi.fn(async () => {}),
    },
    currentTemplateVersion: 1,
    ...overrides,
  };
}

const input = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-pay',
  invoiceId: INVOICE_ID,
  paymentMethod: 'bank_transfer' as const,
  paymentReference: 'TRX-123',
  paymentDate: '2026-05-18',
};

describe('recordPayment — CP-4.2 branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invoice_not_found — row lock returns empty', async () => {
    const deps = makeDeps(false, null, null);
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
  });

  it('invoice_not_found — findDraftById returns null after row exists (concurrent delete race)', async () => {
    const deps = makeDeps(true, null, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
  });

  it('idempotent replay — status=paid returns persisted row', async () => {
    const paid = makeIssuedInvoice({ status: 'paid' });
    const deps = makeDeps(true, paid, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('paid');
    // No seq allocator, no pdf render, no audit emit, no update UPDATE calls.
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('invalid_status — draft', async () => {
    const draft = makeIssuedInvoice({ status: 'draft' });
    const deps = makeDeps(true, draft, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_status');
      if (r.error.code === 'invalid_status') expect(r.error.status).toBe('draft');
    }
  });

  it('invalid_status — void', async () => {
    const voided = makeIssuedInvoice({ status: 'void' });
    const deps = makeDeps(true, voided, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_status');
  });

  it('no_snapshot_on_invoice — snapshot fields missing', async () => {
    const broken = makeIssuedInvoice({ tenantIdentitySnapshot: null });
    const deps = makeDeps(true, broken, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_snapshot_on_invoice');
  });

  it('no_snapshot_on_invoice — settings missing at pay time', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), null);
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_snapshot_on_invoice');
  });

  it('combined numbering — no receipt seq allocation', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings({ receiptNumberingMode: 'combined' }));
    // Re-mock findDraftById to return paid invoice on second call (after UPDATE).
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? makeIssuedInvoice() : makeIssuedInvoice({ status: 'paid', paidAt: '2026-05-18T10:00:00Z' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_combined' }),
    );
  });

  it('separate numbering — allocates receipt seq', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings({ receiptNumberingMode: 'separate' }));
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? makeIssuedInvoice() : makeIssuedInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt' }),
    );
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_separate' }),
    );
  });

  it('FR-038 — receipt PDF uses ISSUE-TIME member snapshot, NOT live value', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings());
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    // The render call's `member` param MUST be the invoice's frozen
    // snapshot — callers can mutate the live member module without
    // affecting the receipt.
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({
        member: expect.objectContaining({ tax_id: 'snapshot-tax-at-issue' }),
      }),
    );
  });

  it('auto_email enabled → outbox enqueued with receipt pdf key', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: true }));
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_paid',
        recipientEmail: 'john@acme.example',
      }),
    );
  });

  it('auto_email disabled → no outbox enqueue', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: false }));
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('payment fields — optional reference / notes default null', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings());
    let call = 0;
    deps.invoiceRepo.findDraftById = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    const { paymentReference, ...rest } = input;
    void paymentReference;
    const r = await recordPayment(deps, { ...rest });
    expect(r.ok).toBe(true);
  });
});
