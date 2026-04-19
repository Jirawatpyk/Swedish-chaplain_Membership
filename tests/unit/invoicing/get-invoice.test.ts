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
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdfBlobKey: null,
    pdfSha256: null,
    pdfTemplateVersion: null,
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
        findDraftById: vi.fn(),
        findById: vi.fn(async () => invoice),
        list: vi.fn(),
        listPaged: vi.fn(),
        applyIssue: vi.fn(),
        deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => ({ status: 'issued' as const })),
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
        findDraftById: vi.fn(),
        findById: vi.fn(async () => null),
        list: vi.fn(),
        listPaged: vi.fn(),
        applyIssue: vi.fn(),
        deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => ({ status: 'issued' as const })),
      },
    };
    const r = await getInvoice(deps, { tenantId: 't', invoiceId: 'missing' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});
