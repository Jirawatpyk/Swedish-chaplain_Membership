'use client';

/**
 * Portal member PDF download button — Round 6 portal-harden pass.
 *
 * Closes the JSON-in-new-tab leak that previously affected every
 * `<a href="/api/portal/invoices/.../pdf" download>` site on the
 * member portal (list, detail, summary card, renewal success page).
 * The plain anchor opened 4xx/5xx JSON responses in a new tab; the
 * fetch+blob pattern lets us surface 401/403/404/425/429/502/5xx as
 * structured toasts instead.
 *
 * Mirrors the admin pattern established by Rounds 1-4:
 *   - `toast.loading` fires BEFORE the await so the click → download
 *     window has continuous SR + visual feedback (R4-C2).
 *   - `try/finally` cleanup guards spinner state from sticking if the
 *     helper throws unexpectedly (R4-code-B1).
 *   - `motion-safe:animate-spin` so reduced-motion users don't see a
 *     continuously spinning icon.
 *   - Optional `toastSuccess` fires on fast-cache hits where the
 *     loading toast dismisses before the user sees it (R5-UX-M1).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { downloadPdf, type PdfDownloadToasts } from '@/lib/download-pdf-client';
import { cn } from '@/lib/utils';

type Variant = 'invoice' | 'receipt';

interface BaseProps {
  readonly invoiceId: string;
  /** Used to build the fallback filename. Prefer documentNumber.raw. */
  readonly documentNumber: string;
  readonly label: string;
  /**
   * Optional SR-only label. When omitted, `label` is used (which is
   * already the visible button text and reads naturally for SR users).
   * Supply when the visible label is generic ("Download") and the SR
   * text needs the document number for orientation.
   */
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

interface PortalPdfDownloadButtonProps extends BaseProps {
  readonly variant: Variant;
}

function PortalPdfDownloadButton({
  invoiceId,
  documentNumber,
  variant,
  label,
  ariaLabel,
  className,
  'data-testid': testId,
}: PortalPdfDownloadButtonProps) {
  const t = useTranslations('portal.invoices.toast');
  const [loading, setLoading] = useState(false);

  const url =
    variant === 'receipt'
      ? `/api/portal/invoices/${invoiceId}/receipt/pdf`
      : `/api/portal/invoices/${invoiceId}/pdf`;

  const fallbackFilename =
    variant === 'receipt'
      ? `${documentNumber}-receipt.pdf`
      : `${documentNumber}.pdf`;

  const toasts: PdfDownloadToasts =
    variant === 'receipt'
      ? {
          pending: t('receiptPending'),
          // R8-M-i18n-verify — the portal receipt-PDF route deliberately
          // strips `reason` from 502 responses (to avoid leaking
          // internal error reason to members). When the helper receives
          // an empty reason, the `{reason}` interpolation in
          // `receiptFailed` would render as awkward whitespace (e.g.
          // "Kvitto-PDF kunde inte genereras: . Kontakta…"). Fall back
          // to the generic `unavailable` toast in that case — member
          // gets a clean message, operator still sees the underlying
          // error in the server logs.
          failed: (reason: string) =>
            reason ? t('receiptFailed', { reason }) : t('receiptUnavailable'),
          forbidden: t('receiptForbidden'),
          unavailable: t('receiptUnavailable'),
          sessionExpired: t('receiptSessionExpired'),
          rateLimited: t('receiptRateLimited'),
        }
      : {
          forbidden: t('invoiceForbidden'),
          notFound: t('invoiceNotFound'),
          unavailable: t('invoiceUnavailable'),
          sessionExpired: t('invoiceSessionExpired'),
          rateLimited: t('invoiceRateLimited'),
        };

  const handleClick = async () => {
    setLoading(true);
    const loadingId = toast.loading(t('downloadInProgress'));
    try {
      await downloadPdf({
        url,
        fallbackFilename,
        toasts,
        toastWarning: (msg) => toast.warning(msg),
        toastError: (msg) => toast.error(msg),
      });
    } finally {
      toast.dismiss(loadingId);
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      aria-label={ariaLabel ?? label}
      className={cn('inline-flex items-center justify-center gap-1', className)}
      {...(testId !== undefined && { 'data-testid': testId })}
    >
      {/* Download affordance: a static download icon when idle, swapped for a
          spinner while the PDF is being fetched. Signals the action + balances
          the icon-only resend button in the same action row. */}
      {loading ? (
        <Loader2
          className="size-4 motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

export function PortalInvoiceDownloadButton(props: BaseProps) {
  return <PortalPdfDownloadButton {...props} variant="invoice" />;
}

export function PortalReceiptDownloadButton(props: BaseProps) {
  return <PortalPdfDownloadButton {...props} variant="receipt" />;
}
