/**
 * T007 (F8 Phase 2 Wave A) — Contract test for `RecordPaymentDeps.onPaidCallbacks`.
 *
 * This file pins the cross-module hook contract that F8 (and any future
 * bounded context) relies on when listening for invoice `issued → paid`
 * transitions. The contracts asserted here are the public surface area
 * — changing their behaviour requires updating this file + every
 * registered listener (Constitution Principle III + research.md R12).
 *
 * Four contracts:
 *
 *   1. Each registered callback fires EXACTLY ONCE on a successful
 *      `issued → paid` transition. No duplicate dispatch on retry, no
 *      silent drop when the callback list is non-empty.
 *
 *   2. Callbacks receive the canonical `F4InvoicePaidEvent` shape with
 *      every required field present + correct types (tenantId, invoiceId,
 *      memberId, paidAt ISO string, amountSatang bigint, currency 'THB').
 *
 *   3. A callback rejection rolls back the entire `withTx`. The invoice
 *      stays `issued`; downstream side-effects (audit emit, outbox
 *      enqueue, registration-fee flip) DO NOT commit either. The use-
 *      case caller observes the propagated error.
 *
 *   4. Multiple callbacks fire SEQUENTIALLY in registration order, NOT
 *      in parallel. The first rejection short-circuits the chain — no
 *      subsequent callbacks fire.
 *
 * Test style: unit-mocked deps mirroring `tests/unit/invoicing/record-payment.test.ts`.
 * Live DB is unnecessary because the contract is at the application-
 * boundary level — `withTx` rollback semantics are exercised via mock
 * `withTx` that propagates callback rejections out of the use-case
 * (the same way Drizzle's withTx does in production).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { F4InvoicePaidEvent } from '@/modules/invoicing/domain/f4-invoice-paid-event';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import { membershipAccessStub } from '../helpers/membership-access-stub';

const INVOICE_ID = '00000000-0000-0000-0000-00000000f001';
const MEMBER_ID = 'member-on-paid-cb';
const TENANT_ID = 'test-swecham';

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
    tenantId: TENANT_ID,
    invoiceId: asInvoiceId(INVOICE_ID),
    invoiceSubject: 'membership',
    memberId: MEMBER_ID,
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
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    memberIdentitySnapshot: {
      legal_name: 'Acme Co',
      tax_id: 'snapshot-tax-at-issue',
      address: '123 Road',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
    },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: `invoicing/${TENANT_ID}/2026/${INVOICE_ID}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      templateVersion: 1,
    },
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function makeSettings(): TenantInvoiceSettingsView {
  return {
    tenantId: TENANT_ID,
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(500000n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: false, // suppress outbox enqueue noise from these contract assertions
    brandName: null,
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
  };
}

/**
 * Build deps with a fully-mocked transactional path. The `withTx`
 * mock invokes the callback with a synthetic tx handle and PROPAGATES
 * any exceptions back to the recordPayment caller — mirroring Drizzle's
 * production behaviour where a thrown callback rolls the tx back and
 * re-raises through `withTx`.
 */
function makeDepsWithCallbacks(
  draft: Invoice,
  settings: TenantInvoiceSettingsView,
  onPaidCallbacks: ReadonlyArray<(evt: F4InvoicePaidEvent) => Promise<void>>,
): RecordPaymentDeps {
  const opaqueTx = { execute: vi.fn(async () => [{ status: 'issued' }]) };
  return {
    membershipAccess: membershipAccessStub(), // 066 §4.4(1)
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(async () => ({
        ...draft,
        status: 'paid',
        paidAt: '2026-05-18T10:00:00Z',
      } as Invoice)),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as InvoiceStatus),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyReceiptPdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(),
      list: vi.fn(async () => []),
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
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    memberIdentity: {
      getForIssue: vi.fn(),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    currentTemplateVersion: 1,
    taxAtPayment: 'off',
    onPaidCallbacks,
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  actorUserId: 'actor-user',
  requestId: 'req-cb',
  invoiceId: INVOICE_ID,
  paymentMethod: 'bank_transfer' as const,
  paymentReference: 'TRX-CB',
  paymentDate: '2026-05-18',
};

describe('Contract — F4 onPaidCallbacks (cross-module hook for F8/F5)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Contract 1 ─────────────────────────────────────────────────────────
  it('Contract 1: a registered callback fires exactly ONCE per successful issued→paid transition', async () => {
    const cb = vi.fn(async (_evt: F4InvoicePaidEvent) => {});
    const deps = makeDepsWithCallbacks(makeIssuedInvoice(), makeSettings(), [cb]);

    const r = await recordPayment(deps, baseInput);

    expect(r.ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // ── Contract 2 ─────────────────────────────────────────────────────────
  it('Contract 2: callbacks receive canonical F4InvoicePaidEvent shape (research.md R12 — full 11-field surface)', async () => {
    let received: F4InvoicePaidEvent | null = null;
    const cb = async (evt: F4InvoicePaidEvent) => {
      received = evt;
    };
    const deps = makeDepsWithCallbacks(makeIssuedInvoice(), makeSettings(), [cb]);

    const r = await recordPayment(deps, baseInput);
    expect(r.ok).toBe(true);

    expect(received).not.toBeNull();
    const evt = received as unknown as F4InvoicePaidEvent;
    expect(evt.tenantId).toBe(TENANT_ID);
    expect(evt.invoiceId).toBe(INVOICE_ID);
    expect(evt.memberId).toBe(MEMBER_ID);
    expect(evt.paidAt).toBe('2026-05-18T10:00:00Z');
    expect(typeof evt.amountSatang).toBe('bigint');
    // Total = 1070 THB = 107000 satang (subtotal 1000 + VAT 70)
    expect(evt.amountSatang).toBe(107000n);
    expect(typeof evt.vatSatang).toBe('bigint');
    expect(evt.vatSatang).toBe(7000n); // VAT 70 THB = 7000 satang
    expect(evt.currency).toBe('THB');
    // Default trigger when caller doesn't override
    expect(evt.triggeredBy).toBe('admin_manual');
    // Default paymentMethod = input.paymentMethod when no processorMethod override
    expect(evt.paymentMethod).toBe('bank_transfer');
    // Rolling-anchor fields (renewal-rolling-anchor task 3): the loaded
    // Invoice's subject partition + the admin-entered payment date verbatim.
    expect(evt.invoiceSubject).toBe('membership');
    expect(evt.paymentDate).toBe(baseInput.paymentDate);
  });

  // ── Contract 2a ─────────────────────────────────────────────────────
  it('Contract 2a: F5 webhook caller path — `processorMethod` overrides `paymentMethod` and `triggeredBy=webhook` is forwarded', async () => {
    let received: F4InvoicePaidEvent | null = null;
    const cb = async (evt: F4InvoicePaidEvent) => {
      received = evt;
    };
    const deps = makeDepsWithCallbacks(makeIssuedInvoice(), makeSettings(), [cb]);

    // Mirror what `markPaidFromProcessor` wrapper would forward into recordPayment
    // for a Stripe card webhook event.
    const f5Input = {
      ...baseInput,
      paymentMethod: 'other' as const, // F4 enum coerces stripe rails to 'other'
      processorMethod: 'stripe_card' as const,
      triggeredBy: 'webhook' as const,
    };

    const r = await recordPayment(deps, f5Input);
    expect(r.ok).toBe(true);

    expect(received).not.toBeNull();
    const evt = received as unknown as F4InvoicePaidEvent;
    // Event surfaces the SEMANTIC rail, not the F4 row enum
    expect(evt.paymentMethod).toBe('stripe_card');
    expect(evt.triggeredBy).toBe('webhook');
    // record-payment's paymentDate passthrough is trigger-agnostic — the
    // F5 wrapper still supplies a real settlement date on this input schema.
    expect(evt.invoiceSubject).toBe('membership');
    expect(evt.paymentDate).toBe(f5Input.paymentDate);
  });

  // ── Contract 3 ─────────────────────────────────────────────────────────
  it('Contract 3: a callback rejection rolls back the withTx — invoice stays issued; recordPayment surfaces the error', async () => {
    const boom = new Error('renewal-cycle-complete-failed');
    const cb = vi.fn(async (_evt: F4InvoicePaidEvent) => {
      throw boom;
    });
    const deps = makeDepsWithCallbacks(makeIssuedInvoice(), makeSettings(), [cb]);

    // The mock `withTx` propagates the rejection up — same shape as
    // Drizzle's production behaviour. The use-case does NOT swallow
    // unknown errors (only its own `RecordPaymentInternalError`), so
    // the original throw bubbles to the test.
    await expect(recordPayment(deps, baseInput)).rejects.toThrow(
      'renewal-cycle-complete-failed',
    );

    expect(cb).toHaveBeenCalledTimes(1);
    // applyPayment was attempted (the issued→paid UPDATE) — but since
    // withTx rolled back, the row would NOT have committed in production.
    // We assert the call ordering rather than DB state because the
    // tx-rollback is the responsibility of the real adapter; the
    // contract here is "use-case re-throws callback errors out of withTx
    // unaltered so the adapter can roll back".
    expect(deps.invoiceRepo.applyPayment).toHaveBeenCalledTimes(1);
  });

  // ── Contract 4 ─────────────────────────────────────────────────────────
  it('Contract 4: multiple callbacks fire SEQUENTIALLY in registration order; first rejection short-circuits the chain', async () => {
    const order: string[] = [];
    const cbA = vi.fn(async (_evt: F4InvoicePaidEvent) => {
      order.push('A');
    });
    const cbB_throws = vi.fn(async (_evt: F4InvoicePaidEvent) => {
      order.push('B');
      throw new Error('cbB-failed');
    });
    const cbC_should_not_fire = vi.fn(async (_evt: F4InvoicePaidEvent) => {
      order.push('C');
    });
    const deps = makeDepsWithCallbacks(makeIssuedInvoice(), makeSettings(), [
      cbA,
      cbB_throws,
      cbC_should_not_fire,
    ]);

    await expect(recordPayment(deps, baseInput)).rejects.toThrow('cbB-failed');

    expect(order).toEqual(['A', 'B']); // sequential; C never fires
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB_throws).toHaveBeenCalledTimes(1);
    expect(cbC_should_not_fire).not.toHaveBeenCalled();
  });

  // ── Negative coverage: empty/undefined callback list keeps existing F4 path ────
  it('regression: undefined onPaidCallbacks behaves identically to existing F4 admin manual mark-paid path', async () => {
    const deps = makeDepsWithCallbacks(
      makeIssuedInvoice(),
      makeSettings(),
      [], // empty — existing callers of makeRecordPaymentDeps that don't pass a list
    );
    // Drop the callbacks field entirely to reproduce "caller didn't opt-in"
    delete (deps as { onPaidCallbacks?: unknown }).onPaidCallbacks;

    const r = await recordPayment(deps, baseInput);
    expect(r.ok).toBe(true);
  });
});
