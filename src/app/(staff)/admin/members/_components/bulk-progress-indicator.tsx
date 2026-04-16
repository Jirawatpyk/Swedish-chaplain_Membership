'use client';

/**
 * T111 — Bulk progress indicator for > 1-second operations (FR-041).
 *
 * Shows an indeterminate progress bar + action description while the
 * bulk request is in-flight. Announced via aria-live so screen readers
 * are notified of the async operation.
 */

import { useTranslations } from 'next-intl';

type Props = {
  readonly action: string;
  readonly total: number;
};

export function BulkProgressIndicator({ action, total }: Props) {
  const t = useTranslations('admin.members.bulk');

  return (
    <div
      className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-background/95 px-6 py-3 shadow-lg backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label={t('progressLabel')}
    >
      <div className="flex items-center gap-3">
        {/* Indeterminate progress bar */}
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary"
            style={{
              animationName: 'indeterminate',
            }}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {t('progressMessage', { action: t(`actions.${action}`), count: total })}
        </span>
      </div>
    </div>
  );
}
