'use client';

/**
 * DV-12 — Cancel-broadcast confirmation dialog (admin + member).
 *
 * Thin wrapper over the shared <ReasonConfirmationDialog> (DV-12 review #11
 * dedup): this file owns only the cancel-specific fetch + toast mapping; the
 * shared component owns reason state, focus, validation, render, and pending.
 *
 *   - Cap 500 chars.
 *   - reasonRequired=true  (admin) → textarea auto-focus; reason required 1–500.
 *   - reasonRequired=false (member) → Cancel button initial focus; reason ≤500.
 *   - 409 split by body.error.code:
 *       'broadcast_cancel_too_late'           → ${toastNamespace}.cancelTooLate
 *       'broadcast_concurrent_action_blocked' → ${toastNamespace}.concurrentRace
 *       anything else                         → ${toastNamespace}.cancelError
 *   - Non-409 errors keep the dialog open (retry) with the generic cancelError.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ReasonConfirmationDialog,
  useDialogFinalFocus,
} from '@/components/broadcast/reason-confirmation-dialog';

const MAX_REASON_LENGTH = 500;

export interface CancelBroadcastDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** POST target: /api/admin/broadcasts/{id}/cancel or /api/broadcasts/{id}/cancel */
  readonly endpoint: string;
  /** next-intl namespace for the dialog strings, e.g. "admin.broadcasts.cancelDialog" */
  readonly namespace: string;
  /** next-intl namespace for toast strings, e.g. "admin.broadcasts.toast" */
  readonly toastNamespace: string;
  /**
   * Admin usage: true — reason is required (1–500 chars); textarea auto-focuses.
   * Member usage: false — reason is optional (≤500 chars); Cancel button auto-focuses.
   */
  readonly reasonRequired: boolean;
  /**
   * F7-A11Y-1 — ref to the trigger button so focus returns to it on close
   * (Cancel / ESC paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function CancelBroadcastDialog({
  open,
  onOpenChange,
  endpoint,
  namespace,
  toastNamespace,
  reasonRequired,
  triggerRef,
}: CancelBroadcastDialogProps): React.ReactElement {
  const tToast = useTranslations(toastNamespace);
  const router = useRouter();
  const finalFocus = useDialogFinalFocus(triggerRef);

  async function onConfirm(reason: string): Promise<void> {
    try {
      const body = reason.trim()
        ? JSON.stringify({ cancellationReason: reason })
        : JSON.stringify({});
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        toast.success(tToast('cancelled'));
        onOpenChange(false);
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      if (res.status === 409) {
        if (json.error?.code === 'broadcast_cancel_too_late') {
          toast.error(tToast('cancelTooLate'));
        } else if (json.error?.code === 'broadcast_concurrent_action_blocked') {
          toast.error(tToast('concurrentRace'));
        } else {
          toast.error(tToast('cancelError'));
        }
        onOpenChange(false);
        router.refresh();
      } else {
        // Transient / unexpected non-409: keep the dialog open for retry.
        toast.error(tToast('cancelError'));
      }
    } catch {
      // Network throw: keep the dialog open for retry.
      toast.error(tToast('cancelError'));
    }
  }

  return (
    <ReasonConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      namespace={namespace}
      maxLength={MAX_REASON_LENGTH}
      reasonRequired={reasonRequired}
      fieldIdPrefix="cancel-reason"
      textareaRows={4}
      onConfirm={onConfirm}
      finalFocus={finalFocus}
    />
  );
}
