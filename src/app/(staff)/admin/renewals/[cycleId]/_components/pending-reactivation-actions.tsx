/**
 * 070 F8 item #18 — `PendingReactivationActions`.
 *
 * Admin approve / reject-with-refund actions for a cycle stuck in
 * `pending_admin_reactivation`. Renders NOTHING unless the cycle is in
 * that state (a cycle in any other status has no pending decision).
 *
 * Two actions, mirroring the dialog/fetch/toast/`router.refresh()` shape
 * of `at-risk/_components/outreach-dialog.tsx`:
 *
 *   1. **Approve** — a non-destructive confirmation `Dialog` → POST
 *      `/api/admin/renewals/[cycleId]/reactivate` → sonner toast → refresh.
 *   2. **Reject & refund** — a DESTRUCTIVE `AlertDialog` with a required
 *      reason `<Textarea>` (client-validated 1..500) + irreversible-refund
 *      copy → POST `/api/admin/renewals/[cycleId]/reject` → toast that
 *      distinguishes "refund issued" from "rejected, no payment to refund"
 *      via `refund_credit_note_id === null` → refresh.
 *
 * WCAG 2.1 AA: labelled textarea, focus-on-Cancel default (defensive for a
 * money action), submit disabled while pending or when the reason is
 * invalid, error codes surfaced as toasts.
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const REASON_MIN = 1;
const REASON_MAX = 500;

export interface PendingReactivationActionsProps {
  readonly cycleId: string;
  readonly status: string;
}

interface RejectSuccessBody {
  readonly refund_credit_note_id: string | null;
}

/** Read `error.code` off a non-2xx JSON body; falls back to server_error. */
async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? 'server_error';
  } catch {
    return 'server_error';
  }
}

export function PendingReactivationActions({
  cycleId,
  status,
}: PendingReactivationActionsProps) {
  const t = useTranslations(
    'admin.renewals.cycleDetail.pendingReactivation',
  );
  const router = useRouter();

  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reactivatePending, startReactivate] = useTransition();
  const [rejectPending, startReject] = useTransition();

  const reactivateCancelRef = useRef<HTMLButtonElement | null>(null);
  const rejectCancelRef = useRef<HTMLButtonElement | null>(null);

  // Render nothing for cycles that aren't awaiting an admin decision.
  if (status !== 'pending_admin_reactivation') {
    return null;
  }

  const trimmedReason = reason.trim();
  const reasonInvalid =
    trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX;

  const onReactivate = () => {
    startReactivate(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/reactivate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        );
        if (!res.ok) {
          toast.error(t('reactivate.errorToast'));
          return;
        }
        toast.success(t('reactivate.successToast'));
        setReactivateOpen(false);
        router.refresh();
      } catch {
        toast.error(t('reactivate.errorToast'));
      }
    });
  };

  const onReject = () => {
    if (reasonInvalid) return;
    startReject(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/reject`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: trimmedReason }),
          },
        );
        if (!res.ok) {
          const code = await readErrorCode(res);
          const key = `reject.error.${code}`;
          toast.error(
            t.has(key) ? t(key) : t('reject.error.server_error'),
          );
          return;
        }
        const body = (await res.json()) as RejectSuccessBody;
        toast.success(
          body.refund_credit_note_id === null
            ? t('reject.successNoRefundToast')
            : t('reject.successRefundedToast'),
        );
        setRejectOpen(false);
        setReason('');
        router.refresh();
      } catch {
        toast.error(t('reject.error.server_error'));
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* --- Approve (non-destructive confirmation) --- */}
      <Button onClick={() => setReactivateOpen(true)}>
        {t('reactivate.button')}
      </Button>
      <Dialog open={reactivateOpen} onOpenChange={setReactivateOpen}>
        <DialogContent initialFocus={reactivateCancelRef} role="alertdialog">
          <DialogHeader>
            <DialogTitle>{t('reactivate.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('reactivate.dialogBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={reactivateCancelRef}
              variant="outline"
              onClick={() => setReactivateOpen(false)}
              disabled={reactivatePending}
            >
              {t('reactivate.cancel')}
            </Button>
            <Button onClick={onReactivate} disabled={reactivatePending}>
              {reactivatePending ? (
                <>
                  <Loader2Icon
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  {t('reactivate.submitting')}
                </>
              ) : (
                t('reactivate.confirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Reject & refund (destructive) --- */}
      <Button variant="outline" onClick={() => setRejectOpen(true)}>
        {t('reject.button')}
      </Button>
      <AlertDialog
        open={rejectOpen}
        onOpenChange={(open) => {
          setRejectOpen(open);
          // Clear the reason on cancel/close so a reopened dialog never
          // pre-fills a stale justification onto the refund audit trail.
          if (!open) setReason('');
        }}
      >
        <AlertDialogContent initialFocus={rejectCancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('reject.dialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('reject.dialogBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">{t('reject.reasonLabel')}</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reject.reasonPlaceholder')}
              rows={3}
              maxLength={REASON_MAX}
              aria-invalid={reasonInvalid && reason.length > 0}
              aria-describedby="reject-reason-hint"
              required
            />
            <p
              id="reject-reason-hint"
              className={
                'text-xs ' +
                (reasonInvalid && reason.length > 0
                  ? 'text-destructive'
                  : 'text-muted-foreground')
              }
            >
              {t('reject.reasonRequired')}
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel ref={rejectCancelRef} disabled={rejectPending}>
              {t('reject.cancel')}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={onReject}
              disabled={rejectPending || reasonInvalid}
            >
              {rejectPending ? (
                <>
                  <Loader2Icon
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  {t('reject.submitting')}
                </>
              ) : (
                t('reject.confirm')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
