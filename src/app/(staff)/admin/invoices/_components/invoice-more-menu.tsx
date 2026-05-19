'use client';

/**
 * Invoice detail "⋯" menu — consolidates secondary actions (Download
 * PDF, Resend invoice, Resend receipt) into one icon-only dropdown so
 * the action row exposes only primary/destructive CTAs as standalone
 * buttons (Pay, Void, Issue credit note).
 *
 * Returns null when no items would render (e.g. void state with no
 * receipt PDF) so the trigger doesn't appear as a dead button.
 *
 * Resend logic is inlined here (copy of the former resend-admin-button
 * handler) so T107's 5-minute client-side re-enable + keyed error
 * toasts behave 1:1 with the previous standalone buttons.
 *
 * F4 receipt-surface — additions for the new receipt-PDF download path
 * (best-practice rule: combined mode = 1 download, separate mode = 2):
 *   - `showDownloadReceipt` — paid + receiptPdf rendered. In combined
 *     mode this is THE only download (one legal doc per Thai RD §86/4
 *     + §105ทวิ). In separate mode it sits alongside `showDownload`.
 *   - `combinedModeReceipt` — paid + combined-mode. Flips the label of
 *     the Download Receipt item from "Download Receipt" → "Download
 *     Tax Invoice / Receipt" so the admin sees the dual-role wording.
 *     The pre-payment invoice PDF (`showDownload`) is hidden in this
 *     state because it's a stale draft (header "ใบกำกับภาษี" only); the
 *     final combined PDF is what the customer + auditor should see.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, Loader2, Mail, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadInvoice, downloadReceipt } from '../_lib/download-receipt-client';

export interface InvoiceMoreMenuProps {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly showDownload: boolean;
  readonly showResendInvoice: boolean;
  readonly showResendReceipt: boolean;
  /**
   * Receipt-PDF download visibility. Separate-mode + paid +
   * `receiptPdfStatus === 'rendered'`. Combined-mode keeps this false
   * because the existing "Download Invoice" file already serves both
   * roles (Thai RD §86/4 allows one combined document).
   */
  readonly showDownloadReceipt?: boolean;
}

export function InvoiceMoreMenu({
  invoiceId,
  documentNumber,
  showDownload,
  showResendInvoice,
  showResendReceipt,
  showDownloadReceipt = false,
}: InvoiceMoreMenuProps) {
  // Derive combined-mode receipt label state from the existing prop
  // matrix instead of exposing a separate `combinedModeReceipt` prop —
  // they were perfectly correlated (combined-mode hides the pre-payment
  // invoice PDF, so `showDownload === false && showDownloadReceipt`
  // uniquely identifies the combined-paid state).
  const combinedModeReceipt = showDownloadReceipt && !showDownload;
  const t = useTranslations('admin.invoices.detail');

  const visibleCount =
    (showDownload ? 1 : 0) +
    (showDownloadReceipt ? 1 : 0) +
    (showResendInvoice ? 1 : 0) +
    (showResendReceipt ? 1 : 0);

  const [pendingVariant, setPendingVariant] = useState<
    'invoice' | 'receipt' | null
  >(null);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [recentlySent, setRecentlySent] = useState<{
    invoice: boolean;
    receipt: boolean;
  }>({ invoice: false, receipt: false });
  const unlockTimersRef = useRef<{
    invoice: ReturnType<typeof setTimeout> | null;
    receipt: ReturnType<typeof setTimeout> | null;
  }>({ invoice: null, receipt: null });
  const [, startTransition] = useTransition();

  useEffect(
    () => () => {
      if (unlockTimersRef.current.invoice)
        clearTimeout(unlockTimersRef.current.invoice);
      if (unlockTimersRef.current.receipt)
        clearTimeout(unlockTimersRef.current.receipt);
    },
    [],
  );

  /**
   * Download Receipt PDF — fetch + blob-URL programmatic download so
   * we can intercept 425 Too Early (async render in flight) and 502
   * receipt_pdf_failed (worker retry-budget exhausted) with structured
   * toasts instead of leaking a raw JSON error into a new tab.
   *
   * Why fetch instead of `<a download>`: a plain anchor opens the
   * server response directly in a new tab — on a non-200 response the
   * user sees `{"error":{...}}` text and has no path forward. The
   * fetch+blob pattern keeps the UI in control of the failure shape.
   */
  // Round-4 fixes C-2 + UX-H2 + B-1 — DropdownMenuItem closes
  // synchronously on click, so the inline Loader2 spinner is invisible
  // to the user for the entire fetch window. Fire `toast.loading` BEFORE
  // the await so the SR + visual feedback is continuous from click →
  // download. The loader toast is auto-dismissed in `finally` regardless
  // of throw vs return, and the helper's own toast (success/warning/
  // error) layers on top. try/finally also guarantees the boolean
  // spinner state never sticks if the fetch throws unexpectedly.
  const handleDownloadInvoice = async () => {
    setDownloadingInvoice(true);
    const loadingId = toast.loading(t('toast.downloadInProgress'));
    try {
      await downloadInvoice({
        invoiceId,
        fallbackFilename: `${documentNumber}.pdf`,
        toasts: {
          forbidden: t('toast.invoiceForbidden'),
          notFound: t('toast.invoiceNotFound'),
          unavailable: t('toast.invoiceUnavailable'),
          sessionExpired: t('toast.invoiceSessionExpired'),
          rateLimited: t('toast.invoiceRateLimited'),
        },
        toastWarning: (msg) => toast.warning(msg),
        toastError: (msg) => toast.error(msg),
      });
    } finally {
      toast.dismiss(loadingId);
      setDownloadingInvoice(false);
    }
  };

  const handleDownloadReceipt = async () => {
    setDownloadingReceipt(true);
    const loadingId = toast.loading(t('toast.downloadInProgress'));
    try {
      await downloadReceipt({
        invoiceId,
        fallbackFilename: `${documentNumber}-receipt.pdf`,
        toasts: {
          pending: t('toast.receiptPending'),
          failed: (reason) => t('toast.receiptFailed', { reason }),
          forbidden: t('toast.receiptForbidden'),
          unavailable: t('toast.receiptUnavailable'),
          sessionExpired: t('toast.receiptSessionExpired'),
          rateLimited: t('toast.receiptRateLimited'),
        },
        toastWarning: (msg) => toast.warning(msg),
        toastError: (msg) => toast.error(msg),
      });
    } finally {
      toast.dismiss(loadingId);
      setDownloadingReceipt(false);
    }
  };

  const handleResend = (variant: 'invoice' | 'receipt') => {
    setPendingVariant(variant);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/invoices/${invoiceId}/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant }),
        });
      } catch (err) {
        // R5-SF-L1 — log the network error before swallowing into a
        // user-friendly toast. Operators get DNS/CORS/offline/TLS
        // diagnostic; user still sees the generic "resendFailed" toast.
        console.error('[invoice-more-menu] resend network error', {
          variant,
          invoiceId,
          err,
        });
        toast.error(t('toast.resendFailed'));
        setPendingVariant(null);
        return;
      }

      if (res.status === 202) {
        const body = (await res.json().catch(() => ({}))) as {
          recipientEmail?: string;
        };
        setRecentlySent((s) => ({ ...s, [variant]: true }));
        const timer = unlockTimersRef.current[variant];
        if (timer) clearTimeout(timer);
        unlockTimersRef.current[variant] = setTimeout(
          () => setRecentlySent((s) => ({ ...s, [variant]: false })),
          5 * 60_000,
        );
        toast.success(
          t('toast.resendSuccess', { recipient: body.recipientEmail ?? '' }),
        );
        setPendingVariant(null);
        return;
      }
      if (res.status === 429) {
        toast.warning(t('toast.resendRateLimited'));
        setPendingVariant(null);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = body.error?.code;
      if (code === 'no_receipt_pdf') {
        toast.warning(t('toast.resendNoReceipt'));
      } else if (code === 'not_issued') {
        toast.warning(t('toast.resendNotIssued'));
      } else {
        toast.error(t('toast.resendFailed'));
      }
      setPendingVariant(null);
    });
  };

  if (visibleCount === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon-lg"
            // `flex-none!` (note the `!` important suffix) prevents
            // PageHeader's mobile `[&>*]:flex-1` rule from stretching
            // the overflow trigger. The parent selector carries higher
            // specificity (0,1,1) than a bare `.flex-none` class (0,1,0),
            // so `!` is required to force the compact 36×36 square
            // mandated by ux-standards.md § 19.
            className="flex-none!"
            aria-label={t('actions.moreAria', { number: documentNumber })}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
        {showDownload && (
          <DropdownMenuItem
            disabled={downloadingInvoice}
            onClick={handleDownloadInvoice}
            data-testid="download-invoice-trigger"
            aria-label={t('actions.downloadInvoiceAria', { number: documentNumber })}
          >
            {downloadingInvoice ? (
              <Loader2
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download aria-hidden="true" />
            )}
            {t('actions.download')}
          </DropdownMenuItem>
        )}
        {showDownloadReceipt && (
          <DropdownMenuItem
            disabled={downloadingReceipt}
            onClick={handleDownloadReceipt}
            data-testid="download-receipt-trigger"
            aria-label={t('actions.downloadReceiptAria', { number: documentNumber })}
          >
            {downloadingReceipt ? (
              <Loader2
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download aria-hidden="true" />
            )}
            {/* Combined mode → label highlights the dual role of the
                single legal document (Thai RD §86/4 + §105ทวิ).
                Separate mode keeps the plain "Download Receipt"
                label. */}
            {combinedModeReceipt
              ? t('actions.downloadCombined')
              : t('actions.downloadReceipt')}
          </DropdownMenuItem>
        )}
        {showResendInvoice && (
          <DropdownMenuItem
            disabled={pendingVariant !== null || recentlySent.invoice}
            onClick={() => handleResend('invoice')}
            aria-label={t('actions.resendInvoiceAria', {
              number: documentNumber,
            })}
          >
            {pendingVariant === 'invoice' ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Mail aria-hidden="true" />
            )}
            {t('actions.resendInvoice')}
          </DropdownMenuItem>
        )}
        {showResendReceipt && (
          <DropdownMenuItem
            disabled={pendingVariant !== null || recentlySent.receipt}
            onClick={() => handleResend('receipt')}
            data-testid="resend-receipt-trigger"
            aria-label={t('actions.resendReceiptAria', {
              number: documentNumber,
            })}
          >
            {pendingVariant === 'receipt' ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Mail aria-hidden="true" />
            )}
            {t('actions.resendReceipt')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
