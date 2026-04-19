/**
 * T034 unit tests — 100% branch coverage.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { updateInvoiceDraft } from '@/modules/invoicing/application/use-cases/update-invoice-draft';
import { asInvoiceId, type Invoice, type InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const INVOICE_ID = '00000000-0000-0000-0000-00000000a001';

function makeDraft(overrides: Partial<Invoice> = {}): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'm',
    planId: 'corporate-regular',
    planYear: 2026,
    status: 'draft',
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
    ...overrides,
  } as Invoice;
}

import type { UpdateInvoiceDraftDeps } from '@/modules/invoicing/application/use-cases/update-invoice-draft';

type TestDeps = UpdateInvoiceDraftDeps & {
  _tx: { execute: ReturnType<typeof vi.fn> };
};

function makeDeps(draft: Invoice | null): TestDeps {
  const tx = { execute: vi.fn(async () => []) };
  const withTx = async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx);
  return {
    invoiceRepo: {
      withTx,
      insertDraft: vi.fn(),
      findDraftById: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as const),
    },
    audit: { emit: vi.fn(async () => {}) },
    _tx: tx,
  };
}

const baseInput = {
  tenantId: 't',
  actorUserId: 'u',
  requestId: 'req',
  invoiceId: INVOICE_ID,
};

describe('updateInvoiceDraft', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invoice_not_found when repo returns null', async () => {
    const deps = makeDeps(null);
    const r = await updateInvoiceDraft(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
  });

  it.each(['issued', 'paid', 'void', 'credited'] as const)(
    'not_draft when status=%s',
    async (status) => {
      const deps = makeDeps(makeDraft({ status: status as InvoiceStatus }));
      const r = await updateInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('not_draft');
    },
  );

  it('no-diff call returns early (no UPDATE, no audit)', async () => {
    const draft = makeDraft();
    const deps = makeDeps(draft);
    const r = await updateInvoiceDraft(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps._tx.execute).not.toHaveBeenCalled();
  });

  it('changing auto_email_on_issue triggers 1 UPDATE + audit with diff', async () => {
    const deps = makeDeps(makeDraft({ autoEmailOnIssue: null }));
    const r = await updateInvoiceDraft(deps, { ...baseInput, autoEmailOnIssue: true });
    expect(r.ok).toBe(true);
    expect(deps.invoiceRepo.applyDraftUpdate).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyDraftUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoEmailOnIssue: true }),
    );
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_draft_updated',
        payload: expect.objectContaining({
          diff: expect.objectContaining({
            auto_email_on_issue: { from: null, to: true },
          }),
        }),
      }),
    );
  });

  it('changing plan_id + plan_year triggers single combined UPDATE + combined audit', async () => {
    const deps = makeDeps(
      makeDraft({ planId: 'corporate-regular', planYear: 2026 }),
    );
    const r = await updateInvoiceDraft(deps, {
      ...baseInput,
      planId: 'corporate-premium',
      planYear: 2027,
    });
    expect(r.ok).toBe(true);
    // One atomic UPDATE via the repo port carries both fields.
    expect(deps.invoiceRepo.applyDraftUpdate).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyDraftUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        planId: 'corporate-premium',
        planYear: 2027,
      }),
    );
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({
          diff: {
            plan_id: { from: 'corporate-regular', to: 'corporate-premium' },
            plan_year: { from: 2026, to: 2027 },
          },
        }),
      }),
    );
  });

  it('identical-value call is not a diff (plan_id unchanged)', async () => {
    const deps = makeDeps(makeDraft({ planId: 'same' }));
    const r = await updateInvoiceDraft(deps, { ...baseInput, planId: 'same' });
    expect(r.ok).toBe(true);
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('requestId undefined → audit records null', async () => {
    const deps = makeDeps(makeDraft());
    const rest = {
      tenantId: 't',
      actorUserId: 'u',
      invoiceId: INVOICE_ID,
      autoEmailOnIssue: true,
    };
    const r = await updateInvoiceDraft(deps, rest);
    expect(r.ok).toBe(true);
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: null }),
    );
  });
});
