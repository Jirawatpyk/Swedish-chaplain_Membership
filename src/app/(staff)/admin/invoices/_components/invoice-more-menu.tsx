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
  /**
   * When true (paid + combined-mode), the Download Receipt item's
   * label changes from "Download Receipt" to "Download Tax Invoice /
   * Receipt" so the admin sees the dual-role wording. The pre-payment
   * invoice PDF (`showDownload`) is expected to be FALSE in this state
   * — see comment block at the top of this file.
   */
  readonly combinedModeReceipt?: boolean;
}

export function InvoiceMoreMenu({
  invoiceId,
  documentNumber,
  showDownload,
  showResendInvoice,
  showResendReceipt,
  showDownloadReceipt = false,
  combinedModeReceipt = false,
}: InvoiceMoreMenuProps) {
  const t = useTranslations('admin.invoices.detail');

  const visibleCount =
    (showDownload ? 1 : 0) +
    (showDownloadReceipt ? 1 : 0) +
    (showResendInvoice ? 1 : 0) +
    (showResendReceipt ? 1 : 0);

  const [pendingVariant, setPendingVariant] = useState<
    'invoice' | 'receipt' | null
  >(null);
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
      } catch {
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
            render={(props) => (
              <a
                {...props}
                href={`/api/invoices/${invoiceId}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                download
              >
                <Download aria-hidden="true" />
                {t('actions.download')}
              </a>
            )}
          />
        )}
        {showDownloadReceipt && (
          <DropdownMenuItem
            render={(props) => (
              <a
                {...props}
                href={`/api/invoices/${invoiceId}/receipt/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                download
                data-testid="download-receipt-trigger"
                aria-label={t('actions.downloadReceiptAria', { number: documentNumber })}
              >
                <Download aria-hidden="true" />
                {/* Combined mode → label highlights the dual role of
                    the single legal document (Thai RD §86/4 + §105ทวิ).
                    Separate mode keeps the plain "Download Receipt"
                    label. */}
                {combinedModeReceipt
                  ? t('actions.downloadCombined')
                  : t('actions.downloadReceipt')}
              </a>
            )}
          />
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
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
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
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
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
