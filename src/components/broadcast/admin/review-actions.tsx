'use client';

/**
 * T118 — Review actions trio per row.
 *
 * Buttons: "Approve & send now / schedule" + "Reject". Hidden for
 * manager role (parent renders only when role is admin).
 *
 * Local state opens approve-dialog or reject-dialog. State scoped to
 * one row instance — clicking another row's actions opens its own
 * dialog.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApproveDialog } from './approve-dialog';
import { RejectDialog } from './reject-dialog';

export interface ReviewActionsProps {
  readonly broadcastId: string;
  /**
   * Task 6 (2026-08-01-broadcast-review-queue-pr1) — passed through to
   * `ApproveDialog` so the admin sees the estimated recipient count
   * before approving.
   */
  readonly recipientCount?: number;
  /**
   * F119 B1 — which half of the pair to offer (both default `true`, so the
   * queue rows are unchanged). The detail page offers Approve (approve-AS-
   * SUBMITTED) on `submitted` only, and Reject wherever the Domain
   * `canTransition(status, 'rejected')` admits it; an absent half mounts
   * neither its trigger nor its dialog.
   */
  readonly showApprove?: boolean;
  readonly showReject?: boolean;
}

export function ReviewActions({
  broadcastId,
  recipientCount,
  showApprove = true,
  showReject = true,
}: ReviewActionsProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approveDialog');
  const tReject = useTranslations('admin.broadcasts.rejectDialog');
  const [approveOpen, setApproveOpen] = useState<boolean>(false);
  const [rejectOpen, setRejectOpen] = useState<boolean>(false);
  // F7-A11Y-1 — finalFocus targets handed to the dialogs so focus returns
  // to the trigger on Cancel/ESC. On the success path this component
  // unmounts (status leaves 'submitted'), so the dialogs fall back to the
  // layout's #main-content landmark.
  const approveTriggerRef = useRef<HTMLButtonElement>(null);
  const rejectTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    // D3 UX hardening — Approve + Reject are primary decision actions
    // (FR-011, FR-012); align to size="default" (h-9 / 36 px) per
    // shadcn-customizations.md base + ux-standards § 19. Previously
    // size="sm" (h-7) failed WCAG 2.5.5 minimum touch target on mobile.
    <div className="flex flex-wrap items-center gap-2">
      {showApprove ? (
        <>
          <Button
            variant="default"
            ref={approveTriggerRef}
            onClick={() => setApproveOpen(true)}
          >
            <CheckCircle2 className="mr-1 size-4" aria-hidden="true" />
            {t('confirm')}
          </Button>
          <ApproveDialog
            broadcastId={broadcastId}
            open={approveOpen}
            onOpenChange={setApproveOpen}
            triggerRef={approveTriggerRef}
            {...(recipientCount !== undefined ? { recipientCount } : {})}
          />
        </>
      ) : null}
      {showReject ? (
        <>
          <Button
            variant="destructive-outline"
            ref={rejectTriggerRef}
            onClick={() => setRejectOpen(true)}
          >
            <XCircle className="mr-1 size-4" aria-hidden="true" />
            {tReject('confirm')}
          </Button>
          <RejectDialog
            broadcastId={broadcastId}
            open={rejectOpen}
            onOpenChange={setRejectOpen}
            triggerRef={rejectTriggerRef}
          />
        </>
      ) : null}
    </div>
  );
}
