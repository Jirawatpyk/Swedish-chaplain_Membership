/**
 * 088 T072b (FR-036) — structural guard for the per-row portal PDF control.
 *
 * The @a11y e2e (`tests/e2e/invoicing/portal-invoices-a11y.spec.ts`) is
 * preview-authoritative (it emits documented 320px/target-size noise on local
 * dev). This RTL test is the LOAD-BEARING local verification for the three
 * FR-036 claims the T072b requirement makes about the per-row PDF view/download
 * control, asserted at the component boundary (deterministic, layout-free):
 *
 *   1. aria-label — the control carries the caller-supplied accessible name
 *      that names the document (kind + number, e.g. "Download tax receipt PDF
 *      for invoice RC-2026-000123"), and falls back to `label` when omitted.
 *   2. target size — the control FORWARDS the caller's `className` verbatim, so
 *      the `min-h-11` (≥44px) the card/table/detail pass actually lands on the
 *      rendered `<button>`.
 *   3. download filename encodes the KIND — the receipt variant builds the
 *      fetch+blob fallback filename with a `-receipt.pdf` suffix and hits the
 *      `…/receipt/pdf` route; the invoice variant serves the plain
 *      `<number>.pdf` from the `…/pdf` route. (The control is a fetch+blob
 *      `<button>`, NOT an `<a download>` — the JSON-leak hardening from Round 6
 *      — so the "download attribute" is the fallback filename handed to
 *      `downloadPdf`, which the server Content-Disposition may further refine.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Hoisted mock fns — `vi.mock` factories are hoisted above module top-level, so
// the spies they reference must be created via `vi.hoisted` (not plain consts).
const { toastLoading, toastDismiss, downloadPdf } = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'loading-id'),
  toastDismiss: vi.fn(),
  // The fetch+blob helper — capture the exact `{ url, fallbackFilename }` the
  // control hands it (the filename is where the document KIND is encoded). It
  // returns a NEVER-resolving promise so the control's `await` suspends and its
  // `finally` (setLoading(false)) never fires a post-assert state update — the
  // call itself happens SYNCHRONOUSLY on click, which is all we assert.
  downloadPdf: vi.fn(() => new Promise<void>(() => {})),
}));

// next-intl: the control calls `useTranslations('portal.invoices.toast')` for
// the toast copy only — an identity translator suffices (download is mocked).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// sonner: the control fires a loading toast before the await + dismisses in
// finally. Stub so no real toaster is needed.
vi.mock('sonner', () => ({
  toast: {
    loading: toastLoading,
    dismiss: toastDismiss,
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/download-pdf-client', () => ({ downloadPdf }));

import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';

const INVOICE_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  downloadPdf.mockClear();
  toastLoading.mockClear();
  toastDismiss.mockClear();
});

describe('PortalReceiptDownloadButton — receipt kind (RC)', () => {
  it('carries the caller aria-label (kind + number) and forwards the min-h-11 target-size class', () => {
    render(
      <PortalReceiptDownloadButton
        invoiceId={INVOICE_ID}
        documentNumber="RC-2026-000123"
        label="Receipt"
        ariaLabel="Download tax receipt PDF for invoice RC-2026-000123"
        className="button-base min-h-11 px-3"
      />,
    );

    const btn = screen.getByRole('button', {
      name: 'Download tax receipt PDF for invoice RC-2026-000123',
    });
    // Target size: the caller's ≥44px class must reach the rendered button.
    expect(btn.className).toContain('min-h-11');
    // Visible label stays the short "Receipt".
    expect(btn).toHaveTextContent('Receipt');
  });

  it('downloads the …/receipt/pdf route with a KIND-ENCODED "-receipt.pdf" fallback filename', () => {
    render(
      <PortalReceiptDownloadButton
        invoiceId={INVOICE_ID}
        documentNumber="RC-2026-000123"
        label="Receipt"
        ariaLabel="Download tax receipt PDF for invoice RC-2026-000123"
        className="min-h-11 px-3"
      />,
    );

    // The handler invokes downloadPdf SYNCHRONOUSLY (before its await).
    fireEvent.click(screen.getByRole('button'));

    expect(downloadPdf).toHaveBeenCalledTimes(1);
    expect(downloadPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `/api/portal/invoices/${INVOICE_ID}/receipt/pdf`,
        // The kind is encoded in the filename via the `-receipt` suffix.
        fallbackFilename: 'RC-2026-000123-receipt.pdf',
      }),
    );
  });
});

describe('PortalInvoiceDownloadButton — invoice/bill kind (SC/INV)', () => {
  it('falls the aria-label back to `label` when no ariaLabel is supplied', () => {
    render(
      <PortalInvoiceDownloadButton
        invoiceId={INVOICE_ID}
        documentNumber="SC-2026-000045"
        label="Invoice"
        className="min-h-11 px-3"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Invoice' });
    expect(btn).toHaveAttribute('aria-label', 'Invoice');
    expect(btn.className).toContain('min-h-11');
  });

  it('downloads the …/pdf route with the "<number>.pdf" fallback filename (SC prefix encodes the bill kind)', () => {
    render(
      <PortalInvoiceDownloadButton
        invoiceId={INVOICE_ID}
        documentNumber="SC-2026-000045"
        label="Invoice"
        ariaLabel="Download tax invoice PDF for invoice SC-2026-000045"
        className="min-h-11 px-3"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(downloadPdf).toHaveBeenCalledTimes(1);
    expect(downloadPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `/api/portal/invoices/${INVOICE_ID}/pdf`,
        fallbackFilename: 'SC-2026-000045.pdf',
      }),
    );
  });
});
