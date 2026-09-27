'use client';

/**
 * <OrderSummary> — prominent amount + invoice number block shown at the
 * top of the PaySheet drawer. Addresses the critical payment UX gap
 * where the member could not see the amount they were about to pay
 * (discovered during T082 empirical walk-through 2026-04-24).
 *
 * Pattern follows Stripe Checkout / PayPal / Apple Pay sheets — the
 * amount is the dominant visual element before any form field.
 */

import { useLocale, useTranslations } from 'next-intl';
import { FileTextIcon } from 'lucide-react';

import { formatSatangThb } from '@/lib/format-thb';

export interface OrderSummaryProps {
  readonly invoiceNumber: string;
  /** Amount due in satang (1 THB = 100 satang). */
  readonly amountDue: number;
  /**
   * Reserved for future multi-currency tenants. The component currently
   * formats as THB only via `formatSatangThb` — when non-THB support
   * lands, branch on this value to select the appropriate formatter
   *.
   */
  readonly currency?: string;
  /**
   * 088 — the invoice is an SC- bill (ใบแจ้งหนี้). Paying it issues the
   * §86/4 tax invoice/receipt, so the summary says so plainly — the member
   * must not mistake the bill for their tax document.
   */
  readonly isBill?: boolean;
}

export function OrderSummary({
  invoiceNumber,
  amountDue,
  isBill = false,
}: OrderSummaryProps) {
  const t = useTranslations('portal.payment.summary');
  const locale = useLocale();
  // `amountDue` is carried as number-of-satang from the invoice page
  // (`total` is a bigint in `invoices` table; the page coerces to number
  // for serialization). `formatSatangThb` divides by 100 + formats with
  // 2-decimal precision (e.g. 353000 satang → "3,530.00 THB") matching
  // the F4 canonical formatter used across the invoice surfaces.
  const formattedAmount = formatSatangThb(BigInt(Math.round(amountDue)), locale);

  return (
    <section
      aria-labelledby="pay-sheet-summary-heading"
      data-testid="pay-sheet-summary"
      // Spec 122 US4 (`Pay-*` boards): a quiet band on the drawer surface.
      className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-3.5 py-3"
    >
      <h3
        id="pay-sheet-summary-heading"
        className="m-0 text-caption font-medium text-[var(--aura-fg-secondary)]"
      >
        {t('heading')}
      </h3>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <FileTextIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-[var(--aura-fg-secondary)]"
          />
          <div className="min-w-0">
            <p className="m-0 text-caption text-[var(--aura-fg-secondary)]">
              {t('invoiceLabel')}
            </p>
            <p className="m-0 truncate font-mono text-body font-medium text-[var(--aura-fg-primary)]">
              {invoiceNumber}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="m-0 text-caption text-[var(--aura-fg-secondary)]">
            {t('amountLabel')}
          </p>
          <p
            className="m-0 text-lg font-semibold text-[var(--aura-fg-primary)] tabular-nums"
            data-testid="pay-sheet-summary-amount"
          >
            {formattedAmount}
          </p>
        </div>
      </div>
      {isBill ? (
        <p
          className="mt-3 mb-0 text-caption text-[var(--aura-fg-secondary)]"
          data-testid="pay-sheet-summary-bill-note"
        >
          {t('billNote')}
        </p>
      ) : null}
    </section>
  );
}

export default OrderSummary;
