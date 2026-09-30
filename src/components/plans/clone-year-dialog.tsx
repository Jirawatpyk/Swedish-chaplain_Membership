/**
 * T107 — CloneYearDialog (US2).
 *
 * Confirmation dialog that surfaces before the bulk clone runs.
 * Follows UX standards § 4.1 — destructive-action-like confirmation
 * with an explicit verb ("Clone 2026 → 2027") and the row count.
 *
 * 122 US6 (T607): AURA `Dialog` with `role="alertdialog"` (no board draws
 * it): a stray scrim click doesn't dismiss the gate; Escape and Cancel do,
 * and neither while the clone runs.
 */
'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { formatCalendarYear } from '@/lib/format-date-localised';

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
    <Dialog
      role="alertdialog"
      open={open}
      onClose={() => {
        if (!submitting) onOpenChange(false);
      }}
      dismissible={!submitting}
      title={`${t('title')}: ${shownSource} → ${shownTarget}`}
      description={t.rich('description', {
        count: countLabel,
        sourceYear: shownSource,
        targetYear: shownTarget,
        b: (chunks) => <strong>{chunks}</strong>,
      })}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button icon="copy" loading={submitting} disabled={submitting} onClick={onConfirm}>
            {submitting ? t('submitting') : t('submit', { count: countLabel })}
          </Button>
        </>
      }
    />
  );
}
