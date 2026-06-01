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
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { BULK_CAP } from '@/lib/members-bulk-constants';

// I9 round-10 ui-design-specialist — `change_plan` was declared but
// never surfaced as a button (only Archive + Send-Portal-Invite render
// below). Dropped from the union so a future refactor can't fork to
// dead code; if reintroduced, add both the button AND the union entry
// in the same diff. The i18n string `admin.members.bulk.actions.change_plan`
// is preserved for if/when the button lands.
type BulkAction = 'archive' | 'send_portal_invite';

type Props = {
  readonly selectedIds: string[];
  readonly selectedCompanyNames: string[];
  /**
   * Total rows matching the current directory filter (across ALL
   * pages). Used by `overCapHelper` to say "X of Y matching" rather
   * than the tautological "X of X selected" the initial cut produced.
   */
  readonly totalMatching: number;
  readonly onClear: () => void;
};

export function BulkActionBar({
  selectedIds,
  selectedCompanyNames,
  totalMatching,
  onClear,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const router = useRouter();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
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
          if (action === 'send_portal_invite') {
            // P1-17 — per-member buckets (queued / skipped / failed). Partial
            // success is still 200; surface the breakdown + use an error toast
            // only when at least one member failed (bad data / transient).
            const c = body.counts ?? { invited: 0, skipped: 0, failed: 0 };
            const parts = [t('inviteQueued', { invited: c.invited })];
            if (c.skipped > 0) parts.push(t('inviteSkipped', { skipped: c.skipped }));
            if (c.failed > 0) parts.push(t('inviteFailed', { failed: c.failed }));
            const message = parts.join(' · ');
            // Only a green success when at least one invite was actually queued.
            // If every member was skipped (e.g. all already linked → invited=0,
            // failed=0) nothing was done, so use a neutral info toast — a success
            // tick on a no-op misleads the admin into thinking invites were sent.
            if (c.failed > 0) toast.error(message);
            else if (c.invited > 0) toast.success(message);
            else toast.info(message);
          } else {
            toast.success(
              t('success', {
                count: body.updated_count,
                action: t(`actions.${action}`),
              }),
            );
          }
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

  // H7: keep dialog open (with pending spinner) while archive is in-flight
  // so the admin gets visual feedback that the action was accepted and is
  // running. The dialog closes on completion (success or error).
  const handleArchiveConfirm = useCallback(async () => {
    await executeBulk('archive');
    setArchiveDialogOpen(false);
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
              <div className="flex flex-col gap-0.5" role="alert">
                <span className="text-xs font-medium text-destructive">
                  {t('overCap', { max: BULK_CAP })}
                </span>
                {/* I2 round-10 ui-design-specialist — surface concrete
                    split guidance ("X of Y selected — deselect past row
                    Z, or filter the list") instead of just a "Maximum
                    100" error. Admins need the next step, not just the
                    constraint. */}
                <span className="text-xs text-muted-foreground">
                  {t('overCapHelper', {
                    count,
                    total: totalMatching,
                    max: BULK_CAP,
                  })}
                </span>
              </div>
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
              onClick={() => setInviteDialogOpen(true)}
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
        pending={executing}
      />

      <ConfirmationDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        title={t('confirmInviteTitle', { count })}
        description={t('confirmInviteDescription')}
        confirmLabel={t('confirmInviteAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={() => executeBulk('send_portal_invite')}
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
