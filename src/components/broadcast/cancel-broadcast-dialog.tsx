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
 *   - 404 / 403 (broadcast gone / not permitted) → close + refresh; retrying a
 *     permanent error is futile and leaving the dialog open invites a loop.
 *   - Other non-409 (5xx / network throw) keep the dialog open for retry.
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
   * Success toast key under `toastNamespace`. Defaults to 'cancelled'; the
   * F7.1a mid-dispatch halt variant passes 'halted' (same /cancel endpoint,
   * the use-case stops only the pending batches).
   */
  readonly successToastKey?: string;
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
  successToastKey = 'cancelled',
  triggerRef,
}: CancelBroadcastDialogProps): React.ReactElement {
  const tToast = useTranslations(toastNamespace);
  const router = useRouter();
  const finalFocus = useDialogFinalFocus(triggerRef);

  async function onConfirm(reason: string): Promise<void> {
    try {
      const trimmed = reason.trim();
      const body = trimmed
        ? JSON.stringify({ cancellationReason: trimmed })
        : JSON.stringify({});
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        toast.success(tToast(successToastKey));
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
      } else if (res.status === 404 || res.status === 403) {
        // Permanent: the broadcast is gone (404 — incl. a cross-member /
        // concurrently-deleted broadcast) or not permitted (403). Retrying is
        // futile, so close + refresh to update the stale view instead of
        // leaving the dialog open over a doomed request.
        toast.error(tToast('cancelError'));
        onOpenChange(false);
        router.refresh();
      } else {
        // Transient (5xx / unexpected): keep the dialog open for retry.
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
