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
import { AlertTriangleIcon } from 'lucide-react';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { Card } from '@/components/ui/card';

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
    }).format(erasedDate);
  } catch {
    formattedDate = erasedDate.toISOString().slice(0, 10);
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5 p-4">
      <div className="flex gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">{t('bannerTitle', { date: formattedDate })}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('bannerBody')}</p>
          {!completed && (
            <p className="mt-1 text-sm text-muted-foreground">{t('bannerPending')}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
