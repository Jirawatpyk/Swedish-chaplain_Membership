'use client';

/**
 * COMP-1 US3-A — ErasedBanner.
 *
 * Shown on the member detail page when `erased_at IS NOT NULL`. Mirrors
 * ArchivedBanner's destructive Card treatment but has NO undelete affordance —
 * GDPR Art.17 / PDPA §33 erasure is permanent. When the post-commit cascades
 * have not yet completed (`completed=false`, i.e. no `member_erased` proof),
 * appends a "completion pending" line (the US2d reconciler finishes the rest).
 *
 * Presentational only — receives the ISO date + completed flag as props; BE
 * display for th-TH via the shared locale-aware formatter (storage stays
 * Gregorian ISO).
 */
import { useLocale, useTranslations } from 'next-intl';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { Alert } from '@jirawatpyk/aura-react';

type Props = {
  readonly erasedAtIso: string;
  readonly completed: boolean;
};

export function ErasedBanner({ erasedAtIso, completed }: Props) {
  const t = useTranslations('admin.members.erase');
  const locale = useLocale();

  // BE display for th-TH per CLAUDE.md (display-only); storage stays Gregorian.
  const erasedDate = new Date(erasedAtIso);
  let formattedDate: string;
  try {
    formattedDate = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      // Hydration safety (2026-07-31 #418 incident class): pin Bangkok so
      // SSR (UTC server) and hydration (browser) agree on the calendar
      // day — see format-date-localised.ts's timezone-default doc.
      timeZone: 'Asia/Bangkok',
    }).format(erasedDate);
  } catch {
    formattedDate = erasedDate.toISOString().slice(0, 10);
  }

  // Spec 122 US5b-1 — an AURA danger Alert. A note, not a live region: it is
  // part of the page's first render, not a change to announce.
  return (
    <Alert tone="danger" role="note" title={t('bannerTitle', { date: formattedDate })}>
      <p>{t('bannerBody')}</p>
      {!completed && <p className="mt-1">{t('bannerPending')}</p>}
    </Alert>
  );
}
