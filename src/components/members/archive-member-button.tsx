'use client';

/**
 * T142 — Archive action for the member detail page (US7 AS1).
 *
 * Opens a confirmation dialog with optional reason textarea. Submits
 * POST /api/members/:id/archive with a fresh Idempotency-Key, then
 * refreshes the page on success so the ArchivedBanner appears and
 * the edit button disappears.
 */

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArchiveIcon, Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  readonly memberId: string;
  readonly companyName: string;
};

export function ArchiveMemberButton({ memberId, companyName }: Props) {
  const t = useTranslations('admin.members.archive');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();

  // R006 (staff-review-20260417-us7) — reset transient dialog state
  // whenever the dialog closes (cancel, Esc, backdrop click). Same
  // pattern as _components/archive-confirm-dialog.tsx:50–58 for bulk
  // archive. Prevents a stale `reason` from bleeding into a later
  // archive attempt after the admin cancelled the first one.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setReason('');
      setLoading(false);
    }
    setOpen(next);
  }, []);

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await fetch(`/api/members/${memberId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (res.ok) {
        toast.success(t('archiveSuccess', { companyName }));
        setOpen(false);
        setReason('');
        startTransition(() => router.refresh());
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        // Map the server error CODE to localized copy — never render the
        // server's raw English `error.message`.
        const message =
          data.error?.code === 'state_error'
            ? t('archiveAlreadyArchived')
            : data.error?.code === 'not_found'
              ? t('archiveNotFound')
              : t('archiveError');
        toast.error(message);
      }
    } catch {
      toast.error(t('archiveError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger
        className={buttonVariants({ variant: 'destructive-outline' })}
        aria-label={t('archiveCta')}
      >
        <ArchiveIcon className="size-4" aria-hidden="true" />
        {t('archiveCta')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('confirmTitle', { companyName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('confirmDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="archive-reason" className="text-sm">
            {t('reasonLabel')}
          </Label>
          <Textarea
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder={t('reasonPlaceholder')}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            {t('reasonHelper')}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={loading}
            aria-busy={loading}
            className={buttonVariants({ variant: 'destructive' })}
          >
            {loading && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {loading ? t('archivingInProgress') : t('confirmCta')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
