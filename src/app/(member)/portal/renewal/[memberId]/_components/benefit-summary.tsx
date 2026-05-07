/**
 * F8 Phase 5 Wave C · T127 — benefit-summary panel (server component).
 *
 * Renders the cycle's benefit-consumption summary on the renewal
 * portal page (T125). When the upstream readers (F6 events / F7 quota)
 * are not yet wired, `benefitsAvailable=false` triggers the neutral
 * fallback copy.
 *
 * Called from T125 page; pure presentation (no fetching here — the
 * page passes the resolved `summary.benefits` list).
 */
import { useTranslations } from 'next-intl';
import type { BenefitConsumptionEntry } from '@/modules/renewals';

export interface BenefitSummaryProps {
  readonly benefits: ReadonlyArray<BenefitConsumptionEntry>;
  readonly benefitsAvailable: boolean;
}

export function BenefitSummary({
  benefits,
  benefitsAvailable,
}: BenefitSummaryProps) {
  const t = useTranslations('portal.renewal.benefits');
  const hasContent = benefitsAvailable && benefits.length > 0;
  return (
    <section
      aria-labelledby="benefits-heading"
      className="rounded-lg border bg-card p-4"
    >
      <h2 id="benefits-heading" className="mb-3 text-lg font-medium">
        {t('heading')}
      </h2>
      {hasContent ? (
        <ul className="space-y-2 text-sm">
          {benefits.map((b) => (
            <li key={b.key}>
              {b.label}: {b.used}
              {b.quota === null ? '' : ` / ${b.quota}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      )}
    </section>
  );
}
