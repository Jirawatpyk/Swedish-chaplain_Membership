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
 * F4 receipt-surface — `showDownloadReceipt`: paid + receiptPdf rendered.
 * It sits alongside `showDownload` (the main PDF — the SC bill on an 088
 * bill, which stays downloadable after payment, FR-015).
 *
 * Spec 122 US8b (T824) — AURA's `DropdownMenu`. An AURA menu item carries no
 * aria-label of its own, so each item names its document with the number as
 * its hint, which is part of its name: the SC on the bill actions, the RC on
 * the receipt actions (FR-015, 088 T065). Below 640px the page's actions move
 * to a bar at the bottom of the screen and Void… joins this menu
 * (`showVoid`), last, after a separator.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { useBelowSm } from '@/hooks/use-below-sm';
import { downloadInvoice, downloadReceipt } from '../_lib/download-receipt-client';

export interface InvoiceMoreMenuProps {
  readonly invoiceId: string;
  readonly documentNumber: string;
  /**
   * 088 (T065 review fix) — the number that names the MAIN (`showDownload`)
   * invoice/bill download when it differs from `documentNumber`. On a paid
   * 088 bill `documentNumber` resolves to the RC §86/4 tax-receipt number
   * (via `displayDocumentNumber`), but the main PDF served by `showDownload`
   * is the non-tax SC bill — so its filename + aria must carry the SC bill
   * number, not the RC. The same number names the ⋯ trigger and "Resend
   * invoice email" (which resends that bill); the receipt arm keeps
   * `documentNumber` (the RC). Defaults to `documentNumber` (byte-identical to
   * the pre-088 behaviour).
   */
  readonly invoiceDownloadNumber?: string;
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
   * 064 — what the MAIN pdf (served by `showDownload`) actually is when it
   * is not a plain §86/4 invoice (064-remediation A4 generalised the former
   * `mainDownloadIsCombined` boolean):
   *
   *   - `'combined'` — `pdfDocKind === 'receipt_combined'` (as-paid TIN
   *     event invoice issued straight to paid; receipt_* blob columns stay
   *     NULL). Download item reuses the combined dual-role label
   *     (`actions.downloadCombined`) — the file the admin grabs is the one
   *     legal Tax Invoice / Receipt, not a pre-payment invoice.
   *   - `'receipt'` — `pdfDocKind === 'receipt_separate'` (β as-paid no-TIN
   *     event row / legacy issued no-TIN row whose main pdf IS the §105
   *     receipt). Download item flips to `actions.downloadReceipt` + the
   *     receipt aria so the admin never sees a "tax invoice" label on a
   *     document that is legally a receipt.
   *   - `'bill'` — `pdfDocKind === 'invoice'` with a bill number (088 SC-…):
   *     the main pdf is a ใบแจ้งหนี้, not a tax invoice (the §86/4 tax
   *     invoice/receipt is the RC issued at payment). Download item uses
   *     `actions.downloadBill[Aria]`.
   *   - omitted — plain invoice label (legacy INV- tax invoice rows,
   *     byte-identical to the pre-064 behaviour).
   */
  readonly mainDownloadKind?: 'combined' | 'receipt' | 'bill' | undefined;
  /**
   * The admin may void this issued invoice: below 640px the menu holds Void…
   * (the header's own Void button is hidden there, spec Session 2026-10-02 US8b).
   */
  readonly showVoid?: boolean;
}

export function InvoiceMoreMenu({
  invoiceId,
  documentNumber,
  invoiceDownloadNumber,
  showDownload,
  showResendInvoice,
  showResendReceipt,
  showDownloadReceipt = false,
  mainDownloadKind,
  showVoid = false,
}: InvoiceMoreMenuProps) {
  // 088 (T065 review fix) — name the MAIN (SC-bill) download by its own
  // number, falling back to `documentNumber` when no distinct bill number is
  // threaded (all pre-088 rows). The receipt arm always uses `documentNumber`.
  const mainDownloadNumber = invoiceDownloadNumber ?? documentNumber;
  const t = useTranslations('admin.invoices.detail');

  const isPhone = useBelowSm();
  const voidHere = showVoid && isPhone;
  const visibleCount =
    (showDownload ? 1 : 0) +
    (showDownloadReceipt ? 1 : 0) +
    (showResendInvoice ? 1 : 0) +
    (showResendReceipt ? 1 : 0) +
    (voidHere ? 1 : 0);

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
  // Round-4 fixes C-2 + UX-H2 + B-1 — a menu item closes the menu
  // synchronously on click, so an inline spinner would be invisible
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
        fallbackFilename: `${mainDownloadNumber}.pdf`,
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
      } else if (code === 'no_recipient') {
        // 108 FR-003 — the only resend failure staff can fix themselves, and
        // the generic 'please try again' would send them to retry a data
        // problem forever. The banner on this page says the same thing.
        toast.error(t('toast.resendNoRecipient'));
      } else if (code === 'no_buyer_email') {
        // Round-4 finding #6 — a NON-MEMBER event invoice. `resendNoRecipient`
        // reads "add or promote a contact on the member page", and this row has
        // no member and no member page. The fix is to reissue with an address.
        toast.error(t('toast.resendNoBuyerEmail'));
      } else {
        toast.error(t('toast.resendFailed'));
      }
      setPendingVariant(null);
    });
  };

  if (visibleCount === 0) return null;

  const items: MenuItem[] = [];
  if (showDownload) {
    items.push({
      // 064 — as-paid rows: the main pdf IS the final legal document.
      // 'combined' (TIN) reuses the dual-role label; 'receipt' (β no-TIN /
      // legacy §105 rows) flips to the receipt label so the admin never
      // grabs a receipt under an invoice label; 'bill' (088 SC-) is a
      // ใบแจ้งหนี้, not a tax invoice.
      label:
        mainDownloadKind === 'combined'
          ? t('actions.downloadCombined')
          : mainDownloadKind === 'receipt'
            ? t('actions.downloadReceipt')
            : mainDownloadKind === 'bill'
              ? t('actions.downloadBill')
              : t('actions.download'),
      hint: mainDownloadNumber,
      icon: 'download',
      disabled: downloadingInvoice,
      onSelect: () => void handleDownloadInvoice(),
    });
  }
  if (showDownloadReceipt) {
    items.push({
      label: t('actions.downloadReceipt'),
      hint: documentNumber,
      icon: 'download',
      disabled: downloadingReceipt,
      onSelect: () => void handleDownloadReceipt(),
    });
  }
  if (showResendInvoice) {
    items.push({
      label: t('actions.resendInvoice'),
      // Resends the main (bill / invoice) PDF, so it names that number — the
      // SC on a paid 088 bill, not the RC.
      hint: mainDownloadNumber,
      icon: 'mail',
      disabled: pendingVariant !== null || recentlySent.invoice,
      onSelect: () => handleResend('invoice'),
    });
  }
  if (showResendReceipt) {
    items.push({
      label: t('actions.resendReceipt'),
      hint: documentNumber,
      icon: 'mail',
      disabled: pendingVariant !== null || recentlySent.receipt,
      onSelect: () => handleResend('receipt'),
    });
  }
  if (voidHere) {
    if (items.length > 0) items.push({ separator: true });
    items.push({ label: t('actions.void'), href: `/admin/invoices/${invoiceId}/void`, tone: 'danger', icon: 'ban' });
  }

  // The trigger names the page's own document — the SC bill on an 088
  // invoice (the RC names only the receipt actions).
  const menuName = t('actions.moreAria', { number: mainDownloadNumber });
  return (
    // Our own slot, so the phone action bar can keep the menu at its own
    // width while the actions fill the row.
    <span data-slot="invoice-more-menu" className="inline-flex">
      <DropdownMenu
        label={menuName}
        trigger={<IconButton icon="ellipsis" label={menuName} touchHeight className="flex-none!" />}
        items={items}
      />
    </span>
  );
}
