'use client';

/**
 * T053 (F7.1a US1) — Retry-failed-batches confirmation dialog.
 *
 * Wraps the admin retry action (POST /api/admin/broadcasts/[id]/retry)
 * in a shadcn AlertDialog with budget-remaining display + warning copy
 * about Resend API quota consumption + duplicate-email risk.
 *
 * UX (per docs/ux-standards.md):
 *   - SC-007 double-click guard: Submit button disables on first click
 *     + spinner replaces label while pending. Combined with the use
 *     case's `pg_try_advisory_xact_lock` (held inside `broadcasts.withTx`
 *     so it survives the snapshot+increment+fan-out+audit sequence —
 *     Phase 3E.1 hardening), the disabled-on-pending button is
 *     defence-in-depth against double-click, not the primary guard.
 *   - ESC closes (AlertDialog primitive)
 *   - Reduced-motion safe (no custom animations beyond AlertDialog defaults)
 *
 * i18n keys: admin.broadcasts.retryDialog.* + admin.broadcasts.toast.*
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';

export interface RetryConfirmationDialogProps {
  readonly broadcastId: string;
  readonly failedBatchCount: number;
  readonly retriesRemaining: number; // 0-3
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function RetryConfirmationDialog({
  broadcastId,
  failedBatchCount,
  retriesRemaining,
  open,
  onOpenChange,
}: RetryConfirmationDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.retryDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onConfirm(): void {
    if (pending || retriesRemaining <= 0) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcastId}/retry`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const body = (await res.json()) as {
            retryAttempt: number;
            retriedBatchCount: number;
          };
          toast.success(
            tToast('retrySuccess', {
              attempt: body.retryAttempt,
              count: body.retriedBatchCount,
            }),
          );
          onOpenChange(false);
          router.refresh();
          return;
        }

        // Map server error codes to specific toasts.
        const errBody = (await res.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const code = errBody?.error?.code;
        switch (code) {
          case 'broadcast_manual_retry_budget_exhausted':
            toast.error(tToast('retryBudgetExhausted'));
            break;
          case 'broadcast_already_retrying_in_progress':
            toast.error(tToast('retryAlreadyInProgress'));
            break;
          case 'broadcast_invalid_state_transition':
            toast.error(tToast('retryInvalidState'));
            break;
          default:
            toast.error(tToast('retryServerError'));
        }
        onOpenChange(false);
        router.refresh();
      } catch {
        toast.error(tToast('retryServerError'));
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('description', { count: failedBatchCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          <p className="font-medium text-foreground">
            {t('budgetLine', { remaining: retriesRemaining })}
          </p>
          <p className="text-muted-foreground">{t('warning')}</p>
        </div>
        <AlertDialogFooter>
          {/*
            Phase 3F.2 (UX Finding 1 — WCAG SC 2.4.3 + 3.2.1 fix):
            autoFocus on Cancel so the destructive Confirm is NOT the
            initial keyboard focus. Prevents accidental Enter-press
            triggering a Resend-quota-consuming retry. Matches
            docs/ux-standards.md § 6.2 destructive-action convention.
          */}
          <AlertDialogCancel disabled={pending} autoFocus>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || retriesRemaining <= 0}
            className={cn(
              'bg-primary text-primary-foreground',
              'hover:bg-primary/90',
              'focus-visible:ring-primary',
            )}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending ? t('submitting') : t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default RetryConfirmationDialog;
