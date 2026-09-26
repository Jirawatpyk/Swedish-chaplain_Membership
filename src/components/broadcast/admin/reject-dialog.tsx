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
 *   - success → toast 'rejected' + close + refresh.
 *   - 409 split by body.error.code (F119 round-2 finding 4), each closing
 *     FIRST and toasting after, so the toast is not born under the modal's
 *     aria-hidden outside:
 *       'sending_started' (T081 widened reject into stages where the send may
 *       have begun)                  → 'rejectTooLate' — too late, not a race
 *       anything else                → 'concurrentRace'
 *     The route maps `RejectBroadcastError` only, which has no
 *     `broadcast_cancel_too_late` arm, so that code is not read here.
 *   - 429 (the 30 / 60 s staff write bucket) and 5xx / network throw keep the
 *     dialog open for a retry, reason intact, and say so INSIDE it (the shared
 *     dialog's `refusal`, `role="alert"`, focused — ux-standards § 6.4): a
 *     toast would render behind the modal.
 *   - 503 READ_ONLY_MODE (#400 item 7) keeps it open too, with main #390's
 *     read-only warning (title AND "nothing was changed", warning tone) in
 *     place of the generic error.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
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
  // The staff write bucket's refusal — the same copy the approval-round
  // actions read for the same 429 (`broadcast_rate_limit_exceeded`).
  const tApprovalErrors = useTranslations('admin.broadcasts.approval.errors');
  // #400 item 7 — main #390's read-only warning, word for word (root `errors`).
  const tReadOnly = useTranslations('errors');
  const router = useRouter();
  // F7-A11Y-1 — raised on the success / 409 close (both run router.refresh() →
  // the ReviewActions trigger Button unmounts). finalFocus reads it to SKIP the
  // about-to-unmount trigger; see resolve-dialog-final-focus. No reset needed:
  // the success path unmounts this wrapper, so the ref is discarded.
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(
    triggerRef,
    fallbackFocusRef,
    closedViaSuccessRef,
  );

  // A retryable failure, said inside the open dialog. `seq` makes a repeat a
  // new node (announced again) — this runs inside the shared dialog's
  // transition, so the clear below never commits on its own.
  const [refusal, setRefusal] = useState<{
    message: string;
    field: null;
    seq: number;
    tone?: 'warning';
    description?: string;
  } | null>(null);
  const refuse = (message: string, warning?: { readonly description: string }): void =>
    setRefusal((prev) => ({
      message,
      field: null,
      seq: (prev?.seq ?? 0) + 1,
      ...(warning !== undefined && { tone: 'warning' as const, description: warning.description }),
    }));

  async function onConfirm(reason: string): Promise<void> {
    setRefusal(null);
    try {
      const res = await fetch(`/api/admin/broadcasts/${broadcastId}/reject`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason: reason }),
      });
      if (res.ok) {
        closedViaSuccessRef.current = true;
        toast.success(tToast('rejected'));
        onOpenChange(false);
        router.refresh();
      } else if (res.status === 409) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        closedViaSuccessRef.current = true;
        onOpenChange(false);
        toast.error(
          json.error?.code === 'sending_started'
            ? tToast('rejectTooLate')
            : tToast('concurrentRace'),
        );
        router.refresh();
      } else if (await isReadOnlyResponse(res)) {
        refuse(tReadOnly('readOnlyMode'), { description: tReadOnly('readOnlyNothingChanged') });
      } else if (res.status === 429) {
        refuse(tApprovalErrors('broadcast_rate_limit_exceeded'));
      } else {
        refuse(tToast('error'));
      }
    } catch {
      refuse(tToast('error'));
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
      refusal={refusal}
    />
  );
}

// Default-export helper to allow Button-as-trigger composition by parent
export { RejectDialog as default };
