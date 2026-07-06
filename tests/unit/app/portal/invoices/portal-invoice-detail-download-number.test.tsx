/**
 * 088 FIX 4 — /portal/invoices/[invoiceId] main-download filename/aria for an
 * UNPAID 088 bill.
 *
 * For an issued-unpaid 088 ใบแจ้งหนี้ (taxDocKind === 'bill'), the main invoice
 * download's `documentNumber` prop (→ PDF filename + aria) came from
 * `mainDownloadNumber`, whose pre-fix ternary only used `billDocumentNumberRaw`
 * on the `tax_receipt` (paid) branch and otherwise fell to `documentNumber`
 * (`displayDocumentNumber(invoice) ?? '—'`). An unpaid 088 bill has NULL §87
 * `documentNumber` and NULL `receiptDocumentNumberRaw`, so it resolved to '—' —
 * the download was named "—.pdf" and the aria read "invoice —".
 *
 * The fix makes `mainDownloadNumber` reuse the already-correct `headerNumber`
 * (which is `billDocumentNumberRaw ?? '—'` for ANY 088 bill). This suite pins
 * that the invoice-download control carries the SC bill number, not '—'.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup; the invoice/receipt download buttons are
 * stubbed to markers that echo their `documentNumber` prop into `data-doc`, so
 * the assertion isolates `mainDownloadNumber` (the header title also carries the
 * SC number, hence the attribute-scoped assertion).
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
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => null,
}));
vi.mock('@/lib/env', () => ({
  // `bootstrap.adminEmail` is read by the issued-invoice OnlinePaymentDisabledCard
  // branch (env-proxy mailto, #145). The mock predated that read (mock drift),
  // so the issued-bill case threw `Cannot read properties of undefined
  // (reading 'adminEmail')` before its assertions ran. Completing the shape
  // (null → the "no email configured" degrade) is unrelated to the 090 fixes.
  env: {
    features: { f088TaxAtPayment: true, f5OnlinePayment: false },
    bootstrap: { adminEmail: null },
  },
}));

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: () => ({}),
  computeIsOverdue: () => false,
  asInvoiceId: (id: string) => id,
  // 092 — faithful reimpl (the real barrel pulls in Drizzle infra). Matches
  // domain/invoice.ts `invoiceStatusHasReceipt`: a §86/4 receipt exists + stays
  // downloadable for paid + partially_credited + credited (NOT void/issued/draft).
  invoiceStatusHasReceipt: (status: string) =>
    status === 'paid' || status === 'partially_credited' || status === 'credited',
  // Faithful reimplementation (barrel pulls in Drizzle infra); real helper is
  // unit-tested in its own suite. Matches domain/invoice.ts displayDocumentNumber.
  displayDocumentNumber: (inv: {
    documentNumber?: { raw: string } | null;
    receiptDocumentNumberRaw?: string | null;
  }) => inv.documentNumber?.raw ?? inv.receiptDocumentNumberRaw ?? undefined,
  // Faithful reimplementation of domain/invoice.ts resolveTaxDocumentKind
  // (barrel pulls in Drizzle infra; real helper is unit-tested in its own suite).
  resolveTaxDocumentKind: (
    inv: {
      billDocumentNumberRaw?: string | null;
      receiptDocumentNumberRaw?: string | null;
    },
    flagOn: boolean,
  ): 'none' | 'bill' | 'tax_receipt' =>
    !flagOn || inv.billDocumentNumberRaw == null
      ? 'none'
      : inv.receiptDocumentNumberRaw != null
        ? 'tax_receipt'
        : 'bill',
}));

vi.mock('@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo', () => ({
  makeDrizzleCreditNoteRepo: () => ({
    findByOriginalInvoice: async () => [],
  }),
}));
vi.mock('@/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo', () => ({
  makeDrizzleTenantPaymentSettingsRepo: () => ({ getByTenantId: async () => null }),
}));
vi.mock('@/modules/payments/infrastructure/repos/drizzle-payments-repo', () => ({
  makeDrizzlePaymentsRepo: () => ({ findStaleInvoiceAutoRefund: async () => null }),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: async () => ({ ok: true, value: { memberId: 'm1' } }),
    },
  }),
}));

// --- presentation stubs ---------------------------------------------------

vi.mock('@/components/layout', () => ({
  DetailContainer: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/components/layout/page-header', () => ({
  // Render title + actions so the invoice-download marker (inside `actions`)
  // reaches the output; `badge` is intentionally dropped (it only mounts the
  // OptimisticPaidOverlay client component, irrelevant to this assertion).
  PageHeader: ({ title, actions }: { title?: unknown; actions?: unknown }) => (
    <div>
      <span>{title as ReactElement}</span>
      <span>{actions as ReactElement}</span>
    </div>
  ),
}));
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children?: unknown }) => children as ReactElement,
  CardContent: ({ children }: { children?: unknown }) => children as ReactElement,
  CardHeader: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/components/ui/button', () => ({
  // 090 finding #5 — echo the chosen `variant` so a test can assert the
  // paid-invoice download hierarchy (receipt `default` primary, bill `outline`).
  buttonVariants: (opts?: { variant?: string }) => opts?.variant ?? 'default',
}));
vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children?: unknown }) => children as ReactElement,
  TableBody: ({ children }: { children?: unknown }) => children as ReactElement,
  TableCell: ({ children }: { children?: unknown }) => children as ReactElement,
  TableHead: ({ children }: { children?: unknown }) => children as ReactElement,
  TableHeader: ({ children }: { children?: unknown }) => children as ReactElement,
  TableRow: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/lib/utils', () => ({ cn: (...c: unknown[]) => c.filter(Boolean).join(' ') }));
vi.mock('@/app/(member)/portal/invoices/_utils/format', () => ({
  formatDate: (v: string | null) => v ?? '—',
  formatSatangThb: (v: bigint | null) => (v === null ? '—' : String(v)),
}));
vi.mock('@/app/(member)/portal/invoices/_utils/invoice-row-view-model', () => ({
  downloadLabelKeys: () => ({ labelKey: 'actions.downloadInvoice', ariaKey: 'actions.downloadInvoiceAria' }),
}));
vi.mock('@/app/(member)/portal/invoices/_utils/legacy-no-tin', () => ({
  isLegacyNoTinEventInvoice: () => false,
}));
vi.mock('@/app/(member)/portal/invoices/_components/invoice-status-badge', () => ({
  InvoiceStatusBadge: () => null,
}));
vi.mock('@/app/(member)/portal/invoices/_components/resend-invoice-button', () => ({
  ResendInvoiceButton: () => null,
}));
vi.mock('@/app/(member)/portal/invoices/_components/portal-pdf-download-button', () => ({
  PortalInvoiceDownloadButton: ({
    documentNumber,
    className,
  }: {
    documentNumber: string;
    className?: string;
  }) => (
    <button
      type="button"
      data-testid="portal-download-invoice-marker"
      data-doc={documentNumber}
      data-cls={className}
    />
  ),
  PortalReceiptDownloadButton: ({
    documentNumber,
    className,
  }: {
    documentNumber: string;
    className?: string;
  }) => (
    <button
      type="button"
      data-testid="portal-download-receipt-marker"
      data-doc={documentNumber}
      data-cls={className}
    />
  ),
}));
vi.mock('@/app/(member)/portal/invoices/_components/receipt-status-watcher', () => ({
  ReceiptStatusWatcher: () => null,
}));
vi.mock('@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-now-button', () => ({
  PayNowButton: () => null,
}));
vi.mock('@/app/(member)/portal/invoices/[invoiceId]/_components/online-payment-disabled-card', () => ({
  OnlinePaymentDisabledCard: () => null,
}));
vi.mock('@/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid-overlay', () => ({
  OptimisticPaidOverlay: () => null,
}));

import PortalInvoiceDetailPage from '@/app/(member)/portal/invoices/[invoiceId]/page';

/** An issued-unpaid 088 bill: SC bill number set, §87 + RC both NULL, PDF rendered. */
function issuedUnpaid088Bill() {
  return {
    invoiceId: 'inv-1',
    status: 'issued',
    invoiceSubject: 'membership',
    memberId: 'm1',
    documentNumber: null,
    billDocumentNumberRaw: 'SC-2026-000045',
    receiptDocumentNumberRaw: null,
    pdfDocKind: 'invoice',
    receiptPdfStatus: null,
    pdf: { blobKey: 'k' },
    receiptPdf: null,
    memberIdentitySnapshot: { tax_id: null },
    issueDate: '2026-05-15',
    dueDate: '2026-06-14',
    paidAt: null,
    voidedAt: null,
    voidReason: null,
    planYear: null,
    subtotal: { satang: 100_000n },
    vat: { satang: 7_000n },
    total: { satang: 107_000n },
    creditedTotal: { satang: 0n },
    lines: [],
  };
}

/** A PAID separate-mode invoice: §87 invoice number + rendered §86/4 RC. */
function paidSeparateInvoice() {
  return {
    invoiceId: 'inv-1',
    status: 'paid',
    invoiceSubject: 'membership',
    memberId: 'm1',
    documentNumber: { raw: 'INV-2026-000010' },
    billDocumentNumberRaw: null,
    receiptDocumentNumberRaw: 'RC-2026-000010',
    pdfDocKind: 'invoice',
    receiptPdfStatus: 'rendered',
    pdf: { blobKey: 'k' },
    receiptPdf: { blobKey: 'rk' },
    memberIdentitySnapshot: { tax_id: null },
    issueDate: '2026-05-15',
    dueDate: '2026-06-14',
    paidAt: '2026-05-20',
    voidedAt: null,
    voidReason: null,
    planYear: null,
    subtotal: { satang: 100_000n },
    vat: { satang: 7_000n },
    total: { satang: 107_000n },
    creditedTotal: { satang: 0n },
    lines: [],
  };
}

/** A separate-mode invoice credited by a §86/10 credit note (full → 'credited'). */
function creditedSeparateInvoice() {
  return { ...paidSeparateInvoice(), status: 'credited', creditedTotal: { satang: 107_000n } };
}

/** A separate-mode invoice partially credited (→ 'partially_credited'). */
function partiallyCreditedSeparateInvoice() {
  return { ...paidSeparateInvoice(), status: 'partially_credited', creditedTotal: { satang: 30_000n } };
}

async function renderPage(): Promise<string> {
  const tree = await PortalInvoiceDetailPage({ params: Promise.resolve({ invoiceId: 'inv-1' }) });
  return renderToStaticMarkup(tree as ReactElement);
}

beforeEach(() => {
  getInvoiceMock.mockReset();
});

describe('PortalInvoiceDetailPage — main-download number for an unpaid 088 bill (088 FIX 4)', () => {
  it('issued-unpaid 088 bill → invoice-download control uses the SC bill number, not "—"', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: issuedUnpaid088Bill() });
    const html = await renderPage();
    // The invoice-download marker echoes `mainDownloadNumber` into data-doc.
    expect(html).toContain('data-testid="portal-download-invoice-marker"');
    expect(html).toContain('data-doc="SC-2026-000045"');
    // Pre-fix the main download fell to displayDocumentNumber(...) ?? '—'.
    expect(html).not.toContain('data-doc="—"');
  });
});

describe('PortalInvoiceDetailPage — paid-invoice download hierarchy (090 finding #5)', () => {
  it('paid separate-mode → receipt button is the primary `default` CTA; the bill PDF is demoted to `outline`', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: paidSeparateInvoice() });
    const html = await renderPage();
    // Both downloads render.
    expect(html).toContain('data-testid="portal-download-invoice-marker"');
    expect(html).toContain('data-testid="portal-download-receipt-marker"');
    // The receipt is the filled/primary CTA; the bill is demoted to outline.
    // (buttonVariants is mocked to echo the variant into the className.)
    const receiptMarker = /data-testid="portal-download-receipt-marker"[^>]*data-cls="([^"]*)"/.exec(html);
    const invoiceMarker = /data-testid="portal-download-invoice-marker"[^>]*data-cls="([^"]*)"/.exec(html);
    expect(receiptMarker?.[1]).toContain('default');
    expect(invoiceMarker?.[1]).toContain('outline');
    // The demoted bill must NOT also be a filled `default` CTA.
    expect(invoiceMarker?.[1]).not.toContain('default');
  });
});

describe('PortalInvoiceDetailPage — §86/4 receipt stays downloadable after a credit note (092)', () => {
  // Prod UAT bug: after a §86/10 credit note the receipt download disappeared
  // because `showReceiptPdf` gated on `status === 'paid'`. The §86/4 receipt is
  // not cancelled by a credit note (Thai VAT §86/10) and the member must keep
  // downloading it. `showReceiptPdf` now gates on the receipt-bearing status set
  // {paid, partially_credited, credited}.
  it('credited separate-mode → the §86/4 receipt download control still renders (+ the bill PDF stays too)', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: creditedSeparateInvoice() });
    const html = await renderPage();
    expect(html).toContain('data-testid="portal-download-receipt-marker"');
    // Separate-mode → the bill / tax-invoice PDF is a distinct legal doc and
    // stays downloadable alongside the receipt.
    expect(html).toContain('data-testid="portal-download-invoice-marker"');
  });

  it('partially_credited separate-mode → the §86/4 receipt download control still renders', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: partiallyCreditedSeparateInvoice() });
    const html = await renderPage();
    expect(html).toContain('data-testid="portal-download-receipt-marker"');
  });

  it('credited separate-mode → the Receipt No. field still renders (092 finding #4 — gate centralised on invoiceStatusHasReceipt)', async () => {
    // The receipt-NUMBER display gate was hand-inlining the {paid,
    // partially_credited, credited} set; it now calls `invoiceStatusHasReceipt`.
    // Behaviour is identical — a credited row keeps showing its permanent §87
    // receipt number. The label key `fields.receiptNumber` renders only in this
    // one block (mocked `t` echoes the key).
    getInvoiceMock.mockResolvedValue({ ok: true, value: creditedSeparateInvoice() });
    const html = await renderPage();
    expect(html).toContain('fields.receiptNumber');
    expect(html).toContain('RC-2026-000010');
  });
});
