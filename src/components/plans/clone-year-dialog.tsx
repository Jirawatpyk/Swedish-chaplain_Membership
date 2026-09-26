/**
 * T107 — CloneYearDialog (US2).
 *
 * Confirmation dialog that surfaces before the bulk clone runs.
 * Follows UX standards § 4.1 — destructive-action-like confirmation
 * with an explicit verb ("Clone 2026 → 2027") and the row count.
 */
'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatCalendarYear } from '@/lib/format-date-localised';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface CloneYearDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceYear: number;
  readonly targetYear: number;
  /** `null` while the pre-flight count is loading or its fetch failed — the
   *  dialog then renders "…" (the count is display-only; the clone still runs). */
  readonly sourcePlanCount: number | null;
  readonly submitting?: boolean;
  readonly onConfirm: () => void;
}

export function CloneYearDialog({
  open,
  onOpenChange,
  sourceYear,
  targetYear,
  sourcePlanCount,
  submitting = false,
  onConfirm,
}: CloneYearDialogProps) {
  const t = useTranslations('admin.plans.clone');
  const locale = useLocale();
  // Stored CE; shown in the viewer's calendar (TH 2569).
  const shownSource = formatCalendarYear(sourceYear, locale);
  const shownTarget = formatCalendarYear(targetYear, locale);
  // "…" placeholder while the pre-flight count is loading or its fetch failed.
  const countLabel = sourcePlanCount ?? '…';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('title')}: {shownSource} → {shownTarget}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('description', {
              count: countLabel,
              sourceYear: shownSource,
              targetYear: shownTarget,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={submitting}
          >
            {submitting ? t('submitting') : t('submit', { count: countLabel })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
