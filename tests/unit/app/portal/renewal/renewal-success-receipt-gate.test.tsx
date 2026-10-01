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
 *
 * Spec 122 US7c (boards `Portal-renewal-success` / `-processing`): the hero,
 * the "Renewal details" AURA card and the AURA link buttons render for real
 * (`@jirawatpyk/aura-react/server`); only the shell and the download buttons
 * are stubbed. The download stubs echo their className so the primary vs
 * secondary treatment is asserted too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// --- infra / boundary mocks ----------------------------------------------

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a {...(rest as Record<string, string>)}>{children as ReactElement}</a>
  ),
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
  // The expiry date renders through formatDatePreset (real helper) with this locale.
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
  // 016 T027 — swept pages gate via requirePagePermission, which reads
  // getCurrentSession. Same session as requireSession so the case is unchanged.
  getCurrentSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
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
const findMostRecentForMemberMock = vi.fn();
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    cyclesRepo: {
      findMostRecentForMember: (...args: unknown[]) => findMostRecentForMemberMock(...args),
    },
  }),
}));
const COMPLETED_CYCLE = { status: 'completed', expiresAt: '2027-06-01T00:00:00Z' };

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
  PageHeader: (props: { title: string; subtitle: string; autoFocusTitle?: boolean }) => (
    <header data-autofocus-title={String(props.autoFocusTitle ?? false)}>
      <h1>{props.title}</h1>
      <p>{props.subtitle}</p>
    </header>
  ),
}));
vi.mock('@/app/(member)/portal/invoices/_components/portal-pdf-download-button', () => ({
  // Echo the branch-specific data-testid so the test can tell which download
  // (receipt vs bill/invoice) the page chose to render.
  PortalReceiptDownloadButton: (props: Record<string, unknown>) => (
    <button
      type="button"
      data-testid={props['data-testid'] as string}
      data-kind="receipt"
      className={props.className as string}
    />
  ),
  PortalInvoiceDownloadButton: (props: Record<string, unknown>) => (
    <button
      type="button"
      data-testid={props['data-testid'] as string}
      data-kind="invoice"
      className={props.className as string}
    />
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

async function renderPage(invoice: string | null = 'inv-1'): Promise<string> {
  const tree = await RenewalSuccessPage({
    params: Promise.resolve({ memberId: 'm1' }),
    searchParams: Promise.resolve(invoice === null ? {} : { invoice }),
  });
  return renderToStaticMarkup(tree as ReactElement);
}

/** The first element matching `selector` in the rendered markup. */
function nodeWith(html: string, selector: string): Element | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector(selector);
}

beforeEach(() => {
  getInvoiceMock.mockReset();
  findMostRecentForMemberMock.mockReset();
  findMostRecentForMemberMock.mockResolvedValue(COMPLETED_CYCLE);
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

// While the receipt renders, the page offers the invoice/bill PDF next to the
// "receipt preparing" status — the SC bill on an 088 bill (FR-015). The retired
// pre-088 combined-mode shape (NULL RC; 0 rows in prod) is not special-cased.
describe('RenewalSuccessPage — paid, receipt still rendering', () => {
  it('paid with no RC + pending → the invoice download + the preparing status', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: {
        ...invoiceWith('paid'),
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'pending',
        receiptPdf: null,
        pdfDocKind: 'invoice',
      },
    });
    const html = await renderPage();
    expect(html).toContain('data-kind="invoice"');
    expect(html).not.toContain('data-kind="receipt"');
    expect(html).toContain('receiptPreparing');
  });

  it('088 bill (SC + RC minted) + pending → the SC bill download stays (FR-015)', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: {
        ...invoiceWith('paid'),
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000045',
        receiptPdfStatus: 'pending',
        receiptPdf: null,
        pdfDocKind: 'invoice',
      },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="invoice-download-link"');
    expect(html).toContain('data-kind="invoice"');
    expect(html).toContain('receiptPreparing');
  });
});

describe('RenewalSuccessPage on AURA (boards Portal-renewal-success / -processing, US7c)', () => {
  it('complete: the hero reads "Renewal complete" with a check, focus lands on the h1', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('paid') });
    const html = await renderPage();
    const hero = nodeWith(html, '[data-testid="renewal-hero"]')!;
    expect(hero.querySelector('h1')?.textContent).toBe('title');
    expect(hero.textContent).toContain('subtitle');
    expect(hero.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(hero.querySelector('header')?.getAttribute('data-autofocus-title')).toBe('true');
    // A title shorter than its subtitle (TH "ต่ออายุสำเร็จ") sits in a
    // wider flex row; auto margins keep it centred under the check circle.
    expect(hero.className).toContain('[&_h1]:mx-auto');
  });

  it('complete: "Renewal details" is an AURA card with the new expiry and a "Completed" ready pill', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('paid') });
    const html = await renderPage();
    const card = nodeWith(html, 'section[aria-labelledby="renewal-details-heading"]')!;
    expect(card.className).toMatch(/aura-card/);
    expect(card.querySelector('#renewal-details-heading')?.textContent).toBe('detailsHeading');
    expect(card.querySelector('time')?.getAttribute('datetime')).toBe('2027-06-01T00:00:00Z');
    const pill = card.querySelector('.aura-pill');
    expect(pill?.textContent).toBe('completed');
    expect(pill?.className).toMatch(/aura-pill--ready/);
  });

  it('complete: the receipt download is the primary button, Back to portal the secondary one', async () => {
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('paid') });
    const html = await renderPage();
    expect(nodeWith(html, '[data-testid="receipt-download-link"]')?.className).toMatch(
      /aura-btn--primary/,
    );
    const back = nodeWith(html, 'a[href="/portal"]');
    expect(back?.textContent).toBe('backToPortal');
    expect(back?.className).toMatch(/aura-btn--secondary/);
  });

  it('receipt still rendering: the invoice download (secondary) and a busy "Receipt preparing…" placeholder', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: { ...invoiceWith('paid'), receiptPdfStatus: 'pending', receiptPdf: null, pdfDocKind: 'invoice' },
    });
    const html = await renderPage();
    expect(nodeWith(html, '[data-testid="invoice-download-link"]')?.className).toMatch(
      /aura-btn--secondary/,
    );
    const preparing = nodeWith(html, '[aria-busy="true"]')!;
    expect(preparing.textContent).toContain('receiptPreparing');
    // UX review: a server-rendered placeholder that never updates is not a
    // live region (a busy live region never announces).
    expect(preparing.getAttribute('role')).toBeNull();
    expect(preparing.getAttribute('aria-live')).toBeNull();
  });

  it('processing (no cycle yet): the hero reads "Payment received", the details card announces the wait', async () => {
    findMostRecentForMemberMock.mockResolvedValue(null);
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('paid') });
    const html = await renderPage();
    const hero = nodeWith(html, '[data-testid="renewal-hero"]')!;
    expect(hero.querySelector('h1')?.textContent).toBe('processingTitle');
    expect(hero.textContent).toContain('processingSubtitle');
    const status = nodeWith(html, '[role="status"][aria-live="polite"]')!;
    expect(status.textContent).toContain('processing');
    const back = nodeWith(html, '[data-testid="processing-back-to-portal"]')!;
    expect(back.className).toMatch(/aura-btn--secondary/);
    // Board: the card holds only the wait; the back CTA ends the actions row
    // after the invoice download, as on the completed page, and stays out of
    // the live region so the announcement is the wait alone.
    expect(status.querySelector('a')).toBeNull();
    const row = back.parentElement!;
    expect(row.lastElementChild).toBe(back);
    expect(row.children.length).toBeGreaterThan(1);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('a[href="/portal"]')).toHaveLength(1);
  });

  it('a cycle that is not completed yet gets the processing hero, never "Renewal complete" (financial review)', async () => {
    findMostRecentForMemberMock.mockResolvedValue({ status: 'awaiting_payment', expiresAt: '2026-12-31T00:00:00Z' });
    getInvoiceMock.mockResolvedValue({ ok: true, value: invoiceWith('issued') });
    const html = await renderPage();
    expect(nodeWith(html, '[data-testid="renewal-hero"] h1')?.textContent).toBe('processingTitle');
    expect(html).not.toContain('>title<');
  });

  it('no invoice id: the "View all invoices" fallback as a secondary AURA link', async () => {
    const html = await renderPage(null);
    const fallback = nodeWith(html, '[data-testid="view-invoices-fallback"]');
    expect(fallback?.getAttribute('href')).toBe('/portal/invoices');
    expect(fallback?.className).toMatch(/aura-btn--secondary/);
  });
});
