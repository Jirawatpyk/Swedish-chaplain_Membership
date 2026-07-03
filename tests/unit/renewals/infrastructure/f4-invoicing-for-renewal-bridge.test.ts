/**
 * 088-invoice-tax-flow-redesign — T069 [US1 AS5 / FR-018] unit:
 * `f4InvoicingForRenewalBridge` number-resolution.
 *
 * The online renewal issue bridge composes F4 `createInvoiceDraft` →
 * `issueInvoice` and must surface the issued invoice's PRINTED number so
 * confirm-renewal / admin-renew-lapsed-member can carry it onto the
 * `renewal_invoice_created` audit + the success screen.
 *
 * Row-shape-correct resolution (NOT flag-gated — the shape of the returned
 * `Invoice` decides which number is set):
 *   - NEW flow (FEATURE_088_TAX_AT_PAYMENT on): the pre-payment document is a
 *     non-§87 ใบแจ้งหนี้ — `documentNumber` is NULL and the SC bill number lives
 *     in `billDocumentNumberRaw`. Surface the SC number.
 *   - LEGACY flow (flag off): the §87 §86/4 number is in `documentNumber`
 *     (a `DocumentNumber` value object); `billDocumentNumberRaw` is NULL.
 *     Surface `documentNumber.raw`.
 *
 * Regression guarded: the previous `issued.documentNumber !== null ?
 * String(issued.documentNumber) : ''` returned `''` for an 088 bill (blank
 * number on the renewal email/success screen) AND `'[object Object]'` for a
 * legacy row (`String()` on a `DocumentNumber` value object).
 *
 * The F4 barrel is MOCKED — this is a pure resolution unit; the live
 * bill→RC flow is proven in `tests/integration/invoicing/renewal-parity.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/invoicing', () => ({
  createInvoiceDraft: vi.fn(),
  issueInvoice: vi.fn(),
  makeCreateInvoiceDraftDeps: vi.fn(() => ({})),
  makeIssueInvoiceDeps: vi.fn(() => ({})),
}));

import { createInvoiceDraft, issueInvoice } from '@/modules/invoicing';
import { f4InvoicingForRenewalBridge } from '@/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';
import { parseThbDecimal } from '@/lib/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { Invoice } from '@/modules/invoicing/domain/invoice';

const mockedCreate = vi.mocked(createInvoiceDraft);
const mockedIssue = vi.mocked(issueInvoice);

/** Minimal issued-Invoice shape the bridge actually reads. */
function issuedFixture(overrides: {
  documentNumber: DocumentNumber | null;
  billDocumentNumberRaw: string | null;
}): Invoice {
  return {
    invoiceId: 'inv-1',
    status: 'issued',
    total: { satang: 1_284_000n },
    documentNumber: overrides.documentNumber,
    billDocumentNumberRaw: overrides.billDocumentNumberRaw,
  } as unknown as Invoice;
}

const BASE_INPUT = {
  tenantId: 't1',
  memberId: 'm1',
  planId: 'p1',
  planYear: 2026,
  frozenPlanPriceThb: parseThbDecimal('12000.00'),
  autoEmailOnIssue: true,
  actorUserId: 'u1',
  correlationId: 'c1',
  requestId: null,
} as const;

describe('088 T069 — f4InvoicingForRenewalBridge number resolution (FR-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreate.mockResolvedValue({
      ok: true,
      value: { invoiceId: 'inv-1' },
    } as unknown as Awaited<ReturnType<typeof createInvoiceDraft>>);
  });

  it('NEW flow: surfaces the SC bill number when documentNumber is NULL (never "")', async () => {
    mockedIssue.mockResolvedValue({
      ok: true,
      value: issuedFixture({
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000123',
      }),
    } as unknown as Awaited<ReturnType<typeof issueInvoice>>);

    const result = await f4InvoicingForRenewalBridge.issueInvoiceForRenewal(BASE_INPUT);

    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('expected issued');
    expect(result.invoiceNumber).toBe('SC-2026-000123');
    expect(result.invoiceNumber).not.toBe('');
  });

  it('LEGACY flow: surfaces documentNumber.raw (never "[object Object]")', async () => {
    const legacyDoc = DocumentNumber.of('IN', 2026, 45);
    if (!legacyDoc.ok) throw new Error('fixture doc number invalid');
    mockedIssue.mockResolvedValue({
      ok: true,
      value: issuedFixture({
        documentNumber: legacyDoc.value,
        billDocumentNumberRaw: null,
      }),
    } as unknown as Awaited<ReturnType<typeof issueInvoice>>);

    const result = await f4InvoicingForRenewalBridge.issueInvoiceForRenewal(BASE_INPUT);

    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('expected issued');
    expect(result.invoiceNumber).toBe('IN-2026-000045');
    expect(result.invoiceNumber).not.toBe('[object Object]');
  });

  it('defensive: both numbers NULL → empty string (no crash)', async () => {
    mockedIssue.mockResolvedValue({
      ok: true,
      value: issuedFixture({ documentNumber: null, billDocumentNumberRaw: null }),
    } as unknown as Awaited<ReturnType<typeof issueInvoice>>);

    const result = await f4InvoicingForRenewalBridge.issueInvoiceForRenewal(BASE_INPUT);

    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('expected issued');
    expect(result.invoiceNumber).toBe('');
  });
});
