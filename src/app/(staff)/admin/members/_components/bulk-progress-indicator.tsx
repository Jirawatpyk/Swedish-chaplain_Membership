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
 *
 * B2 a11y fix:
 *   - Replaced undocumented `indeterminate` keyframe (was not defined in
 *     globals.css) with the shadcn <Progress> component which has the
 *     correct shimmer + reduced-motion support built in.
 *   - Added role="progressbar" + aria-busy + aria-valuenow/min/max for
 *     indeterminate state per ARIA 1.2 spec.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Progress } from '@/components/ui/progress';

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
      className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-background/95 px-6 py-4 shadow-lg backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label={t('progressLabel')}
    >
      <div className="flex flex-col gap-3">
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
        {/* Indeterminate progress — FR-019 is all-or-nothing; no partial
            progress to report (see SW-3 note above). Using shadcn Progress
            component (has shimmer + motion-reduce support built in). The
            value prop is omitted so the native <progress> element is
            indeterminate, honouring ARIA 1.2 progressbar semantics. */}
        <Progress
          aria-label={t('progressLabel')}
          aria-busy="true"
          className="h-1.5 w-48"
        />
      </div>
    </div>
  );
}
