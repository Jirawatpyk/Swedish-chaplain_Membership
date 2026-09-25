'use client';

/**
 * DV-12 — Cancel-broadcast confirmation dialog (admin + member).
 *
 * Thin wrapper over the shared <ReasonConfirmationDialog> (DV-12 review #11
 * dedup): this file owns only the cancel-specific fetch + toast mapping; the
 * shared component owns reason state, focus, validation, render, and pending.
 *
 *   - F119 U35 — confirm also waits for the E-Blast's SUBJECT to be typed
 *     (maintainer decision) on both surfaces: a cancelled E-Blast cannot be
 *     re-sent (ux-standards § 6.3). A punctuation-only subject falls back to
 *     the fixed per-locale word — see `ReasonConfirmationDialog.typedPhrase`.
 *   - Cap 500 chars.
 *   - reasonRequired=true  (admin) → textarea auto-focus; reason required 1–500.
 *   - reasonRequired=false (member) → Cancel button initial focus; reason ≤500.
 *   - 409 split by body.error.code:
 *       'sending_started' (F119 T081, `sending` onward) or
 *       'broadcast_cancel_too_late' (closed) → ${toastNamespace}.cancelTooLate
 *       'broadcast_concurrent_action_blocked' → ${toastNamespace}.concurrentRace
 *       anything else                         → ${toastNamespace}.cancelError
 *   - 404 / 403 (broadcast gone / not permitted) → close + refresh; retrying a
 *     permanent error is futile and leaving the dialog open invites a loop.
 *     Every closing path closes FIRST and toasts after, so the toast is not
 *     born under the modal's aria-hidden outside.
 *   - Other non-409 (5xx / network throw) keep the dialog open for retry and
 *     say so INSIDE it (the shared dialog's `refusal`, `role="alert"`,
 *     focused — ux-standards § 6.4): a toast would render behind the modal.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
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
   * Success toast key under `toastNamespace`. Defaults to 'cancelled'.
   *
   * Parameterised rather than hardcoded because the admin and member surfaces
   * read different namespaces. The only caller that passed a different KEY was
   * the `variant="halt"` arm, deleted in 108 Phase 9's round-3 sweep along with
   * the batch model it halted; the parameter stays because the namespace split it
   * serves is still real.
   */
  readonly successToastKey?: string;
  /**
   * F7-A11Y-1 — ref to the trigger button so focus returns to it on close
   * (Cancel / ESC paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /** The E-Blast's subject — what the person types to confirm (U35). */
  readonly subject: string;
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
  subject,
}: CancelBroadcastDialogProps): React.ReactElement {
  const tToast = useTranslations(toastNamespace);
  const readOnlyToast = useReadOnlyToast();
  const router = useRouter();
  // F7-A11Y-1 — raised on every programmatic close path below (success / 409 /
  // 404 / 403), each of which runs router.refresh() → the cancel trigger Button
  // unmounts as the broadcast leaves its cancellable status. finalFocus reads it
  // to SKIP the about-to-unmount trigger; see resolve-dialog-final-focus. No
  // reset needed: those paths unmount this wrapper, so the ref is discarded.
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  // A transient failure, said inside the open dialog. `seq` makes a repeat a
  // new node (announced again) — this runs inside the shared dialog's
  // transition, so the clear below never commits on its own.
  const [refusal, setRefusal] = useState<{ message: string; field: null; seq: number } | null>(null);
  const refuse = (): void =>
    setRefusal((prev) => ({ message: tToast('cancelError'), field: null, seq: (prev?.seq ?? 0) + 1 }));

  async function onConfirm(reason: string): Promise<void> {
    setRefusal(null);
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
        closedViaSuccessRef.current = true;
        onOpenChange(false);
        toast.success(tToast(successToastKey));
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      if (res.status === 409) {
        closedViaSuccessRef.current = true;
        onOpenChange(false);
        // F119 T081 — `sending_started` from `sending` onward; the legacy
        // code still answers for a closed E-Blast that never started sending.
        if (json.error?.code === 'sending_started' || json.error?.code === 'broadcast_cancel_too_late') {
          toast.error(tToast('cancelTooLate'));
        } else if (json.error?.code === 'broadcast_concurrent_action_blocked') {
          toast.error(tToast('concurrentRace'));
        } else {
          toast.error(tToast('cancelError'));
        }
        router.refresh();
      } else if (res.status === 404 || res.status === 403) {
        // Permanent: the broadcast is gone (404 — incl. a cross-member /
        // concurrently-deleted broadcast) or not permitted (403). Retrying is
        // futile, so close + refresh to update the stale view instead of
        // leaving the dialog open over a doomed request.
        closedViaSuccessRef.current = true;
        onOpenChange(false);
        toast.error(tToast('cancelError'));
        router.refresh();
      } else if (isReadOnlyRefusal(res.status, json)) {
        // The write freeze: the broadcast is untouched. Keep the dialog open —
        // the typed confirmation is still valid once the freeze lifts.
        readOnlyToast();
      } else {
        // Transient (5xx / unexpected): keep the dialog open for retry.
        refuse();
      }
    } catch {
      // Network throw: keep the dialog open for retry.
      refuse();
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
      // U35 — a cancelled E-Blast cannot be re-sent, so confirm waits for its
      // typed subject (ux-standards § 6.3), on the member AND staff surface.
      typedPhrase={subject}
      refusal={refusal}
    />
  );
}
