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
 * The card renders the menu only when it has an item, so there is never an
 * empty or one-button-in-disguise menu (a void invoice has none).
 */
import { DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
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
        /** The same short label the button would carry ("Invoice"). */
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
      // Sending, or sent within the cooldown: shown but not selectable.
      disabled: isPending || recentlySent,
      onSelect: resend,
    });
  }

  return (
    <DropdownMenu
      label={label}
      items={items}
      trigger={
        <IconButton
          type="button"
          icon={<IconEllipsis />}
          label={label}
          className="min-h-11 min-w-11 border border-[var(--aura-border-default)]"
        />
      }
    />
  );
}
