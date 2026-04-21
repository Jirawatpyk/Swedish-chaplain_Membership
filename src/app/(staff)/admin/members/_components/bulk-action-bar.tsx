'use client';

/**
 * T109 — Sticky-bottom bulk action toolbar (US4 FR-018/040).
 *
 * Appears when ≥1 row is selected. Shows "N selected" counter + action
 * menu + Clear affordance. Uses `scroll-margin-bottom` to prevent the
 * bar from obscuring focused elements (ADOPT-01 / WCAG 2.2 SC 2.4.11).
 *
 * Cap enforcement: if > 100 rows are selected, the action buttons are
 * disabled with a message instructing the admin to split the operation.
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArchiveIcon, MailIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ArchiveConfirmDialog } from './archive-confirm-dialog';
import { BulkProgressIndicator } from './bulk-progress-indicator';
import { BULK_CAP } from '@/lib/members-bulk-constants';

type BulkAction = 'archive' | 'change_plan' | 'send_portal_invite';

type Props = {
  readonly selectedIds: string[];
  readonly selectedCompanyNames: string[];
  readonly onClear: () => void;
};

export function BulkActionBar({
  selectedIds,
  selectedCompanyNames,
  onClear,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const router = useRouter();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{
    action: string;
    total: number;
  } | null>(null);

  const count = selectedIds.length;
  const overCap = count > BULK_CAP;

  const executeBulk = useCallback(
    async (action: BulkAction, params?: Record<string, unknown>) => {
      if (overCap) return;
      setExecuting(true);
      setProgress({ action, total: count });

      try {
        const res = await fetch('/api/members/bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            action,
            member_ids: selectedIds,
            ...(params ? { params } : {}),
          }),
        });

        const body = await res.json();

        if (res.ok) {
          toast.success(
            t('success', {
              count: body.updated_count,
              action: t(`actions.${action}`),
            }),
          );
          onClear();
          router.refresh();
        } else if (res.status === 429) {
          toast.error(t('rateLimited'));
        } else {
          toast.error(body.error?.message ?? t('unknownError'));
        }
      } catch {
        toast.error(t('networkError'));
      } finally {
        setExecuting(false);
        setProgress(null);
      }
    },
    [selectedIds, count, overCap, onClear, router, t],
  );

  const handleArchiveConfirm = useCallback(() => {
    setArchiveDialogOpen(false);
    executeBulk('archive');
  }, [executeBulk]);

  if (count === 0) return null;

  return (
    <>
      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur-sm shadow-lg"
        style={{ scrollMarginBottom: '80px' }}
        role="toolbar"
        aria-label={t('toolbarLabel')}
      >
        <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-4 px-4 py-3">
          {/* Left: selection count */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium" aria-live="polite">
              {t('selectedCount', { count })}
            </span>
            {overCap && (
              <span className="text-xs text-destructive" role="alert">
                {t('overCap', { max: BULK_CAP })}
              </span>
            )}
          </div>

          {/* Center: action buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={executing || overCap}
              onClick={() => setArchiveDialogOpen(true)}
              className="min-h-[36px]"
            >
              <ArchiveIcon className="mr-1.5 h-4 w-4" />
              {t('actions.archive')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={executing || overCap}
              onClick={() => executeBulk('send_portal_invite')}
              className="min-h-[36px]"
            >
              <MailIcon className="mr-1.5 h-4 w-4" />
              {t('actions.send_portal_invite')}
            </Button>
          </div>

          {/* Right: clear */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="min-h-[36px]"
          >
            <XIcon className="mr-1 h-4 w-4" />
            {t('clear')}
          </Button>
        </div>
      </div>

      {/* Spacer to prevent content from being hidden behind sticky bar */}
      <div className="h-16" aria-hidden="true" />

      <ArchiveConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        companyNames={selectedCompanyNames}
        count={count}
        onConfirm={handleArchiveConfirm}
      />

      {progress && (
        <BulkProgressIndicator
          action={progress.action}
          total={progress.total}
        />
      )}
    </>
  );
}
