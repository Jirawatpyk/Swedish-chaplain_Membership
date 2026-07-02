/**
 * T107 unit tests — resend-pdf use case.
 *
 * Covers the decision branches:
 *   1. invoice+invoice variant → invoice_pdf_resent audit + outbox
 *   2. invoice+receipt variant → receipt_pdf_resent audit + outbox
 *   3. credit_note variant    → credit_note_pdf_resent audit + outbox
 *   4. invoice not found      → invoice_cross_tenant_probe + not_found
 *   5. member mismatch (inv)  → probe + not_found (opaque)
 *   6. invoice not issued     → not_issued (no audit, no enqueue)
 *   7. receipt variant — no receiptPdf → no_receipt_pdf
 *   8. credit_note not found  → credit_note_cross_tenant_probe + not_found
 *   9. CN member mismatch     → probe + not_found (opaque)
 *  10. impossible buyer (memberId null AND eventRegistrationId null) →
 *      not_issued, REJECTED BEFORE any side effect (no enqueue, no audit)
 *
 * 100% branch coverage on the Application-layer use case keeps the
 * Constitution Principle II "security-critical 100% branch" contract
 * — resend is a PII-exfil surface (emails PDFs with tenant + member
 * identity snapshots).
 */
import { describe, expect, it, vi } from 'vitest';
import { resendPdf } from '@/modules/invoicing/application/use-cases/resend-pdf';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { asCreditNoteId, type CreditNote } from '@/modules/invoicing/domain/credit-note';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { InvoiceFixtureOverrides } from '../../helpers/invoice-fixture-overrides';

const TENANT = 'test-tenant';
const INVOICE_UUID = '11111111-2222-4333-8444-555555555555';
const CN_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function sha(): Sha256Hex {
  const parsed = Sha256Hex.parse(
    'a'.repeat(64),
  );
  if (!parsed.ok) throw new Error('bad fixture hash');
  return parsed.value;
}

function docNum(): DocumentNumber {
  const parsed = DocumentNumber.parse('INV-2026-000001');
  if (!parsed.ok) throw new Error('bad fixture doc number');
  return parsed.value;
}

function memberSnap(email = 'member@example.com') {
  return makeMemberIdentitySnapshot({
    legal_name: 'Test Co',
    tax_id: '0105537000000',
    address: '1 Test Rd',
    primary_contact_name: 'Somchai',
    primary_contact_email: email,
  });
}

function tenantSnap() {
  return makeTenantIdentitySnapshot({
    legal_name_th: 'หอการค้า',
    legal_name_en: 'Chamber Co',
    tax_id: '0105500000000',
    address_th: '1 ถนนทดสอบ',
    address_en: '1 Chamber Rd',
    logo_blob_key: null,
  });
}

function issuedInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return {
    tenantId: TENANT,
    invoiceId: asInvoiceId(INVOICE_UUID),
    memberId: 'member-m1',
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'u-admin',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_00n),
    total: Money.fromSatangUnsafe(107_00n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: tenantSnap(),
    memberIdentitySnapshot: memberSnap(),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: { blobKey: 'blob:inv-key', sha256: sha(), templateVersion: 1 },
    receiptPdf: null,
    lines: [],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function paidInvoiceWithReceipt(): Invoice {
  return issuedInvoice({
    status: 'paid',
    paidAt: '2026-04-20T00:00:00Z',
    paymentDate: '2026-04-20',
    paymentMethod: 'bank_transfer',
    paymentRecordedByUserId: 'u-admin',
    receiptPdf: { blobKey: 'blob:rcpt-key', sha256: sha(), templateVersion: 1 },
  });
}

const EVENT_REGISTRATION_UUID = 'cccccccc-dddd-4eee-8fff-000000000000';
const EVENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * 054-event-fee-invoices — a NON-member EVENT-fee invoice: `memberId` is null
 * (the buyer is a non-member attendee), `invoiceSubject === 'event'`, and the
 * F6 `event_registration_id` is set. Resending the invoice PDF must NOT emit a
 * timeline-typed audit row with `member_id: ''` (the bug). It must emit the
 * non-member variant carrying `event_registration_id` and NO `member_id` key.
 */
function nonMemberEventInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return issuedInvoice({
    memberId: null,
    invoiceSubject: 'event',
    eventId: EVENT_UUID,
    eventRegistrationId: EVENT_REGISTRATION_UUID,
    vatInclusive: true,
    planId: null,
    planYear: null,
    ...overrides,
  });
}

function creditNoteFixture(): CreditNote {
  return {
    tenantId: TENANT,
    creditNoteId: asCreditNoteId(CN_UUID),
    originalInvoiceId: asInvoiceId(INVOICE_UUID),
    originalInvoiceMemberId: 'member-m1',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-21',
    issuedByUserId: 'u-admin',
    reason: 'Partial refund',
    creditAmount: Money.fromSatangUnsafe(50_00n),
    vat: Money.fromSatangUnsafe(3_50n),
    total: Money.fromSatangUnsafe(53_50n),
    tenantIdentitySnapshot: tenantSnap(),
    memberIdentitySnapshot: memberSnap(),
    pdf: { blobKey: 'blob:cn-key', sha256: sha(), templateVersion: 1 },
    sourceRefundId: null,
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T00:00:00Z',
  };
}

function makeDeps(
  invoice: Invoice | null,
  cn: CreditNote | null = null,
) {
  const audit = { emit: vi.fn(async () => {}) };
  const outbox = { enqueue: vi.fn(async () => {}) };
  const invoiceRepo = {
    withTx: vi.fn(),
    insertDraft: vi.fn(),
    findByIdInTx: vi.fn(),
    findById: vi.fn(async () => invoice),
    list: vi.fn(),
    listPaged: vi.fn(),
    applyIssue: vi.fn(),
    deleteDraft: vi.fn(),
    applyPayment: vi.fn(),
    applyDraftUpdate: vi.fn(),
    findByIdInTxForUpdate: vi.fn(),
    lockForUpdate: vi.fn(),
    applyCreditNoteRollup: vi.fn(),
    applyInvoicePdfRegeneration: vi.fn(),
    applyReceiptPdfRegeneration: vi.fn(),
    applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
  } as unknown as import('@/modules/invoicing/application/ports/invoice-repo').InvoiceRepo;
  const creditNoteRepo = {
    insertCreditNote: vi.fn(),
    findById: vi.fn(async () => cn),
    findByOriginalInvoice: vi.fn(),
    findByOriginalInvoiceInTx: vi.fn(),
    listPaged: vi.fn(),
  } as unknown as import('@/modules/invoicing/application/ports/credit-note-repo').CreditNoteRepo;
  return { invoiceRepo, creditNoteRepo, audit, outbox };
}

const adminActor = {
  userId: 'u-admin',
  role: 'admin' as const,
  requestId: 'req-1',
};

describe('resendPdf', () => {
  it('invoice variant — enqueues invoice_pdf_resent outbox row + audits with member_id', async () => {
    const invoice = issuedInvoice();
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: adminActor,
    });
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqCall = (deps.outbox.enqueue as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as Record<string, unknown>;
    expect(enqCall.eventType).toBe('invoice_pdf_resent');
    expect(enqCall.pdfBlobKey).toBe('blob:inv-key');
    expect(enqCall.pdfTemplateVersion).toBe(1);
    expect(enqCall.recipientEmail).toBe('member@example.com');

    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as {
      eventType: string;
      summary: string;
      payload: Record<string, unknown>;
    };
    expect(auditCall.eventType).toBe('invoice_pdf_resent');
    expect(auditCall.payload.member_id).toBe('member-m1');
    expect(auditCall.payload.pdf_template_version).toBe(1);
    // P2 Wave-0 (PDPA data-minimization) — the persisted `summary` must NOT
    // carry the plaintext recipient email; the hashed recipient lives in the
    // payload (recipient_email_sha256) for correlation.
    expect(auditCall.summary).not.toContain('member@example.com');
    expect(auditCall.payload.recipient_email_sha256).toBeTruthy();
  });

  it('invoice variant — NON-MEMBER event invoice → emits invoice_pdf_resent with event_registration_id and NO member_id key', async () => {
    // BUG REGRESSION (054-event-fee-invoices): resend-pdf coalesced
    // `invoice.memberId ?? ''` for a non-member event invoice, persisting a
    // timeline-typed audit row with `member_id: ''`. The members
    // last_activity_at trigger then casts `(payload->>'member_id')::uuid` →
    // throws invalid_text_representation → silent no-op + structurally-invalid
    // row on the 10-year tax-document audit trail. The fix routes the
    // non-member branch through the typed non-member helper: payload carries
    // `event_registration_id`, `member_id` is ABSENT (not '').
    const invoice = nonMemberEventInvoice();
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: adminActor,
    });
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqCall = (deps.outbox.enqueue as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as Record<string, unknown>;
    expect(enqCall.eventType).toBe('invoice_pdf_resent');

    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(auditCall.eventType).toBe('invoice_pdf_resent');
    // The audit row MUST carry the F6 registration id (non-member correlation).
    expect(auditCall.payload.event_registration_id).toBe(EVENT_REGISTRATION_UUID);
    // member_id MUST be ABSENT — not '' (the bug), not the member id.
    expect(auditCall.payload).not.toHaveProperty('member_id');
  });

  it('receipt variant — enqueues receipt_pdf_resent + audit WITHOUT member_id', async () => {
    const invoice = paidInvoiceWithReceipt();
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'receipt',
      actor: adminActor,
    });
    expect(r.ok).toBe(true);
    const enqCall = (deps.outbox.enqueue as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as Record<string, unknown>;
    expect(enqCall.eventType).toBe('receipt_pdf_resent');
    expect(enqCall.pdfBlobKey).toBe('blob:rcpt-key');

    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(auditCall.eventType).toBe('receipt_pdf_resent');
    // member_id DELIBERATELY absent (operational duplicate of invoice_paid).
    expect(auditCall.payload).not.toHaveProperty('member_id');
  });

  it('credit_note variant — enqueues credit_note_pdf_resent + audit', async () => {
    const cn = creditNoteFixture();
    const deps = makeDeps(null, cn);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'credit_note',
      creditNoteId: CN_UUID,
      actor: adminActor,
    });
    expect(r.ok).toBe(true);
    const enqCall = (deps.outbox.enqueue as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as Record<string, unknown>;
    expect(enqCall.eventType).toBe('credit_note_pdf_resent');
    expect(enqCall.creditNoteId).toBe(CN_UUID);
    expect(enqCall.pdfBlobKey).toBe('blob:cn-key');

    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(auditCall.eventType).toBe('credit_note_pdf_resent');
  });

  it('invoice not found — emits cross-tenant probe + returns not_found', async () => {
    const deps = makeDeps(null);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: adminActor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as { eventType: string };
    expect(auditCall.eventType).toBe('invoice_cross_tenant_probe');
  });

  it('member mismatch — collapses to not_found (opaque) + probe audit', async () => {
    const invoice = issuedInvoice(); // memberId = 'member-m1'
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: {
        userId: 'u-member',
        role: 'member',
        memberId: 'DIFFERENT-MEMBER',
        requestId: 'req-2',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(auditCall.eventType).toBe('invoice_cross_tenant_probe');
    expect(auditCall.payload.actor_role).toBe('member');
  });

  it('invoice not issued (pdf null) — returns not_issued, no enqueue, no audit', async () => {
    const invoice = issuedInvoice({ pdf: null, memberIdentitySnapshot: null });
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: adminActor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_issued');
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('impossible buyer (memberId null AND eventRegistrationId null) — rejected BEFORE enqueue, no side effects', async () => {
    // FIX 2 (054 Round-2): a structurally-impossible row — neither a member
    // invoice (memberId set) nor a non-member event invoice
    // (eventRegistrationId set) — violates the DB CHECK
    // `invoices_subject_fields_ck`. The use-case cannot construct a valid audit
    // payload (no correlation key), so it MUST reject the row BEFORE the outbox
    // enqueue. Previously the guard lived AFTER the enqueue, so the buyer still
    // received the email even though the caller saw `not_issued`. This fixture
    // uses the flattened override type to build the CHECK-violating shape on
    // purpose (see invoice-fixture-overrides.ts) and asserts NO email was sent.
    const invoice = issuedInvoice({ memberId: null, eventRegistrationId: null });
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'invoice',
      actor: adminActor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_issued');
    // The critical assertion: the email was NOT enqueued. A structurally-broken
    // row must produce ZERO side effects, not "error to caller + email to buyer".
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('receipt variant — no receiptPdf → no_receipt_pdf', async () => {
    const invoice = issuedInvoice(); // receiptPdf = null
    const deps = makeDeps(invoice);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'invoice',
      invoiceId: INVOICE_UUID,
      variant: 'receipt',
      actor: adminActor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_receipt_pdf');
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('credit_note not found — emits cross-tenant probe + not_found', async () => {
    const deps = makeDeps(null, null);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'credit_note',
      creditNoteId: CN_UUID,
      actor: adminActor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as { eventType: string };
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
  });

  it('CN member mismatch — collapses to not_found + probe audit', async () => {
    const cn = creditNoteFixture(); // originalInvoiceMemberId = 'member-m1'
    const deps = makeDeps(null, cn);
    const r = await resendPdf(deps, {
      tenantId: TENANT,
      kind: 'credit_note',
      creditNoteId: CN_UUID,
      actor: {
        userId: 'u-member',
        role: 'member',
        memberId: 'DIFFERENT-MEMBER',
        requestId: null,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
    const auditCall = (deps.audit.emit as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![1] as { eventType: string };
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });
});

