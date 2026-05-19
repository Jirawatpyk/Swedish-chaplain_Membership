'use client';

/**
 * T052 (F7.1a US1) — Per-batch dispatch breakdown component.
 *
 * Collapsible section under the admin broadcast detail page that
 * surfaces per-batch_manifest state for broadcasts split into multiple
 * Resend audiences (FR-001 / FR-002 / FR-006). Each row shows:
 *   - Batch index + recipient range
 *   - Status badge (pending / sending / sent / failed / cancelled)
 *   - Dispatched-at timestamp (Bangkok wall-time)
 *   - Per-batch counters (delivered / bounced / complained / unsubscribed)
 *   - Retry count (auto: 0..5; manual: separate at broadcast level)
 *
 * Action surfaces:
 *   - "Retry failed batches" button (when broadcast.status='partially_sent'
 *     AND manualRetryRemaining > 0) → opens T053 RetryConfirmationDialog
 *   - "Accept partial delivery" button (when broadcast.status='partially_sent')
 *     → opens T054 AcceptPartialDialog
 *
 * UX (per docs/ux-standards.md):
 *   - Native `<details>/<summary>` collapsible — no JS state needed
 *     for expand/collapse, respects keyboard + screen-reader patterns
 *     automatically
 *   - aria-live="polite" on the summary line + batch counters so
 *     real-time webhook updates (router.refresh) announce nicely
 *   - WCAG 2.4.11 (Focus Not Obscured) — sticky action bar avoids
 *     overlapping focused buttons at narrow viewports
 *
 * No business logic — purely presentational. Server-side data is
 * pre-resolved by the admin detail page (T049) + handed in via props.
 */
import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { RetryConfirmationDialog } from './retry-confirmation-dialog';
import { AcceptPartialDialog } from './accept-partial-dialog';

export type BatchStatusForUi =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface BatchBreakdownRow {
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly recipientRangeStart: number;
  readonly recipientRangeEnd: number;
  readonly recipientCount: number;
  readonly status: BatchStatusForUi;
  readonly dispatchedAt: string | null; // ISO 8601 UTC
  readonly retryCount: number;
  readonly deliveredCount: number;
  readonly bouncedCount: number;
  readonly complainedCount: number;
  readonly unsubscribedCount: number;
}

export interface BatchBreakdownProps {
  readonly broadcastId: string;
  /**
   * Broadcast-level status — gates whether retry/accept-partial
   * actions are available. Only `partially_sent` enables them.
   */
  readonly broadcastStatus: string;
  /**
   * Manual-retry budget remaining (3 - manualRetryCount). When 0,
   * Retry button shows disabled + budget-exhausted hint.
   */
  readonly manualRetryRemaining: number;
  readonly batches: ReadonlyArray<BatchBreakdownRow>;
  /**
   * Optional: defaults closed for performance (avoids rendering a
   * 50-row table for an `all_members` 50k-recipient broadcast on the
   * critical detail-page paint).
   */
  readonly defaultOpen?: boolean;
}

const STATUS_BADGE_VARIANT: Record<
  BatchStatusForUi,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  sending: 'secondary',
  sent: 'default',
  failed: 'destructive',
  cancelled: 'outline',
};

/**
 * Map BatchStatus → i18n label literal. Explicit-branch lookup (no
 * dynamic `t(\`batchStatus.${status}\`)`) per i18n.md CHK053:
 * statically-discoverable keys only.
 */
function batchStatusLabel(
  status: BatchStatusForUi,
  t: (key: string) => string,
): string {
  switch (status) {
    case 'pending':
      return t('batchStatus.pending');
    case 'sending':
      return t('batchStatus.sending');
    case 'sent':
      return t('batchStatus.sent');
    case 'failed':
      return t('batchStatus.failed');
    case 'cancelled':
      return t('batchStatus.cancelled');
  }
}

function formatDispatchedAt(iso: string | null, locale: string): string {
  if (iso === null) return '—';
  // Phase 3F.2 (UX Finding 3 fix): pin Asia/Bangkok TZ + use the
  // active next-intl locale. Previously `toLocaleString(undefined,
  // …)` used browser-default TZ → Vercel sin1 servers rendered
  // Singapore time (+0:30 off Bangkok wall-time advertised by the
  // metadata block above the table). Now the timestamp matches the
  // server page's `timeZone: 'Asia/Bangkok'` convention. For `th`
  // locale we also pass `ca-buddhist` for BE-year display (matches
  // existing F4 invoicing convention).
  try {
    const resolvedLocale = locale === 'th' ? 'th-TH-u-ca-buddhist' : locale;
    return new Date(iso).toLocaleString(resolvedLocale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Bangkok',
    });
  } catch {
    return iso;
  }
}

export function BatchBreakdown({
  broadcastId,
  broadcastStatus,
  manualRetryRemaining,
  batches,
  defaultOpen = false,
}: BatchBreakdownProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.batches');
  const locale = useLocale();
  const tDialogs = useTranslations('admin.broadcasts');
  const [retryOpen, setRetryOpen] = useState(false);
  const [acceptPartialOpen, setAcceptPartialOpen] = useState(false);

  const counts = useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    let pending = 0;
    for (const b of batches) {
      if (b.status === 'sent') succeeded++;
      else if (b.status === 'failed') failed++;
      else if (b.status === 'pending' || b.status === 'sending') pending++;
    }
    return { succeeded, failed, pending };
  }, [batches]);

  const failedBatchCount = useMemo(
    () => batches.filter((b) => b.status === 'failed').length,
    [batches],
  );

  const canRetry =
    broadcastStatus === 'partially_sent' &&
    manualRetryRemaining > 0 &&
    failedBatchCount > 0;
  const canAcceptPartial = broadcastStatus === 'partially_sent';

  if (batches.length === 0) {
    return (
      <section className="rounded-md border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{t('notSplit')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="batches-breakdown-heading" className="space-y-4">
      <details className="group rounded-md border" open={defaultOpen}>
        <summary
          className={cn(
            'flex cursor-pointer select-none items-center justify-between gap-4 p-4',
            'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2',
            'focus-visible:ring-ring',
          )}
        >
          <div className="space-y-1">
            <h3
              id="batches-breakdown-heading"
              className="text-base font-semibold"
            >
              {t('title')}
            </h3>
            <p
              className="text-sm text-muted-foreground"
              aria-live="polite"
            >
              {t('summary', {
                succeeded: counts.succeeded,
                failed: counts.failed,
                pending: counts.pending,
                total: batches.length,
              })}
            </p>
          </div>
          <span className="text-sm text-muted-foreground group-open:hidden">
            {t('expandLabel')}
          </span>
          <span className="hidden text-sm text-muted-foreground group-open:inline">
            {t('collapseLabel')}
          </span>
        </summary>

        <div className="space-y-4 border-t p-4">
          <p className="text-sm text-muted-foreground">
            {t('description', { count: batches.length })}
          </p>

          {broadcastStatus === 'partially_sent' ? (
            <p
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                manualRetryRemaining > 0
                  ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'
                  : 'border-destructive/30 bg-destructive/5 text-destructive',
              )}
              role="status"
            >
              {manualRetryRemaining > 0
                ? t('manualRetryRemaining', { remaining: manualRetryRemaining })
                : t('manualRetryExhausted')}
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              {/*
                Phase 3F.2 (UX Finding 2 — WCAG SC 1.3.1 + 4.1.2 fix):
                screen-reader-only caption gives the data-table a
                programmatic name. Without this, axe-core flags
                `table-duplicate-name`/`scope-attr-valid` and SR users
                navigating with table-jump keystrokes hear nothing
                identifying the table before column headers.
              */}
              <caption className="sr-only">
                {t('tableCaption', { count: batches.length })}
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">{t('columns.batchIndex')}</TableHead>
                  <TableHead>{t('columns.recipientRange')}</TableHead>
                  <TableHead className="text-right">{t('columns.recipientCount')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.dispatchedAt')}</TableHead>
                  <TableHead className="text-right">{t('columns.delivered')}</TableHead>
                  <TableHead className="text-right">{t('columns.bounced')}</TableHead>
                  <TableHead className="text-right">{t('columns.complained')}</TableHead>
                  <TableHead className="text-right">{t('columns.unsubscribed')}</TableHead>
                  <TableHead className="text-right">{t('columns.retryCount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.batchManifestId}>
                    <TableCell className="font-mono text-xs">
                      {batch.batchIndex + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t('rangeLabel', {
                        start: batch.recipientRangeStart,
                        end: batch.recipientRangeEnd,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      {batch.recipientCount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE_VARIANT[batch.status]}>
                        {batchStatusLabel(batch.status, t)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDispatchedAt(batch.dispatchedAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      {batch.deliveredCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {batch.bouncedCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {batch.complainedCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {batch.unsubscribedCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {t('retryCountLabel', { count: batch.retryCount })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {(canRetry || canAcceptPartial) && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
              {canAcceptPartial ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAcceptPartialOpen(true)}
                  aria-label={tDialogs('acceptPartialDialog.triggerAria')}
                >
                  {tDialogs('acceptPartialDialog.trigger')}
                </Button>
              ) : null}
              {canRetry ? (
                <Button
                  type="button"
                  onClick={() => setRetryOpen(true)}
                  aria-label={tDialogs('retryDialog.triggerAria', {
                    count: failedBatchCount,
                  })}
                >
                  {tDialogs('retryDialog.trigger')}
                </Button>
              ) : broadcastStatus === 'partially_sent' &&
                manualRetryRemaining <= 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled
                  aria-label={tDialogs('retryDialog.triggerDisabledAria')}
                >
                  {tDialogs('retryDialog.trigger')}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </details>

      <RetryConfirmationDialog
        broadcastId={broadcastId}
        failedBatchCount={failedBatchCount}
        retriesRemaining={manualRetryRemaining}
        open={retryOpen}
        onOpenChange={setRetryOpen}
      />
      <AcceptPartialDialog
        broadcastId={broadcastId}
        sentBatchCount={counts.succeeded}
        totalBatchCount={batches.length}
        open={acceptPartialOpen}
        onOpenChange={setAcceptPartialOpen}
      />
    </section>
  );
}

export default BatchBreakdown;
