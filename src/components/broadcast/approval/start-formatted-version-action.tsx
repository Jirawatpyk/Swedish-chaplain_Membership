'use client';

/**
 * F119 T063 (US1-AS1, FR-001) — "Start formatted version".
 *
 * `POST /api/admin/broadcasts/[id]/version` → 201, then the page refreshes
 * into `in_design` with the writing tool open. The server page decides
 * WHETHER this control exists (the flag affordance on `submitted`, the
 * stage, the round, `broadcasts.write`); this island only performs it.
 *
 * Starting from `member_approved` / `approved` VOIDS the member's approval
 * and clears any confirmed send time (contract step 5, spec § Edge Cases
 * "Marketing edits after the member approved") — irreversible from here, so
 * that path asks first. From `submitted` / `changes_requested` nothing is
 * lost (the member was told at submission that marketing may format it,
 * FR-001), so it runs on the click.
 *
 * Focus: on success the trigger unmounts with the stage, so the shared
 * resolver lands on `#main-content`; on Cancel/ESC it returns to the trigger.
 */
import { useRef, useState, useTransition } from 'react';
import { Loader2Icon, PenLine } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { approvalErrorMessage, readErrorCode } from './approval-error';

export interface StartFormattedVersionActionProps {
  readonly broadcastId: string;
  /** True from `member_approved` / `approved`: starting voids that approval. */
  readonly voidsApproval: boolean;
  /** The round the member approved — named in the confirmation. */
  readonly round: number;
}

export function StartFormattedVersionAction({
  broadcastId,
  voidsApproval,
  round,
}: StartFormattedVersionActionProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approval.start');
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);

  function start(): void {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcastId}/version`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (res.ok) {
          closedViaSuccessRef.current = true;
          setConfirmOpen(false);
          toast.success(t('started'));
          router.refresh();
          return;
        }
        const code = await readErrorCode(res);
        toast.error(approvalErrorMessage(tErrors, code));
        if (res.status === 409 || res.status === 404) {
          // The stage moved (or the entry closed) under the page — refresh it.
          closedViaSuccessRef.current = true;
          setConfirmOpen(false);
          router.refresh();
        }
      } catch {
        toast.error(approvalErrorMessage(tErrors, null));
      }
    });
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        data-testid="eblast-start-version"
        variant={voidsApproval ? 'outline' : 'default'}
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => {
          closedViaSuccessRef.current = false;
          if (voidsApproval) setConfirmOpen(true);
          else start();
        }}
      >
        {pending && !confirmOpen ? (
          <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <PenLine className="size-4" aria-hidden="true" />
        )}
        {t('button')}
      </Button>
      {voidsApproval ? (
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(next) => {
            if (!pending) setConfirmOpen(next);
          }}
        >
          <AlertDialogContent className="max-w-lg" finalFocus={finalFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('voidTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('voidBody', { round })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>{t('voidCancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                aria-busy={pending || undefined}
                onClick={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                {pending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {t('voidConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
