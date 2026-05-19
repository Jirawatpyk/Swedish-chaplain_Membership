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
}

export function OrderSummary({
  invoiceNumber,
  amountDue,
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
      className="rounded-lg border border-border bg-muted/40 p-4"
    >
      <h3
        id="pay-sheet-summary-heading"
        className="text-caption font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t('heading')}
      </h3>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <FileTextIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0">
            <p className="text-caption text-muted-foreground">
              {t('invoiceLabel')}
            </p>
            <p className="text-body font-medium text-foreground truncate">
              {invoiceNumber}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-caption text-muted-foreground">
            {t('amountLabel')}
          </p>
          <p
            className="text-h3 font-semibold text-foreground tabular-nums"
            data-testid="pay-sheet-summary-amount"
          >
            {formattedAmount}
          </p>
        </div>
      </div>
    </section>
  );
}

export default OrderSummary;
