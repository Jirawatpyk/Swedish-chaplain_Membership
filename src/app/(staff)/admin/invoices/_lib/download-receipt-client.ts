'use client';

/**
 * Admin-scope thin wrappers around the shared `downloadPdf` helper.
 *
 * Previously this file owned the fetch+blob+toast logic directly; in
 * Round 6 it was extracted to `src/lib/download-pdf-client.ts` so the
 * portal member surface could share the same JSON-leak hardening
 * (Rounds 1-4). This file now exists solely to preserve the admin
 * call-site API (`downloadInvoice` / `downloadReceipt` accept
 * `{ invoiceId, ... }` and the URL is built internally).
 *
 * New code should import `downloadPdf` from `@/lib/download-pdf-client`
 * directly — pass the URL explicitly.
 */

import { downloadPdf } from '@/lib/download-pdf-client';

export type ReceiptDownloadToasts = {
  readonly pending: string;
  readonly failed: (reason: string) => string;
  readonly forbidden: string;
  readonly unavailable: string;
  readonly sessionExpired: string;
  readonly rateLimited: string;
};

export type ReceiptDownloadDeps = {
  readonly invoiceId: string;
  readonly fallbackFilename: string;
  readonly toasts: ReceiptDownloadToasts;
  readonly toastWarning: (msg: string) => void;
  readonly toastError: (msg: string) => void;
};

export type InvoiceDownloadToasts = {
  readonly forbidden: string;
  readonly notFound: string;
  readonly unavailable: string;
  readonly sessionExpired: string;
  readonly rateLimited: string;
};

export type InvoiceDownloadDeps = {
  readonly invoiceId: string;
  readonly fallbackFilename: string;
  readonly toasts: InvoiceDownloadToasts;
  readonly toastWarning: (msg: string) => void;
  readonly toastError: (msg: string) => void;
};

/** Admin invoice PDF download (`/api/invoices/[id]/pdf`). */
export function downloadInvoice(deps: InvoiceDownloadDeps): Promise<void> {
  return downloadPdf({
    url: `/api/invoices/${deps.invoiceId}/pdf`,
    fallbackFilename: deps.fallbackFilename,
    toasts: deps.toasts,
    toastWarning: deps.toastWarning,
    toastError: deps.toastError,
  });
}

/** Admin receipt PDF download (`/api/invoices/[id]/receipt/pdf`). */
export function downloadReceipt(deps: ReceiptDownloadDeps): Promise<void> {
  return downloadPdf({
    url: `/api/invoices/${deps.invoiceId}/receipt/pdf`,
    fallbackFilename: deps.fallbackFilename,
    toasts: deps.toasts,
    toastWarning: deps.toastWarning,
    toastError: deps.toastError,
  });
}
