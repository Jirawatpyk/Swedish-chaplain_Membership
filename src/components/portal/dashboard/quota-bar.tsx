'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/**
 * QuotaBar — a labelled benefit-quota bar for the member dashboard.
 *
 * Unlike the generic `<ProgressBar>` (whose numeric readout is
 * `aria-hidden` and exposed only via `aria-valuetext`), QuotaBar
 * renders the `used/max` readout as **visible** text next to the
 * label — spec §5/§7 a11y-5 mandates a visible value, NOT colour or
 * bar-length alone. The underlying `<Progress>` still supplies the
 * canonical `role="progressbar"` + `aria-valuemin/max/now`.
 *
 * `aria-valuenow` is clamped to `[0, max]` so assistive tech never
 * announces an out-of-range value when a member is over quota; the
 * visible readout deliberately keeps the raw counts (e.g. "9 of 5")
 * so the over-use is surfaced to sighted users too.
 */
export interface QuotaBarProps {
  /** Already-localised benefit label, e.g. "E-Blasts". */
  readonly label: string;
  readonly used: number;
  readonly max: number;
  readonly className?: string;
  /** Bar tone — defaults to primary; warning for under-/over-use callouts. */
  readonly tone?: 'primary' | 'warning' | 'success';
}

export function QuotaBar({
  label,
  used,
  max,
  className,
  tone = 'primary',
}: QuotaBarProps) {
  const t = useTranslations('portal.dashboard.quotaBar');
  const labelId = useId();

  const safeMax = max > 0 ? max : 0;
  const clampedNow = Math.min(Math.max(used, 0), safeMax);
  const readout = t('readout', { used, max: safeMax });
  const ariaLabel = t('ariaLabel', { label, used, max: safeMax });

  return (
    <div data-slot="quota-bar" className={cn('grid gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2 text-caption">
        <span id={labelId} className="font-medium">
          {label}
        </span>
        <span className="tabular-nums text-muted-foreground">{readout}</span>
      </div>
      <Progress
        value={clampedNow}
        max={safeMax}
        tone={tone}
        aria-label={ariaLabel}
      />
    </div>
  );
}
