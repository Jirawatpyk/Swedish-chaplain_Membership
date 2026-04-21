/**
 * Get-invoice unit test — 100% coverage of the small use case.
 */
import { describe, expect, it, vi } from 'vitest';
import { getInvoice } from '@/modules/invoicing/application/use-cases/get-invoice';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

function makeStub(): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('i'),
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'u',
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
    autoEmailOnIssue: null,
    pdf: null,
    receiptPdf: null,
    lines: [],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  } as Invoice;
}

describe('getInvoice', () => {
  it('returns invoice when found', async () => {
    const invoice = makeStub();
    const deps = {
      invoiceRepo: {
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
      lockForUpdate: vi.fn(async () => 'issued' as const),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      },
    };
    const r = await getInvoice(deps, { tenantId: 't', invoiceId: 'i' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(invoice);
  });

  it('returns not_found when repo returns null', async () => {
    const deps = {
      invoiceRepo: {
        withTx: vi.fn(),
        insertDraft: vi.fn(),
        findByIdInTx: vi.fn(),
        findById: vi.fn(async () => null),
        list: vi.fn(),
        listPaged: vi.fn(),
        applyIssue: vi.fn(),
        deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as const),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      },
    };
    const r = await getInvoice(deps, { tenantId: 't', invoiceId: 'missing' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });

  // T069 polish — same-tenant member-mismatch branch added when the
  // portal detail page started routing through `getInvoice` instead
  // of duplicating the ownership check at the page layer.
  it('returns forbidden + emits probe when member actor != invoice memberId', async () => {
    const invoice = makeStub(); // memberId = 'm'
    const auditEmit: (a: unknown, b: unknown) => Promise<void> = vi.fn(
      async () => {},
    );
    const deps = {
      invoiceRepo: {
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
        lockForUpdate: vi.fn(async () => 'issued' as const),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      },
      audit: { emit: auditEmit },
    };
    const r = await getInvoice(deps, {
      tenantId: 't',
      invoiceId: 'i',
      actor: {
        userId: 'u-actor',
        role: 'member',
        requestId: 'req-1',
        memberId: 'OTHER-MEMBER',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(auditEmit).toHaveBeenCalledTimes(1);
    const mockedEmit = auditEmit as unknown as { mock: { calls: unknown[][] } };
    const event = mockedEmit.mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(event.eventType).toBe('invoice_cross_tenant_probe');
    expect(event.payload).toMatchObject({
      attempted_invoice_id: 'i',
      actor_role: 'member',
      actor_member_id: 'OTHER-MEMBER',
      invoice_member_id: 'm',
    });
  });

  it('member with matching memberId still receives the invoice', async () => {
    const invoice = makeStub(); // memberId = 'm'
    const auditEmit: (a: unknown, b: unknown) => Promise<void> = vi.fn(
      async () => {},
    );
    const deps = {
      invoiceRepo: {
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
        lockForUpdate: vi.fn(async () => 'issued' as const),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      },
      audit: { emit: auditEmit },
    };
    const r = await getInvoice(deps, {
      tenantId: 't',
      invoiceId: 'i',
      actor: {
        userId: 'u-actor',
        role: 'member',
        requestId: null,
        memberId: 'm',
      },
    });
    expect(r.ok).toBe(true);
    expect(auditEmit).not.toHaveBeenCalled();
  });
});
