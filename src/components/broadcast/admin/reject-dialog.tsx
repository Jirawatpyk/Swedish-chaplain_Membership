'use client';

/**
 * T119 — Reject confirmation dialog with required reason textarea.
 *
 * FR-012: rejectionReason is REQUIRED (≥1 non-whitespace, ≤2000 chars).
 * Member sees the verbatim reason in their notification email.
 *
 * Thin wrapper over the shared <ReasonConfirmationDialog> (DV-12 review #11
 * dedup — reject + cancel shared ~180 lines of focus/validation/render). This
 * file owns only reject's fetch + toast mapping; the shared component owns
 * reason state, the double-RAF textarea auto-focus, validation, the counter,
 * pending, and reset-on-open. Behavior is preserved exactly:
 *   - max 2000, reason required, verbatim (untrimmed) reason in the body.
 *   - success → toast 'rejected' + close + refresh; any 409 → 'concurrentRace'
 *     + close + refresh; other non-ok / network → 'error', dialog stays open.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ReasonConfirmationDialog,
  useDialogFinalFocus,
} from '@/components/broadcast/reason-confirmation-dialog';

const MAX_REASON_LENGTH = 2000;

export interface RejectDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /**
   * F7-A11Y-1 — ref to the Reject trigger button so focus returns to it
   * on close (Cancel / ESC paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * F7-A11Y-1 — optional fallback focus target when the trigger has been
   * unmounted (the success path unmounts ReviewActions). Defaults to the
   * layout's #main-content landmark when omitted.
   */
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function RejectDialog({
  broadcastId,
  open,
  onOpenChange,
  triggerRef,
  fallbackFocusRef,
}: RejectDialogProps): React.ReactElement {
  const tToast = useTranslations('admin.broadcasts.toast');
  const router = useRouter();
  const finalFocus = useDialogFinalFocus(triggerRef, fallbackFocusRef);

  async function onConfirm(reason: string): Promise<void> {
    try {
      const res = await fetch(`/api/admin/broadcasts/${broadcastId}/reject`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason: reason }),
      });
      if (res.ok) {
        toast.success(tToast('rejected'));
        onOpenChange(false);
        router.refresh();
      } else if (res.status === 409) {
        toast.error(tToast('concurrentRace'));
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(tToast('error'));
      }
    } catch {
      toast.error(tToast('error'));
    }
  }

  return (
    <ReasonConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      namespace="admin.broadcasts.rejectDialog"
      maxLength={MAX_REASON_LENGTH}
      reasonRequired
      fieldIdPrefix="reject-reason"
      textareaRows={5}
      onConfirm={onConfirm}
      finalFocus={finalFocus}
    />
  );
}

// Default-export helper to allow Button-as-trigger composition by parent
export { RejectDialog as default };
