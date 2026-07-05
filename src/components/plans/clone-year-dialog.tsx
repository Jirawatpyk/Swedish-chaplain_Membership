/**
 * T107 — CloneYearDialog (US2).
 *
 * Confirmation dialog that surfaces before the bulk clone runs.
 * Follows UX standards § 4.1 — destructive-action-like confirmation
 * with an explicit verb ("Clone 2026 → 2027") and the row count.
 */
'use client';

import { useTranslations } from 'next-intl';
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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('title')}: {sourceYear} → {targetYear}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('description', {
              count: sourcePlanCount ?? '…',
              sourceYear,
              targetYear,
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
            {submitting
              ? t('submitting')
              : t('submit', { count: sourcePlanCount ?? '…' })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
