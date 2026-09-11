'use client';

/**
 * F114 — the review page's interactive half (US2 AS1–AS9; FR-014–FR-018,
 * FR-020; T055 / T056): owns the per-field selection, the confirming dialog
 * and the `POST …/decide` call.
 *
 * The confirming action uses the shell `ConfirmationDialog` with the reason
 * + note fields as its body: title / description / confirm label are derived
 * from the selection (ICU plurals — "Approve all N", "Approve A, reject R",
 * "Reject all N"), `destructive` and `reasonRequired` iff any field is
 * rejected, initial focus on the REQUIRED reason when a field is rejected
 * (review round 1 UX I3) and on Cancel otherwise, the confirm button disabled while the
 * reason is missing / over the cap, both buttons disabled while in flight
 * (the dialog stays open until the response), `finalFocus` back to the
 * confirm trigger. Concurrency answers (`already_decided`, `not_pending`,
 * `member_archived`, `member_erasing`) are shown as user-facing copy and the
 * page is re-fetched; success navigates to the member record.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/shell/reason-confirmation-dialog';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';
import { DECISION_NOTE_MAX_LENGTH, DECISION_REASON_MAX_LENGTH } from '@/modules/members/domain/change-request/change-request';
import { ChangeRequestDecisionTable } from './change-request-decision-table';

export interface ChangeRequestReviewClientProps {
  readonly request: StaffChangeRequestView;
  readonly fields: readonly ChangeRequestReviewFieldView[];
  readonly canDecide: boolean;
}

type DecideProblem = { readonly type?: string; readonly keys?: string[] };

function problemKind(body: unknown): string {
  const type = (body as DecideProblem | null)?.type;
  if (typeof type !== 'string') return 'error';
  return type.slice(type.lastIndexOf('/') + 1);
}

export function ChangeRequestReviewClient({ request, fields, canDecide }: ChangeRequestReviewClientProps) {
  const t = useTranslations('admin.changeRequests.decision');
  const router = useRouter();
  const decided = request.state !== 'pending';

  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.undecidable === null])),
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  // Raised before every close that `router.refresh()`es the trigger away
  // (success, 409, contact_removed) so focus lands on the #main-content
  // landmark instead of <body> (review: UX I6).
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  // Shown INSIDE the dialog while it stays open: a toast is portalled outside
  // the modal's focus trap and is aria-hidden to assistive tech (review: UX I1).
  const [dialogError, setDialogError] = useState<string | null>(null);
  // The alert region is ALWAYS mounted (round 2, a11y): a `role="alert"`
  // that mounts together with its text is announced inconsistently across
  // screen readers, while text inserted into a live region that already
  // exists is announced reliably. The bounded, scrollable dialog body may
  // have the error above the fold — scroll it into view when it appears.
  const dialogErrorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (dialogError) dialogErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [dialogError]);

  const counts = useMemo(() => {
    const approved = fields.filter((f) => selected[f.key] === true).length;
    return { approved, rejected: fields.length - approved, total: fields.length };
  }, [fields, selected]);
  const reasonRequired = counts.rejected > 0;
  const reasonTrimmed = reason.trim();
  const reasonOverCap = reason.length > DECISION_REASON_MAX_LENGTH;
  const noteOverCap = note.length > DECISION_NOTE_MAX_LENGTH;
  const confirmDisabled = (reasonRequired && reasonTrimmed.length === 0) || reasonOverCap || noteOverCap;

  const title =
    counts.rejected === 0
      ? t('titleApproveAll', { count: counts.total })
      : counts.approved === 0
        ? t('titleRejectAll', { count: counts.total })
        : t('titleMixed', { approved: counts.approved, rejected: counts.rejected });
  const confirmLabel =
    counts.rejected === 0
      ? t('confirmApproveAll')
      : counts.approved === 0
        ? t('confirmRejectAll')
        : t('confirmMixed', { approved: counts.approved, rejected: counts.rejected });

  async function onConfirm(): Promise<void> {
    const body = {
      decisions: fields.map((f) => ({ key: f.key, outcome: selected[f.key] === true ? 'approved' : 'rejected' })),
      reason: reasonTrimmed.length > 0 ? reasonTrimmed : null,
      note: note.trim().length > 0 ? note.trim() : null,
    };
    setDialogError(null);
    let res: Response;
    try {
      res = await fetch(`/api/admin/change-requests/${request.id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setDialogError(t('toast.error'));
      return;
    }
    if (res.ok) {
      const data = (await res.json()) as { repeated: boolean; request: StaffChangeRequestView };
      const outcome = data.request.outcome ?? 'approved';
      toast.success(data.repeated ? t('toast.repeated') : t(`toast.${outcome}`));
      closedViaSuccessRef.current = true;
      setOpen(false);
      router.push(`/admin/members/${request.memberId}`);
      router.refresh();
      return;
    }
    const problem: unknown = await res.json().catch(() => null);
    const kind = problemKind(problem);
    if (res.status === 409) {
      toast.error(t(`toast.${kind === 'already_decided' || kind === 'not_pending' || kind === 'member_archived' || kind === 'member_erasing' ? kind : 'error'}`));
      closedViaSuccessRef.current = true;
      setOpen(false);
      router.refresh();
      return;
    }
    if (res.status === 422 && kind === 'contact_removed') {
      toast.error(t('toast.contact_removed'));
      const keys = (problem as DecideProblem).keys ?? [];
      setSelected((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, false])) }));
      closedViaSuccessRef.current = true;
      setOpen(false);
      router.refresh();
      return;
    }
    // every arm that keeps the dialog open announces INSIDE it
    setDialogError(t(`toast.${kind === 'validation_error' || kind === 'reason_required' ? kind : 'error'}`));
  }

  return (
    <div className="space-y-4">
      <ChangeRequestDecisionTable
        fields={fields}
        selected={selected}
        onToggle={(key, approved) => setSelected((prev) => ({ ...prev, [key]: approved }))}
        canDecide={canDecide && !decided}
        decided={decided}
      />
      {canDecide && !decided ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="selection-summary">
            {t('selectionSummary', { approved: counts.approved, rejected: counts.rejected })}
          </p>
          <Button ref={triggerRef} type="button" className="h-9" onClick={() => setOpen(true)} data-testid="confirm-decision">
            {t('confirm')}
          </Button>
        </div>
      ) : null}
      <ConfirmationDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setReason('');
            setNote('');
            setDialogError(null);
            closedViaSuccessRef.current = false;
          }
        }}
        title={title}
        description={reasonRequired ? t('descriptionReject') : t('descriptionApprove')}
        confirmLabel={confirmLabel}
        cancelLabel={t('cancel')}
        destructive={reasonRequired}
        confirmDisabled={confirmDisabled}
        closeOnConfirm={false}
        onConfirm={onConfirm}
        finalFocus={finalFocus}
        {...(reasonRequired ? { initialFocusRef: reasonRef } : {})}
      >
        <div className="space-y-4">
          <div ref={dialogErrorRef} role="alert" aria-atomic="true" data-testid="decision-error-region">
            {dialogError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive-surface px-3 py-2 text-sm text-destructive" data-testid="decision-error">
                {dialogError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="decision-reason">
              {t('reasonLabel')}
              {reasonRequired ? <span aria-hidden="true"> *</span> : null}
            </Label>
            <Textarea
              id="decision-reason"
              ref={reasonRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              rows={4}
              required={reasonRequired}
              aria-required={reasonRequired}
              aria-describedby="decision-reason-help decision-reason-counter"
              aria-invalid={reasonOverCap || (reasonRequired && reasonTrimmed.length === 0 && reason.length > 0)}
              data-testid="decision-reason"
            />
            <p id="decision-reason-help" className="text-xs text-muted-foreground">
              {reasonRequired ? t('reasonHelpRequired') : t('reasonHelpOptional')}
            </p>
            <p id="decision-reason-counter" aria-live="polite" className={reasonOverCap ? 'text-xs font-semibold text-destructive' : 'text-xs text-muted-foreground'}>
              {reason.length} / {DECISION_REASON_MAX_LENGTH}
            </p>
            {reasonOverCap ? (
              <p className="text-xs text-destructive" role="alert">
                {t('errors.tooLong', { max: DECISION_REASON_MAX_LENGTH })}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="decision-note">{t('noteLabel')}</Label>
            <Textarea
              id="decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              aria-describedby="decision-note-help"
              aria-invalid={noteOverCap}
              data-testid="decision-note"
            />
            <p id="decision-note-help" className="text-xs text-muted-foreground">
              {t('noteHelp', { max: DECISION_NOTE_MAX_LENGTH })}
            </p>
            {noteOverCap ? (
              <p className="text-xs text-destructive" role="alert">
                {t('errors.tooLong', { max: DECISION_NOTE_MAX_LENGTH })}
              </p>
            ) : null}
          </div>
        </div>
      </ConfirmationDialog>
    </div>
  );
}
