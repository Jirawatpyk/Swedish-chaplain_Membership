'use client';

/**
 * Approve dialog (T118 helper). Variants:
 *   - send_now: confirms immediate dispatch (cron picks up within 60s)
 *   - schedule: collects datetime-local with min=now+5min defence
 *
 * Calls POST /api/admin/broadcasts/[id]/approve.
 *
 * T166 follow-up — a 409 is not always a race. `member_halted` /
 * `member_not_in_good_standing` (the send-time standing re-check) leave the row
 * `submitted` and its trigger mounted: the dialog stays open and names the
 * reason inside itself (`InlineError`, role=alert — a toast behind this modal
 * would be aria-hidden, ux-standards § 6.4). Every other 409 keeps the
 * concurrentRace close + refresh.
 *
 * #400 item 7 — a 503 from the READ_ONLY_MODE write freeze is the same kind of
 * refusal: nothing moved, so the dialog stays open and says so inside itself
 * with main #390's warning (title AND "nothing was changed", warning tone,
 * focused), never the generic toast under the modal. The pattern of the F119
 * `schedule-confirm-dialog.tsx` (`FormRefusal`, `isReadOnlyResponse`,
 * `InlineWarning`).
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button, Dialog, RadioGroup, TextField } from '@jirawatpyk/aura-react';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import {
  bangkokInputToIso,
  bangkokMinInputAfterMinutes,
} from '@/components/broadcast/bangkok-datetime';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { cancelApprovedBroadcasts } from '@/components/broadcast/admin/send-now-undo';
import { readErrorCode, STANDING_REFUSAL_CODES } from '@/components/broadcast/approval/approval-error';
import { InlineError } from '@/components/broadcast/approval/inline-error';
import { InlineWarning } from '@/components/broadcast/approval/inline-warning';
import { useFocusRefusal } from '@/components/broadcast/approval/use-focus-refusal';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';

const MIN_LEAD_MS = 5 * 60 * 1000;
const FORM_ERROR_ID = 'approve-dialog-error';

/** A refusal that keeps the dialog open: a named reason, or the write freeze. */
type FormRefusal = { readonly kind: 'error'; readonly message: string } | { readonly kind: 'read_only' };

/**
 * Code-review TZ fix — `<input type="datetime-local">` returns a naive
 * local string ("2026-05-04T14:00") with no offset. The new
 * scheduleHelp microcopy + preview formatter both claim the input is
 * Asia/Bangkok wall-time, so we must parse it as Bangkok-zoned, not
 * the browser's local zone (which is what `new Date(localString)`
 * does). Mismatch would let an admin in UTC type "14:00 Bangkok" but
 * the system would dispatch at 21:00 Bangkok — UX claim broken.
 *
 * Delegates to the shared `Intl`-based `bangkokInputToIso` (no js-joda in
 * this client bundle). Throws on empty / unparseable input — every caller
 * wraps it in try/catch.
 */
function bangkokInputToInstant(scheduledFor: string): Date {
  const iso = bangkokInputToIso(scheduledFor);
  if (iso === null) {
    throw new RangeError(`Invalid Bangkok wall-time: "${scheduledFor}"`);
  }
  return new Date(iso);
}

function minLocalDateTime(): string {
  // `min=` attribute on `<input type="datetime-local">` is interpreted
  // by the browser in its OWN local zone — the spec doesn't allow
  // overriding. We compute "5 minutes from now" in Bangkok wall-time
  // (the contract advertised in microcopy) and serialise. A non-
  // Bangkok admin's browser may still allow earlier selections within
  // its local +X-hour window; the server-side use-case enforces the
  // hard 5-minute minimum so the client min is best-effort.
  return bangkokMinInputAfterMinutes(6);
}

export interface ApproveDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /**
   * F7-A11Y-1 — ref to the Approve trigger button so focus returns to it
   * on close (Cancel / ESC / validation paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * F7-A11Y-1 — optional fallback focus target when the trigger has been
   * unmounted (the success path unmounts ReviewActions). Defaults to the
   * layout's #main-content landmark when omitted.
   */
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Task 6 (2026-08-01-broadcast-review-queue-pr1) — estimated recipient
   * count from `EnrichedQueueRow`, threaded via `ReviewActions` so the
   * admin sees who a broadcast reaches before approving. Undefined
   * omits the line entirely (e.g. call sites that don't yet have it).
   */
  readonly recipientCount?: number;
}

export function ApproveDialog({
  broadcastId,
  open,
  onOpenChange,
  triggerRef,
  fallbackFocusRef,
  recipientCount,
}: ApproveDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approveDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  // Task 5 (2026-08-02-broadcast-review-queue-pr3) — same 60s send-now Undo
  // toast as the bulk bar, reusing its i18n namespace verbatim.
  const tUndo = useTranslations('admin.broadcasts.queue.bulk.undo');
  // #400 item 7 — main #390's read-only warning, word for word (root `errors`).
  const tReadOnly = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const [decision, setDecision] = useState<'send_now' | 'schedule'>('send_now');
  const [scheduledFor, setScheduledFor] = useState<string>('');
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<FormRefusal | null>(null);
  useFocusRefusal(formError, FORM_ERROR_ID);
  const minLocal = useMemo(() => minLocalDateTime(), []);
  // F7-A11Y-1 — raised on the success / 409 close (both run router.refresh() →
  // the ReviewActions trigger Button unmounts). finalFocus reads it to SKIP the
  // about-to-unmount trigger; see resolve-dialog-final-focus. No reset needed:
  // the success path unmounts this dialog's owner, so the ref is discarded.
  const closedViaSuccessRef = useRef<boolean>(false);

  // Reset state via onOpenChange wrapper (avoids setState-in-effect
  // cascade warning under React 19 strict mode).
  function handleOpenChange(next: boolean): void {
    if (!next) {
      setDecision('send_now');
      setScheduledFor('');
      setFormError(null);
    }
    onOpenChange(next);
  }

  // Compute validity on demand inside the click handler — avoids
  // calling `Date.now()` during render (React 19 strict-mode rule).
  // Parses `scheduledFor` as Bangkok wall-time (matches scheduleHelp
  // microcopy contract); compares against current epoch so MIN_LEAD_MS
  // works regardless of admin browser TZ.
  function isScheduleValid(): boolean {
    if (decision === 'send_now') return true;
    if (scheduledFor === '') return false;
    try {
      return (
        bangkokInputToInstant(scheduledFor).getTime() >
        Date.now() + MIN_LEAD_MS
      );
    } catch {
      return false;
    }
  }
  const submitDisabled =
    pending || (decision === 'schedule' && scheduledFor === '');

  function onConfirm() {
    if (!isScheduleValid() || pending) return;
    // Cleared first, so a repeated refusal mounts a NEW alert and is announced.
    setFormError(null);
    startTransition(async () => {
      try {
        const body =
          decision === 'send_now'
            ? { decision: 'send_now' as const }
            : {
                decision: 'schedule' as const,
                // Parse as Bangkok wall-time (matches scheduleHelp
                // microcopy + preview formatter). Pre-fix used
                // `new Date(scheduledFor)` which interprets the
                // datetime-local string in browser-local TZ, drifting
                // dispatch by the admin's UTC offset.
                scheduledFor: bangkokInputToInstant(scheduledFor).toISOString(),
              };
        const res = await fetch(
          `/api/admin/broadcasts/${broadcastId}/approve`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (res.ok) {
          closedViaSuccessRef.current = true;
          toast.success(tToast('approved'));
          // Task 5 (2026-08-02-broadcast-review-queue-pr3) — 60s send-now
          // "Undo", shown IN ADDITION to the toast above. ONLY for
          // send_now: a scheduled broadcast hasn't been dispatched at all
          // yet, so it's already cancellable via the normal per-row
          // action — Undo is specifically the "oops, sent now" escape for
          // the ≤60s window before the dispatch cron picks it up.
          if (decision === 'send_now') {
            toast(tUndo('sendingSendNow', { count: 1 }), {
              duration: 60_000,
              action: {
                label: tUndo('action'),
                onClick: async () => {
                  const r = await cancelApprovedBroadcasts(
                    [broadcastId],
                    tUndo('reason'),
                  );
                  if (r.cancelled > 0) {
                    toast.success(tUndo('success', { count: r.cancelled }));
                  }
                  if (r.tooLate > 0) {
                    toast.warning(tUndo('tooLate', { count: r.tooLate }));
                  }
                  if (r.failed > 0) {
                    toast.error(tUndo('failed', { count: r.failed }));
                  }
                  if (r.rateLimited > 0) {
                    toast.error(tUndo('rateLimited', { count: r.rateLimited }));
                  }
                  router.refresh();
                },
              },
            });
          }
          onOpenChange(false);
          router.refresh();
        } else if (await isReadOnlyResponse(res)) {
          // Nothing moved and the trigger survives: stay open, say it here.
          setFormError({ kind: 'read_only' });
        } else if (res.status === 409) {
          const code = await readErrorCode(res);
          const message = code !== null && tToast.has(code) ? tToast(code) : tToast('concurrentRace');
          if (code !== null && STANDING_REFUSAL_CODES.has(code)) {
            // The row did not move and the trigger survives: stay open, say
            // why here, and leave closedViaSuccessRef down so Cancel returns
            // focus to the trigger.
            setFormError({ kind: 'error', message });
            return;
          }
          closedViaSuccessRef.current = true;
          toast.error(message);
          onOpenChange(false);
          router.refresh();
        } else {
          toast.error(tToast('error'));
        }
      } catch {
        toast.error(tToast('error'));
      }
    });
  }

  // F7-A11Y-1 — focus return on close, via the shared useDialogFinalFocus chain
  // (same resolver as reject/cancel). The Approve trigger Button lives in
  // <ReviewActions>, which UNMOUNTS after a successful approve (router.refresh
  // flips the row out of 'submitted'), so the naive trigger-return would drop
  // focus to <body>. closedViaSuccessRef makes the resolver SKIP the
  // about-to-unmount trigger on the success/409 close and land on
  // fallbackFocusRef → the layout's #main-content landmark (focusable via
  // tabIndex=-1). WCAG 2.1 AA SC 2.4.3.
  const finalFocus = useDialogFinalFocus(
    triggerRef,
    fallbackFocusRef,
    closedViaSuccessRef,
  );

  // Board `Admin-broadcast-approve` (spec 122 US12b) — AURA `Dialog
  // role="alertdialog"`: the decision an AURA `RadioGroup`, the schedule an
  // AURA `TextField` (`datetime-local`, Bangkok wall time as before).
  const preview =
    scheduledFor === ''
      ? null
      : (() => {
          try {
            // Parse as Bangkok wall-time then render in Bangkok TZ — the
            // round-trip is identity, so the preview matches what the admin
            // typed regardless of browser TZ.
            return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
              dateStyle: 'long',
              timeStyle: 'short',
              timeZone: 'Asia/Bangkok',
            }).format(bangkokInputToInstant(scheduledFor));
          } catch {
            return '';
          }
        })();

  return (
    <Dialog
      role="alertdialog"
      open={open}
      dismissible={!pending}
      onClose={() => handleOpenChange(false)}
      finalFocus={() => finalFocus() || null}
      title={t('title')}
      description={
        <>
          {t('description')}
          {/* a11y M1 — the recipient line is part of the announced
              description, not a sibling the dialog's describedby misses. */}
          {recipientCount !== undefined ? (
            <span className="mt-[var(--aura-space-2)] block font-medium text-[var(--aura-fg-primary)]">
              {t('recipientCount', { count: recipientCount })}
            </span>
          ) : null}
        </>
      }
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={() => handleOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            icon="circle-check"
            disabled={submitDisabled}
            loading={pending}
            onClick={onConfirm}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <RadioGroup
          touchHeight
          label={t('decisionLabel')}
          value={decision}
          onChange={(v) => setDecision(v === 'schedule' ? 'schedule' : 'send_now')}
          disabled={pending}
          options={[
            { value: 'send_now', label: t('decision.sendNow') },
            { value: 'schedule', label: t('decision.schedule') },
          ]}
        />
        {decision === 'schedule' ? (
          <div className="flex flex-col gap-[var(--aura-space-2)]">
            <TextField
              id="approve-when"
              touchHeight
              type="datetime-local"
              label={t('scheduleLabel')}
              hint={t('scheduleHelp')}
              value={scheduledFor}
              min={minLocal}
              onChange={(e) => setScheduledFor(e.target.value)}
              disabled={pending}
            />
            {preview !== null ? (
              <p className="aura-text-body font-medium">
                {t('schedulePreviewLabel')} <span>{preview}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        {formError === null ? null : formError.kind === 'read_only' ? (
          <InlineWarning
            id={FORM_ERROR_ID}
            data-testid="approve-dialog-error"
            title={tReadOnly('readOnlyMode')}
            description={tReadOnly('readOnlyNothingChanged')}
          />
        ) : (
          <InlineError id={FORM_ERROR_ID} data-testid="approve-dialog-error" message={formError.message} />
        )}
      </div>
    </Dialog>
  );
}
