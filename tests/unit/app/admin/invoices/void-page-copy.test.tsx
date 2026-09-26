/**
 * 088 — /admin/invoices/[invoiceId]/void page subtitle.
 *
 * Voiding an unpaid SC bill must not claim a "sequential tax-document number is
 * retired": the bill never had one. The page shows the bill wording with the
 * bill number, and keeps the tax-document wording for a legacy §87 invoice.
 *
 * The async RSC default export is invoked directly with mocked boundaries
 * (credit-notes-new-page-guard.test.tsx pattern); translations echo their key
 * and params so the chosen copy is asserted, not its wording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi
    .fn()
    .mockResolvedValue((key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
    ),
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/env', () => ({
  env: { features: { f088TaxAtPayment: true } },
}));

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: () => ({}),
  // Faithful reimplementations of the pure Domain helpers the page reads
  // (`src/modules/invoicing/domain/invoice.ts`); the barrel pulls in Drizzle
  // infra factories, so it is fully replaced.
  issuedInvoiceIdentity: (inv: {
    documentNumber: { raw: string } | null;
    billDocumentNumberRaw: string | null;
  }) => inv.documentNumber?.raw ?? inv.billDocumentNumberRaw ?? undefined,
  resolveTaxDocumentKind: (
    inv: { billDocumentNumberRaw: string | null; receiptDocumentNumberRaw: string | null },
    flagOn: boolean,
  ) => {
    if (!flagOn || inv.billDocumentNumberRaw === null) return 'none';
    return inv.receiptDocumentNumberRaw !== null ? 'tax_receipt' : 'bill';
  },
}));

// The client dialog is not under test here.
vi.mock(
  '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-confirm-dialog',
  () => ({ VoidConfirmDialog: () => null }),
);

import VoidInvoicePage from '@/app/(staff)/admin/invoices/[invoiceId]/void/page';

async function renderPage(): Promise<string> {
  const tree = await VoidInvoicePage({ params: Promise.resolve({ invoiceId: 'inv-1' }) });
  return renderToStaticMarkup(tree as ReactElement);
}

beforeEach(() => getInvoiceMock.mockReset());

describe('VoidInvoicePage — bill-aware description', () => {
  it('an unpaid 088 SC bill gets the bill wording with its bill number (no tax-document claim)', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: {
        status: 'issued',
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000007',
        receiptDocumentNumberRaw: null,
      },
    });
    const html = await renderPage();
    expect(html).toContain('descriptionBill|{&quot;number&quot;:&quot;SC-2026-000007&quot;}');
    expect(html).not.toMatch(/>description</);
  });

  it('a legacy §87 invoice keeps the tax-document wording', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: {
        status: 'issued',
        documentNumber: { raw: 'INV-2026-000001' },
        billDocumentNumberRaw: null,
        receiptDocumentNumberRaw: null,
      },
    });
    const html = await renderPage();
    expect(html).toMatch(/>description</);
    expect(html).not.toContain('descriptionBill');
  });
});
