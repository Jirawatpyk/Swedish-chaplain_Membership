'use client';

/**
 * F119 T063 (US1-AS1, FR-001) — "Start formatted version".
 *
 * `POST /api/admin/broadcasts/[id]/version` → 201, then the page refreshes
 * into `in_design` with the writing tool open. The server page decides
 * WHETHER this control exists (the flag affordance on `submitted`, the
 * stage, the round, `broadcasts.write`) and what starting COSTS from its
 * stage (`confirm`); this island only performs it.
 *
 *   - `voids_approval` (from `member_approved` / `approved` after a round):
 *     starting withdraws the member's approval and clears any confirmed send
 *     time (contract step 5, spec § Edge Cases "Marketing edits after the
 *     member approved") — irreversible from here, so it asks first, in the
 *     destructive voice.
 *   - `leaves_submitted` (from `submitted`, UX review M3): the approve-as-
 *     submitted path ends — the member must approve the formatted version —
 *     so it asks first, without alarm. Approve is that stage's primary action,
 *     so this one is the secondary (`outline`) button.
 *   - `none` (from `changes_requested`): nothing is lost, and starting the
 *     next version is the stage's primary action, so it runs on the click.
 *
 * A refusal that keeps the confirmation open is said inside it (`role="alert"`,
 * cleared at the start of each request so a repeat is announced) — a toast
 * renders outside the modal, which hides everything outside itself from AT
 * (H1). The trigger turns unavailable while it holds focus, so it is
 * `focusableWhenDisabled` (H2). The READ_ONLY_MODE write freeze (PR #392
 * review C1) is main #390's read-only warning — and, when the confirmation
 * is open, the same words inside it.
 *
 * Focus: on success the trigger unmounts with the stage, so the shared
 * resolver lands on `#main-content`; on Cancel/ESC it returns to the trigger.
 * The no-confirm path (`none`) has no dialog to hand focus on, so it moves
 * focus to `#main-content` itself before the refresh takes the trigger away —
 * otherwise it fell to `<body>` (T086a V1). The writing tool's subject field
 * does not exist yet at that moment: it mounts only when the refreshed page
 * lands.
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
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { approvalErrorMessage, readErrorCode } from './approval-error';
import { InlineError } from './inline-error';

/** What starting a formatted version costs from the page's stage — and so whether it asks first. */
export type StartConfirm = 'none' | 'leaves_submitted' | 'voids_approval';

export interface StartFormattedVersionActionProps {
  readonly broadcastId: string;
  readonly confirm: StartConfirm;
  /** The round the member approved — named in the `voids_approval` confirmation. */
  readonly round: number;
}

export function StartFormattedVersionAction({
  broadcastId,
  confirm,
  round,
}: StartFormattedVersionActionProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approval.start');
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const router = useRouter();
  const readOnlyToast = useReadOnlyToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  const asks = confirm !== 'none';
  const voids = confirm === 'voids_approval';

  /** T086a V1 — see the docblock: the dialog paths get this from `finalFocus`. */
  function handFocusOnBeforeUnmount(): void {
    if (!asks) document.getElementById('main-content')?.focus({ preventScroll: true });
  }

  function start(): void {
    if (pending) return;
    setDialogError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcastId}/version`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (res.ok) {
          closedViaSuccessRef.current = true;
          setConfirmOpen(false);
          handFocusOnBeforeUnmount();
          toast.success(t('started'));
          router.refresh();
          return;
        }
        if (await isReadOnlyResponse(res)) {
          const title = readOnlyToast();
          if (asks) setDialogError(title);
          return;
        }
        const message = approvalErrorMessage(tErrors, await readErrorCode(res));
        if (res.status === 409 || res.status === 404) {
          // The stage moved (or the entry closed) under the page — refresh it.
          closedViaSuccessRef.current = true;
          setConfirmOpen(false);
          handFocusOnBeforeUnmount();
          toast.error(message);
          router.refresh();
          return;
        }
        if (asks) setDialogError(message);
        else toast.error(message);
      } catch {
        const message = approvalErrorMessage(tErrors, null);
        if (asks) setDialogError(message);
        else toast.error(message);
      }
    });
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        data-testid="eblast-start-version"
        variant={asks ? 'outline' : 'default'}
        disabled={pending}
        focusableWhenDisabled
        aria-busy={pending || undefined}
        onClick={() => {
          if (pending) return;
          closedViaSuccessRef.current = false;
          if (asks) {
            setDialogError(null);
            setConfirmOpen(true);
          } else start();
        }}
      >
        {pending && !confirmOpen ? (
          <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <PenLine className="size-4" aria-hidden="true" />
        )}
        {t('button')}
      </Button>
      {asks ? (
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(next) => {
            if (!pending) setConfirmOpen(next);
          }}
        >
          <AlertDialogContent finalFocus={finalFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>{voids ? t('voidTitle') : t('submittedTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{voids ? t('voidBody', { round }) : t('submittedBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            {dialogError !== null ? <InlineError id="eblast-start-version-error" message={dialogError} /> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>{voids ? t('voidCancel') : t('submittedCancel')}</AlertDialogCancel>
              <AlertDialogAction
                data-testid="eblast-start-version-confirm"
                variant={voids ? 'destructive' : 'default'}
                disabled={pending}
                focusableWhenDisabled
                aria-busy={pending || undefined}
                onClick={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                {pending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {voids ? t('voidConfirm') : t('submittedConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
