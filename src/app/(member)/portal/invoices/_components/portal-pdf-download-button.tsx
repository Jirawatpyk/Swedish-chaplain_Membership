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
 *   - AURA's Button / IconButton draw it (spec 122): the Button's
 *     `loading` spinner, slowed by AURA under reduced motion.
 *   - Optional `toastSuccess` fires on fast-cache hits where the
 *     loading toast dismisses before the user sees it (R5-UX-M1).
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { IconLoaderCircle } from '@jirawatpyk/aura-react/icons';
import { Button, IconButton, type ButtonSize, type ButtonVariant } from '@jirawatpyk/aura-react';
import { downloadPdf, type PdfDownloadToasts } from '@/lib/download-pdf-client';

export type Variant = 'invoice' | 'receipt';

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
  /**
   * The labelled form's AURA Button look. Defaults to a small secondary
   * button, 44px on touch. Ignored by the icon-only form (an AURA IconButton).
   */
  readonly appearance?: PortalPdfButtonAppearance;
  /** Extra layout classes (width, flex) on top of AURA's own. */
  readonly className?: string;
  /**
   * Spec 122 US3 — the dashboard's recent-invoices rows draw the download as
   * an icon button (the `Main` board): the label leaves the view and the
   * accessible name (`ariaLabel`) stays; the label becomes the tooltip.
   */
  readonly iconOnly?: boolean;
  readonly 'data-testid'?: string;
}

export interface PortalPdfButtonAppearance {
  readonly variant: Extract<ButtonVariant, 'primary' | 'secondary' | 'ghost'>;
  readonly size?: ButtonSize;
  readonly touchHeight?: boolean;
}

const DEFAULT_APPEARANCE: PortalPdfButtonAppearance = {
  variant: 'secondary',
  size: 'sm',
  touchHeight: true,
};

interface PortalPdfDownloadButtonProps extends BaseProps {
  readonly variant: Variant;
}

/**
 * The fetch + blob download with its toasts, shared by the button below and
 * the phone card's "⋯" menu (spec 122 US4), so both run the same request with
 * the same feedback.
 */
export function usePortalPdfDownload({
  invoiceId,
  documentNumber,
  variant,
}: {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly variant: Variant;
}): { readonly loading: boolean; readonly download: () => Promise<void> } {
  const t = useTranslations('portal.invoices.toast');
  const [loading, setLoading] = useState(false);
  // PR P review M2 — the buttons stay focusable while loading (no `disabled`),
  // so this ref, not the DOM, is what refuses a second download in flight.
  const inFlight = useRef(false);

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

  const download = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setLoading(false);
    }
  };

  return { loading, download };
}

function PortalPdfDownloadButton({
  invoiceId,
  documentNumber,
  variant,
  label,
  ariaLabel,
  appearance = DEFAULT_APPEARANCE,
  className,
  iconOnly = false,
  'data-testid': testId,
}: PortalPdfDownloadButtonProps) {
  const { loading, download } = usePortalPdfDownload({ invoiceId, documentNumber, variant });
  const name = ariaLabel ?? label;
  const shared = {
    onClick: download,
    ...(className !== undefined && { className }),
    ...(testId !== undefined && { 'data-testid': testId }),
  };

  // Spec 122 US3 — the icon-only form (dashboard rows) is an AURA IconButton:
  // the name is the full "Download … for {number}", which AURA's own tooltip
  // shows on hover, focus and touch (no native `title`, PR P review L10). The
  // spinner replaces the download icon while fetching, balancing the icon-only
  // resend button in the same action row. PR P review M2 — while loading both
  // forms are aria-disabled, never `disabled`, so focus is not dropped to
  // <body> (WCAG 2.4.3); AURA swallows the click and the hook refuses too.
  if (iconOnly) {
    return (
      <IconButton
        {...shared}
        icon={loading ? <IconLoaderCircle className="aura-spin" /> : 'download'}
        label={name}
        // 44px on a phone or a coarse pointer, like every tapped IconButton.
        touchHeight
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
      />
    );
  }
  return (
    <Button
      {...shared}
      variant={appearance.variant}
      {...(appearance.size !== undefined && { size: appearance.size })}
      {...(appearance.touchHeight !== undefined && { touchHeight: appearance.touchHeight })}
      icon="download"
      loading={loading}
      aria-label={name}
    >
      {label}
    </Button>
  );
}

export function PortalInvoiceDownloadButton(props: BaseProps) {
  return <PortalPdfDownloadButton {...props} variant="invoice" />;
}

export function PortalReceiptDownloadButton(props: BaseProps) {
  return <PortalPdfDownloadButton {...props} variant="receipt" />;
}
