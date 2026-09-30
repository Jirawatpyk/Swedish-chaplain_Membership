'use client';

/**
 * Spec 122 US4 (option C) — the "⋯" menu on a phone invoice card.
 *
 * The card shows ONE labelled download: the invoice while unpaid, the receipt
 * once paid. This menu holds the rest: the invoice download on a paid card
 * (FR-015: both documents stay downloadable) and "Email me a copy". Its items
 * run the same download and resend as the buttons (`usePortalPdfDownload`,
 * `useResendInvoice`): same URLs, same toasts, same 5-minute cooldown.
 *
 * The card renders the menu only when it has an item (a void invoice has
 * none). While a copy is being sent, and for the 5-minute cooldown after,
 * "Email me a copy" is disabled with a reason: since AURA 5.10 (handoff #73) a
 * disabled item stays in the arrow-key order and reads its reason as its
 * description, and a menu with nothing enabled still takes focus.
 */
import { DropdownMenu, type MenuItem } from '@jirawatpyk/aura-react';
import { buttonClass } from '@jirawatpyk/aura-react/server';
import { IconDownload, IconEllipsis, IconMail } from '@jirawatpyk/aura-react/icons';
import { useTranslations } from 'next-intl';

import { usePortalPdfDownload } from './portal-pdf-download-button';
import { useResendInvoice } from './resend-invoice-button';

export interface PortalInvoiceCardMenuProps {
  readonly invoiceId: string;
  /** "More actions for {number}": the trigger's name and the menu's. */
  readonly label: string;
  /** The invoice download, on a card whose button is the receipt. */
  readonly invoiceDownload?:
    | {
        /** The document's own number, for the fallback filename. */
        readonly documentNumber: string;
        /** What the item does, e.g. "Download invoice (PDF)". */
        readonly label: string;
      }
    | undefined;
  readonly resendable: boolean;
}

export function PortalInvoiceCardMenu({
  invoiceId,
  label,
  invoiceDownload,
  resendable,
}: PortalInvoiceCardMenuProps): React.ReactElement {
  const t = useTranslations('portal.invoices');
  const { download } = usePortalPdfDownload({
    invoiceId,
    documentNumber: invoiceDownload?.documentNumber ?? invoiceId,
    variant: 'invoice',
  });
  const { isPending, recentlySent, resend } = useResendInvoice(invoiceId);

  const items: MenuItem[] = [];
  if (invoiceDownload) {
    items.push({
      label: invoiceDownload.label,
      icon: <IconDownload />,
      onSelect: () => void download(),
    });
  }
  if (resendable) {
    items.push({
      label: t('actions.emailCopy'),
      icon: <IconMail />,
      disabled: isPending || recentlySent,
      ...(recentlySent ? { disabledReason: t('actions.emailCopySent') } : {}),
      onSelect: resend,
    });
  }

  return (
    <DropdownMenu
      label={label}
      items={items}
      trigger={
        // The same secondary button as the download beside it, square: 32px,
        // 44px on phones (AURA `touchHeight`, #100); the label is its name
        // and its tooltip.
        <button
          type="button"
          aria-label={label}
          title={label}
          className={buttonClass({
            variant: 'secondary',
            size: 'sm',
            touchHeight: true,
            className: 'aspect-square px-0',
          })}
        >
          <IconEllipsis />
        </button>
      }
    />
  );
}
