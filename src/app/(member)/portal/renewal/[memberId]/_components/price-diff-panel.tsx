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

const ROW =
  'flex items-baseline justify-between gap-[var(--aura-space-4)] py-[var(--aura-space-2)] first:pt-0 last:pb-0';

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

  // Spec 122 US7c — the board's price band: the surface-hover ground, a rule
  // between the pairs, tabular figures and a bold Difference row (tokens only).
  return (
    <div
      data-testid="price-diff-panel"
      className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-[var(--aura-space-3)] text-sm"
    >
      <p className="text-xs font-semibold text-[var(--aura-fg-secondary)]">{t('priceHeading')}</p>
      <dl className="flex flex-col divide-y divide-[var(--aura-border-subtle)]">
        <div className={ROW}>
          <dt>{t('priceCurrent')}</dt>
          <dd className="text-end tabular-nums" data-testid="price-current">
            {formatThbMinorUnits(format, currentPriceMinorUnits)}
          </dd>
        </div>
        <div className={ROW}>
          <dt>{t('priceNew')}</dt>
          <dd className="text-end tabular-nums" data-testid="price-new">
            {formatThbMinorUnits(format, newPriceMinorUnits)}
          </dd>
        </div>
        <div className={ROW}>
          <dt className="font-semibold">{t('priceDelta')}</dt>
          <dd className="text-end font-semibold tabular-nums" data-testid="price-delta">
            {formatThbMinorUnits(format, delta, { signDisplay: 'exceptZero' })}
          </dd>
        </div>
      </dl>
    </div>
  );
}
