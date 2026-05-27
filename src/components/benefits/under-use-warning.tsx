'use client';

/**
 * F9 US4 (T067 / FR-021) — under-use warning banner.
 *
 * Shown when `elapsed-year % − aggregate consumed % ≥ 25` (the gap is computed
 * upstream in the domain VO; this component only renders). Non-colour-alone:
 * an icon + a text title carry the meaning, so the warning is conveyed without
 * relying on the amber tone (WCAG 1.4.1). Microcopy mirrors the spec example
 * ("At 62% of the year you've used 33% of your benefits").
 */
import Link from 'next/link';
import { TriangleAlert, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  InlineAlert,
  InlineAlertTitle,
  InlineAlertDescription,
} from '@/components/ui/inline-alert';

export interface UnderUseWarningProps {
  /** Fraction of the membership year elapsed, 0–100. */
  readonly elapsedYearPct: number;
  /** Aggregate consumed %, 0–100. */
  readonly consumedPct: number;
  /** Optional deep link to act on the warning (e.g. compose an E-Blast). */
  readonly actionHref?: string;
}

export function UnderUseWarning({
  elapsedYearPct,
  consumedPct,
  actionHref,
}: UnderUseWarningProps): React.ReactElement {
  const t = useTranslations('benefits.warning');
  return (
    <InlineAlert tone="warning">
      <TriangleAlert aria-hidden="true" />
      <InlineAlertTitle>{t('title')}</InlineAlertTitle>
      <InlineAlertDescription>
        <p>
          {t('body', {
            elapsed: Math.round(elapsedYearPct),
            consumed: Math.round(consumedPct),
          })}
        </p>
        {actionHref !== undefined && (
          <Link
            href={actionHref}
            className="inline-flex items-center gap-1 rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t('action')}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </InlineAlertDescription>
    </InlineAlert>
  );
}
