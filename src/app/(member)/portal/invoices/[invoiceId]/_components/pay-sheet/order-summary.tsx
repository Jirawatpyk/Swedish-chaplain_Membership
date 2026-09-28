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

  // Spec 122 US4 (`Pay-*` boards): a quiet band listing the invoice and the
  // amount due; on phones (`Pay-card-mobile`) only the amount due, since the
  // drawer header already carries the number. The bill note sits under the
  // band.
  return (
    <>
      <section
        aria-labelledby="pay-sheet-summary-heading"
        data-testid="pay-sheet-summary"
        className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-3.5 py-3"
      >
        <h3
          id="pay-sheet-summary-heading"
          className="m-0 mb-2 text-caption font-semibold text-[var(--aura-fg-primary)] max-sm:sr-only"
        >
          {t('heading')}
        </h3>
        <dl className="m-0 grid grid-cols-[1fr_auto] items-baseline gap-x-4">
          <dt className="py-1.5 text-sm text-[var(--aura-fg-secondary)] max-sm:hidden">{t('invoiceLabel')}</dt>
          <dd className="m-0 truncate py-1.5 text-right font-mono text-sm text-[var(--aura-fg-primary)] max-sm:hidden">
            {invoiceNumber}
          </dd>
          <dt className="border-t border-[var(--aura-border-default)] pt-2 text-sm font-semibold text-[var(--aura-fg-primary)] max-sm:border-t-0 max-sm:pt-0 max-sm:font-normal max-sm:text-[var(--aura-fg-secondary)]">
            {t('amountLabel')}
          </dt>
          <dd
            className="m-0 border-t border-[var(--aura-border-default)] pt-2 text-right text-lg font-semibold tabular-nums text-[var(--aura-fg-primary)] max-sm:border-t-0 max-sm:pt-0"
            data-testid="pay-sheet-summary-amount"
          >
            {formattedAmount}
          </dd>
        </dl>
      </section>
      {isBill ? (
        <p
          className="m-0 text-caption text-[var(--aura-fg-secondary)]"
          data-testid="pay-sheet-summary-bill-note"
        >
          {t('billNote')}
        </p>
      ) : null}
    </>
  );
}

export default OrderSummary;
