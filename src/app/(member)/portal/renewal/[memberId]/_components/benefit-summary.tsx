/**
 * F8 Phase 5 Wave C · T127 — benefit-summary panel.
 *
 * Renders the cycle's benefit-consumption summary on the renewal
 * portal page (T125). Data is resolved upstream by `loadRenewalSummary`
 * via the F9 insights `computeBenefitUsage` reader (E-Blasts / cultural
 * tickets). `benefitsAvailable=false` (reader unavailable: member-not-found
 * / compute error / read threw) OR an empty `benefits` list triggers the
 * neutral fallback copy.
 *
 * Called from T125 page; pure presentation (no fetching here — the
 * page passes the resolved `summary.benefits` list).
 *
 * Spec 122 US7c (board `Portal-renewal`): an AURA card. A metered benefit
 * (`quota !== null`) is an AURA progress bar named for the benefit and
 * reading "{used} of {quota}" (shown and read out), so the signal is in
 * text and shape, not colour alone (WCAG 1.4.1). An unmetered benefit
 * (`quota === null`) is a plain row — there is no progress against an
 * unlimited cap. AURA's Progress is a client component, so this file is too
 * (the page's confirm flow already ships the AURA client barrel).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, Progress } from '@jirawatpyk/aura-react';
import type { BenefitConsumptionEntry } from '@/modules/renewals';

export interface BenefitSummaryProps {
  readonly benefits: ReadonlyArray<BenefitConsumptionEntry>;
  readonly benefitsAvailable: boolean;
}

export function BenefitSummary({ benefits, benefitsAvailable }: BenefitSummaryProps) {
  const t = useTranslations('portal.renewal.benefits');
  const hasContent = benefitsAvailable && benefits.length > 0;
  return (
    <Card as="section" title={t('heading')} titleId="benefits-heading" headingLevel={2}>
      {hasContent ? (
        // R2-S7: the list carries its own name (`aria-label`) rather than
        // re-pointing at the card's heading, which the region already uses.
        <ul aria-label={t('heading')} className="flex flex-col gap-[var(--aura-space-4)] text-sm">
          {benefits.map((b) => (
            <BenefitRow key={b.key} benefit={b} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('unavailable')}</p>
      )}
    </Card>
  );
}

function BenefitRow({ benefit }: { benefit: BenefitConsumptionEntry }) {
  const t = useTranslations('portal.renewal.benefits');
  const { key, used, quota } = benefit;
  // Resolve the human-readable benefit name from its stable key via i18n
  // (keys: eblast | cultural_ticket | event_attendance under
  // `portal.renewal.benefits.name.*`).
  const label = t(`name.${key}`);
  if (quota === null) {
    return (
      <li className="flex items-baseline justify-between gap-[var(--aura-space-2)]">
        <span className="font-medium">{label}</span>
        {/* Board: "3 · Unlimited". */}
        <span className="text-[var(--aura-fg-secondary)]">
          {used} · {t('unmeteredQuota')}
        </span>
      </li>
    );
  }
  return (
    <li>
      <Progress
        label={label}
        value={used}
        max={Math.max(quota, 1)}
        showValue
        valueLabel={t('usageRatio', { used, quota })}
      />
    </li>
  );
}
