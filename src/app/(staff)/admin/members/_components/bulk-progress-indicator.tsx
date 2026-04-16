'use client';

/**
 * T111 — Bulk progress indicator for > 1-second operations (FR-041).
 *
 * Shows an indeterminate progress bar + action description + elapsed
 * time while the bulk request is in-flight. Announced via aria-live so
 * screen readers are notified of the async operation.
 *
 * Staff-review SW-3 — FR-041 scope note:
 *   The spec asks for a DETERMINATE N-of-M indicator driven by SSE /
 *   polling. Under FR-019's all-or-nothing semantics, the server has no
 *   intermediate state to report — a bulk is either pending or done.
 *   We expose an elapsed-time counter instead, which gives the admin
 *   real feedback that the request is still alive without requiring a
 *   streaming backend. Cross-page SSE progress is tracked as a
 *   follow-up once per-member checkpoints exist (beyond MVP).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

type Props = {
  readonly action: string;
  readonly total: number;
};

export function BulkProgressIndicator({ action, total }: Props) {
  const t = useTranslations('admin.members.bulk');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Tick once per second while the indicator is mounted. Unmounts as
  // soon as the bulk resolves so there's no leak concern.
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.round((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-background/95 px-6 py-3 shadow-lg backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label={t('progressLabel')}
    >
      <div className="flex items-center gap-3">
        {/* Indeterminate progress bar (FR-019 is all-or-nothing; no
            partial progress to report — see SW-3 note above). */}
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary"
            style={{
              animationName: 'indeterminate',
            }}
          />
        </div>
        <div className="flex flex-col text-sm">
          <span className="text-muted-foreground">
            {t('progressMessage', { action: t(`actions.${action}`), count: total })}
          </span>
          {elapsedSeconds > 0 && (
            <span className="text-xs text-muted-foreground/80">
              {t('elapsedSeconds', { seconds: elapsedSeconds })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
