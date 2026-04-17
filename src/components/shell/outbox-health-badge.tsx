/**
 * OutboxHealthBadge — proactive email-delivery alert in the admin header.
 *
 * Rendered as an async Server Component so the DB query runs server-side
 * without a client fetch. Wrapped in <Suspense fallback={null}> at the
 * call-site so a slow DB never delays the layout paint.
 *
 * Shows nothing when healthy (zero noise for normal ops).
 * Shows an amber AlertTriangle + Tooltip when:
 *   - permanentFailed > 0  — rows flipped to `permanently_failed` in last 24h
 *   - stuckPending   > 0  — `pending` rows whose next_retry_at is > 30 min past
 *
 * Alert threshold mirrors Level 1+2 metric thresholds in outbox-dispatch cron.
 */
import { unstable_noStore as noStore } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { and, count, eq, gte, lt } from 'drizzle-orm';
/* eslint-disable no-restricted-imports --
 * Shell component reads operational outbox state for admin awareness.
 * Same escape-hatch pattern as the cron dispatcher. */
import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
/* eslint-enable no-restricted-imports */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export async function OutboxHealthBadge() {
  noStore();
  // eslint-disable-next-line react-hooks/purity -- RSC reads wall-clock time for dynamic DB thresholds; noStore() opts out of caching.
  const now = Date.now();
  const last24h = new Date(now - 24 * 60 * 60_000);
  const stuckThreshold = new Date(now - 30 * 60_000);

  const [[pf], [sp]] = await Promise.all([
    db
      .select({ n: count() })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.status, 'permanently_failed'),
          gte(notificationsOutbox.updatedAt, last24h),
        ),
      ),
    db
      .select({ n: count() })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.status, 'pending'),
          lt(notificationsOutbox.nextRetryAt, stuckThreshold),
        ),
      ),
  ]);

  const permanentFailed = pf?.n ?? 0;
  const stuckPending = sp?.n ?? 0;

  if (permanentFailed === 0 && stuckPending === 0) return null;

  const t = await getTranslations('admin.outboxHealth');

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={t('label')}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-amber-500 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AlertTriangle className="size-4" aria-hidden />
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-xs space-y-1 text-sm"
      >
        <p className="font-medium">{t('label')}</p>
        {permanentFailed > 0 && (
          <p className="text-muted-foreground">
            {t('permanentFailed', { count: permanentFailed })}
          </p>
        )}
        {stuckPending > 0 && (
          <p className="text-muted-foreground">
            {t('stuckPending', { count: stuckPending })}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
