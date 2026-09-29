'use client';

/**
 * T142 — Archive action for the member detail page (US7 AS1).
 *
 * Opens a confirmation dialog with optional reason textarea. Submits
 * POST /api/members/:id/archive with a fresh Idempotency-Key, then
 * refreshes the page on success so the ArchivedBanner appears and
 * the edit button disappears.
 *
 * Spec 122 US5b-1: the shared AURA `ConfirmationDialog` (an alertdialog that
 * starts on Cancel), the reason on AURA `Textarea` with its limit as the
 * field's hint. A standalone destructive button, never a menu item
 * (ux-standards § 19).
 */

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArchiveIcon } from 'lucide-react';
import { Button, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

type Props = {
  readonly memberId: string;
  readonly companyName: string;
  /**
   * Opened by the caller instead of its own button (spec 122 US5b-1: the
   * phone header's ⋯ menu). With `showTrigger={false}` no button renders.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly showTrigger?: boolean;
};

export function ArchiveMemberButton({
  memberId,
  companyName,
  open: openProp,
  onOpenChange,
  showTrigger = true,
}: Props) {
  const t = useTranslations('admin.members.archive');
  const router = useRouter();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const [reason, setReason] = useState('');
  const [, startTransition] = useTransition();

  // R006 (staff-review-20260417-us7) — reset transient dialog state
  // whenever the dialog closes (cancel, Esc, backdrop click). Same
  // pattern as _components/archive-confirm-dialog.tsx:50–58 for bulk
  // archive. Prevents a stale `reason` from bleeding into a later
  // archive attempt after the admin cancelled the first one.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setReason('');
      setOpen(next);
    },
    [setOpen],
  );

  // ConfirmationDialog shows the busy state and blocks a second click; it
  // closes only on success (a refusal keeps the typed reason).
  async function handleConfirm() {
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
    }
  }

  return (
    <>
      {showTrigger && (
        <Button variant="danger-secondary" onClick={() => setOpen(true)}>
          <ArchiveIcon className="size-4" aria-hidden="true" />
          {t('archiveCta')}
        </Button>
      )}
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('confirmTitle', { companyName })}
        description={t('confirmDescription')}
        confirmLabel={t('confirmCta')}
        cancelLabel={t('cancel')}
        destructive
        closeOnConfirm={false}
        onConfirm={handleConfirm}
      >
        <Textarea
          id="archive-reason"
          label={t('reasonLabel')}
          hint={t('reasonHelper')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder={t('reasonPlaceholder')}
          rows={3}
        />
      </ConfirmationDialog>
    </>
  );
}
