/**
 * WP5 — the renewal price panel.
 *
 * Rendered ALWAYS (outside `hasAlternatives`, C-6) so the member's current
 * locked-in price never vanishes for a single-plan tenant or when `listPlans`
 * fails. Shows current price, the newly-selected plan's price, and the
 * signed difference; the "new" + "difference" rows update live as the member
 * picks a different plan.
 */
'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { formatThbMinorUnits } from '../_lib/format-thb';

export function PriceDiffPanel({
  currentPriceMinorUnits,
  newPriceMinorUnits,
}: {
  readonly currentPriceMinorUnits: number;
  readonly newPriceMinorUnits: number;
}) {
  const t = useTranslations('portal.renewal.planChange');
  const format = useFormatter();
  const delta = newPriceMinorUnits - currentPriceMinorUnits;

  return (
    <div
      data-testid="price-diff-panel"
      className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <p className="font-medium">{t('priceHeading')}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('priceCurrent')}</dt>
        <dd className="text-right tabular-nums" data-testid="price-current">
          {formatThbMinorUnits(format, currentPriceMinorUnits)}
        </dd>
        <dt className="text-muted-foreground">{t('priceNew')}</dt>
        <dd className="text-right tabular-nums" data-testid="price-new">
          {formatThbMinorUnits(format, newPriceMinorUnits)}
        </dd>
        <dt className="text-muted-foreground">{t('priceDelta')}</dt>
        <dd className="text-right font-medium tabular-nums" data-testid="price-delta">
          {formatThbMinorUnits(format, delta, { signDisplay: 'exceptZero' })}
        </dd>
      </dl>
    </div>
  );
}
