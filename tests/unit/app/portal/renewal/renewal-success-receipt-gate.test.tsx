/**
 * 092 — /portal/renewal/[memberId]/success §86/4 receipt-download gate.
 *
 * After a §86/10 credit note (status → credited / partially_credited) the page's
 * receipt branch (page.tsx L228) was gated on `status === 'paid'`, so a credited
 * invoice fell through to the BILL download branch (L287) — resurfacing the
 * ใบแจ้งหนี้ instead of the §86/4 receipt. The gate now uses
 * `invoiceStatusHasReceipt(status)`; a credited invoice always has
 * `receiptPdfStatus === 'rendered'` (the issue-credit-note precondition), so it
 * matches the receipt branch first and never reaches the paid-only branches.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup; the two download buttons are stubbed to
 * markers that echo their `data-testid` (`receipt-download-link` vs
 * `invoice-download-link`) so the assertion isolates which branch fired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// --- infra / boundary mocks ----------------------------------------------

vi.mock('next/link', () => ({
  default: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getFormatter: vi.fn().mockResolvedValue({ dateTime: (d: Date) => d.toISOString() }),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => null }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: async () => ({ ok: true, value: { memberId: 'm1' } }),
    },
  }),
}));
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    cyclesRepo: {
      findMostRecentForMember: async () => ({
        status: 'completed',
        expiresAt: '2027-06-01T00:00:00Z',
      }),
    },
  }),
}));

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: () => ({}),
  // Faithful reimpl (real barrel pulls in Drizzle infra); matches
  // domain/invoice.ts billFirstDocumentNumber.
  billFirstDocumentNumber: (inv: {
    billDocumentNumberRaw?: string | null;
    documentNumber?: { raw: string } | null;
  }) => inv.billDocumentNumberRaw ?? inv.documentNumber?.raw ?? undefined,
  // 092 — faithful reimpl of domain/invoice.ts invoiceStatusHasReceipt.
  invoiceStatusHasReceipt: (status: string) =>
    status === 'paid' || status === 'partially_credited' || status === 'credited',
}));

// --- presentation stubs ---------------------------------------------------

vi.mock('@/components/layout', () => ({
  DetailContainer: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: () => null,
}));
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children?: unknown }) => children as ReactElement,
  CardContent: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/components/ui/button', () => ({
  buttonVariants: () => 'btn',
}));
vi.mock('@/app/(member)/portal/invoices/_components/portal-pdf-download-button', () => ({
  // Echo the branch-specific data-testid so the test can tell which download
  // (receipt vs bill/invoice) the page chose to render.
  PortalReceiptDownloadButton: (props: Record<string, unknown>) => (
    <button type="button" data-testid={props['data-testid'] as string} data-kind="receipt" />
  ),
  PortalInvoiceDownloadButton: (props: Record<string, unknown>) => (
    <button type="button" data-testid={props['data-testid'] as string} data-kind="invoice" />
  ),
}));

import RenewalSuccessPage from '@/app/(member)/portal/renewal/[memberId]/success/page';

/** A paid separate-mode renewal invoice with a rendered §86/4 receipt. */
function invoiceWith(status: string) {
  return {
    status,
    receiptPdfStatus: 'rendered',
    receiptDocumentNumberRaw: 'RC-2026-000010',
    documentNumber: { raw: 'INV-2026-000010' },
    billDocumentNumberRaw: null,
    // 092 follow-up — the receipt gate is blob-gated on `receiptPdf !== null`
    // (parity with the three sibling receipt gates). A real paid membership
    // renewal always carries a separate receiptPdf blob.
    receiptPdf: { blobKey: 'k', sha256: 'a'.repeat(64), templateVersion: 1 },
  };
}

async function renderPage(): Promise<string> {
  const tree = await RenewalSuccessPage({
    params: Promise.resolve({ memberId: 'm1' }),
    searchParams: Promise.resolve({ invoice: 'inv-1' }),
  });
  return renderToStaticMarkup(tree as ReactElement);
}

beforeEach(() => {
  getInvoiceMock.mockReset();
});

describe('RenewalSuccessPage — §86/4 receipt stays downloadable after a credit note (092)', () => {
  it('credited + rendered → renders the RECEIPT download (not the fall-through bill)', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('credited') });
    const html = await renderPage();
    expect(html).toContain('data-testid="receipt-download-link"');
    expect(html).toContain('data-kind="receipt"');
    // Pre-092 a credited invoice fell through to the ใบแจ้งหนี้/bill download.
    expect(html).not.toContain('data-kind="invoice"');
  });

  it('partially_credited + rendered → renders the RECEIPT download', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('partially_credited') });
    const html = await renderPage();
    expect(html).toContain('data-testid="receipt-download-link"');
    expect(html).not.toContain('data-kind="invoice"');
  });

  it('paid + rendered → still renders the RECEIPT download (unchanged)', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('paid') });
    const html = await renderPage();
    expect(html).toContain('data-testid="receipt-download-link"');
  });

  it('credited + rendered but receiptPdf NULL (as-paid / corrupt) → does NOT render the receipt button', async () => {
    // 092 follow-up — the gate now also requires `receiptPdf !== null` so it
    // never renders a receipt download whose /receipt/pdf endpoint has no
    // separate blob to serve (an as-paid row's receipt IS the main pdf, or a
    // corrupt two-step row). It falls through to the invoice/bill download.
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: { ...invoiceWith('credited'), receiptPdf: null },
    });
    const html = await renderPage();
    expect(html).not.toContain('data-testid="receipt-download-link"');
    expect(html).not.toContain('data-kind="receipt"');
    expect(html).toContain('data-kind="invoice"');
  });

  it('issued (not receipt-bearing) → renders the INVOICE/bill download (unchanged)', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: {
        status: 'issued',
        receiptPdfStatus: null,
        receiptDocumentNumberRaw: null,
        documentNumber: { raw: 'INV-2026-000011' },
        billDocumentNumberRaw: null,
      },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="invoice-download-link"');
    expect(html).toContain('data-kind="invoice"');
    expect(html).not.toContain('data-kind="receipt"');
  });
});
