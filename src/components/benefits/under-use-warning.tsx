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
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react';

export interface UnderUseWarningProps {
  /** Fraction of the membership year elapsed, 0–100. */
  readonly elapsedYearPct: number;
  /** Aggregate consumed %, 0–100. */
  readonly consumedPct: number;
  /** Optional deep link to act on the warning (e.g. compose an E-Blast). */
  readonly actionHref?: string;
  /**
   * Staff variant: the member company the figures belong to. When set, the
   * copy names the company in the third person instead of addressing the
   * viewer as "you" (the member portal omits it).
   */
  readonly subjectName?: string;
}

export function UnderUseWarning({
  elapsedYearPct,
  consumedPct,
  actionHref,
  subjectName,
}: UnderUseWarningProps): React.ReactElement {
  const t = useTranslations('benefits.warning');
  // Round elapsed up + consumed down so the DISPLAYED gap is never smaller
  // than the real ≥25-pt gap that fired this banner — avoids showing e.g.
  // "62% / 38%" (24) under a warning (R#8).
  const elapsed = Math.ceil(elapsedYearPct);
  const consumed = Math.floor(consumedPct);
  // AURA warning Alert (spec 122 US3): icon + title carry the meaning, and it
  // keeps role="alert" as the legacy inline alert had.
  return (
    <Alert tone="warning" title={subjectName === undefined ? t('title') : t('staffTitle')}>
      <p>
        {subjectName === undefined
          ? t('body', { elapsed, consumed })
          : t('staffBody', { elapsed, consumed, company: subjectName })}
      </p>
      {actionHref !== undefined && (
        <Link
          href={actionHref}
          className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
        >
          {t('action')}
          <ArrowRight aria-hidden="true" size={14} className="aura-icon" />
        </Link>
      )}
    </Alert>
  );
}
