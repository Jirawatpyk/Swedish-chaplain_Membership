'use client';

/**
 * Task 3 (2026-08-02-broadcast-review-queue-pr3) — send-safety confirmation
 * gate in front of the irreversible bulk-approve fan-out. Wired into
 * `queue-bulk-action-bar.tsx` at Task 4: the "Approve selected" button opens
 * this dialog instead of firing the fan-out directly.
 *
 * Mirrors `approve-dialog.tsx`'s AlertDialog + RadioGroup structure (same
 * send-now/schedule choice + irreversible warning), with three deliberate
 * differences:
 *
 *   - Uses the SHARED `bangkok-datetime.ts` helper (`bangkokInputToIso` /
 *     `bangkokMinInputAfterMinutes`) instead of re-copying
 *     `approve-dialog.tsx`'s inline `bangkokInputToInstant` /
 *     `minLocalDateTime` duplicate — see the PR3 plan's "reuse, don't
 *     re-copy" constraint.
 *   - Folds the >5min lead-time check into the SAME predicate
 *     (`scheduleValid`) that disables the confirm button. `approve-dialog.tsx`
 *     only disables on `scheduledFor === ''`; a too-soon-but-non-empty
 *     schedule stays clickable there and is only rejected inside the click
 *     handler. Here the button itself stays disabled until the schedule is
 *     both present AND past the 5-minute floor. `handleConfirm` ALSO
 *     re-validates the lead time fresh at click time (not the cached
 *     `leadTimeOk`), so a button left visually-enabled while the admin
 *     hesitated across the 5-minute boundary still cannot submit.
 *   - Shows a resolved Bangkok wall-time preview under the schedule field
 *     (`schedulePreviewLabel`, parity with `approve-dialog.tsx:267-298`) —
 *     the bulk gate has a larger blast radius, so the admin should see the
 *     RESOLVED send time, not just the raw text they typed, before
 *     confirming an irreversible schedule.
 *
 * The recipient total is DISPLAY-ONLY: this component never fetches — it
 * only calls `props.onConfirm(decision)`. `BulkApproveDecision` structurally
 * carries `type` + (for schedule) `scheduledFor`, nothing else, so the
 * caller's request body built from `decision` cannot include
 * `totalRecipients` even by accident (tamper-safety, verified end-to-end by
 * Task 4's fan-out test).
 */
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  bangkokInputToIso,
  bangkokMinInputAfterMinutes,
} from '@/components/broadcast/bangkok-datetime';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { getDateFormatLocale } from '@/lib/format-date-localised';

const MIN_LEAD_MS = 5 * 60 * 1000;

export type BulkApproveDecision =
  | { readonly type: 'send_now' }
  | { readonly type: 'schedule'; readonly scheduledFor: string }; // ISO-8601 instant

export interface BulkApproveConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** Capped count actually actioned — min(selectedCount, cap). */
  readonly broadcastCount: number;
  /** Raw selection count, for the over-cap note. */
  readonly selectedCount: number;
  readonly cap: number;
  readonly totalRecipients: number;
  readonly onConfirm: (decision: BulkApproveDecision) => void;
  /**
   * Ref to the "Approve selected" trigger button so focus returns to it on
   * Cancel/ESC. On confirm, the trigger unmounts (the bulk bar clears when
   * the selection empties on success) — see `closedViaSuccessRef` below.
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function BulkApproveConfirmDialog(
  props: BulkApproveConfirmDialogProps,
): React.JSX.Element {
  const t = useTranslations('admin.broadcasts.queue.bulk.confirm');
  const locale = useLocale();
  const [decision, setDecision] = useState<'send_now' | 'schedule'>('send_now');
  const [scheduledInput, setScheduledInput] = useState('');
  // Whether the CURRENTLY TYPED schedule clears the >5min lead-time floor.
  // Recomputed in the onChange/onValueChange handlers below (never during
  // render) — `Date.now()` is an impure call and React's
  // components-and-hooks-must-be-pure rule forbids calling it directly in
  // the render body. `approve-dialog.tsx` sidesteps this by deferring the
  // WHOLE lead-time check to click-time, which is exactly the gap this
  // component fixes (its Confirm button stays clickable with a too-soon
  // time); recomputing on every keystroke keeps `disabled` live instead.
  const [leadTimeOk, setLeadTimeOk] = useState(false);

  // Reset on OPEN (not close) so a re-open is always fresh regardless of how
  // the previous interaction closed — mirrors reason-confirmation-dialog.tsx's
  // fix for the "stale state on programmatic close" class of bug: the
  // confirm path below calls `props.onOpenChange(false)` directly rather
  // than through a local wrapper, so resetting on close would miss it.
  // Render-time "adjust state when a prop changes" pattern avoids the
  // react-hooks/set-state-in-effect cascade rule.
  const [prevOpen, setPrevOpen] = useState(props.open);
  if (props.open !== prevOpen) {
    setPrevOpen(props.open);
    if (props.open) {
      setDecision('send_now');
      setScheduledInput('');
      setLeadTimeOk(false);
    }
  }

  // Cheap (a few LocalDateTime field reads) — recomputed every render so the
  // floor keeps creeping forward while the dialog stays open, rather than
  // freezing at the value from the render that first opened it.
  const minInput = bangkokMinInputAfterMinutes(6);

  // Pure — `bangkokInputToIso` only parses/re-zones the given string, it never
  // reads the clock, so recomputing this every render does not trip the
  // components-and-hooks-must-be-pure rule (unlike `isFarEnoughAhead` below,
  // which reads `Date.now()` and must stay confined to event handlers).
  // Reused for both the schedule preview and the `scheduledFor` payload.
  const scheduledIso =
    decision === 'schedule' ? bangkokInputToIso(scheduledInput) : null;

  function isFarEnoughAhead(iso: string | null): boolean {
    return iso !== null && Date.parse(iso) > Date.now() + MIN_LEAD_MS;
  }

  const scheduleValid = decision === 'send_now' || leadTimeOk;

  // Resolved Bangkok wall-time preview shown under the schedule field once a
  // parseable time is entered (Fix round 1 — parity with
  // `approve-dialog.tsx:267-298`'s preview, but for the bulk gate's larger
  // blast radius: the admin should see the RESOLVED send time, not just the
  // raw text they typed, before confirming an irreversible schedule).
  const schedulePreview =
    scheduledIso !== null
      ? new Intl.DateTimeFormat(getDateFormatLocale(locale), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Bangkok',
        }).format(new Date(scheduledIso))
      : null;

  // F7-A11Y-1 — the "Approve selected" trigger unmounts once the bulk bar
  // clears on a successful approve, so closedViaSuccessRef makes the
  // resolver skip the about-to-unmount trigger and land on #main-content
  // instead. WCAG 2.1 AA SC 2.4.3.
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(
    props.triggerRef,
    undefined,
    closedViaSuccessRef,
  );

  function handleConfirm(): void {
    // Re-validate at click time (rather than trusting the cached
    // `leadTimeOk`) — a send-safety gate must not let a schedule that
    // drifted below the 5-minute floor while the admin hesitated slip
    // through on a stale check. `scheduledIso` itself is pure/current (it
    // only re-parses `scheduledInput`, unaffected by elapsed time); only
    // `isFarEnoughAhead`'s internal `Date.now()` needs a fresh call here.
    if (decision === 'schedule' && !isFarEnoughAhead(scheduledIso)) return;
    closedViaSuccessRef.current = true;
    props.onConfirm(
      decision === 'send_now'
        ? { type: 'send_now' }
        : { type: 'schedule', scheduledFor: scheduledIso! },
    );
    props.onOpenChange(false);
  }

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent className="max-w-lg" finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { count: props.broadcastCount })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('recipientTotal', {
              recipients: props.totalRecipients,
              count: props.broadcastCount,
            })}
            {props.selectedCount > props.cap ? (
              <span className="mt-2 block text-destructive">
                {t('overCapNote', { max: props.cap, selected: props.selectedCount })}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <RadioGroup
            value={decision}
            onValueChange={(v) => {
              const next = v === 'schedule' ? 'schedule' : 'send_now';
              setDecision(next);
              setLeadTimeOk(
                next === 'schedule'
                  ? isFarEnoughAhead(bangkokInputToIso(scheduledInput))
                  : false,
              );
            }}
            aria-label={t('decisionLabel')}
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem
                id="bulk-approve-send-now"
                value="send_now"
                aria-label={t('sendNow')}
              />
              <Label htmlFor="bulk-approve-send-now" className="cursor-pointer">
                {t('sendNow')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem
                id="bulk-approve-schedule"
                value="schedule"
                aria-label={t('schedule')}
              />
              <Label htmlFor="bulk-approve-schedule" className="cursor-pointer">
                {t('schedule')}
              </Label>
            </div>
          </RadioGroup>

          {decision === 'send_now' ? (
            <p className="text-sm text-destructive">{t('sendNowWarning')}</p>
          ) : (
            <div className="ml-6 space-y-2">
              <Label htmlFor="bulk-approve-scheduled-for">{t('scheduleLabel')}</Label>
              <Input
                id="bulk-approve-scheduled-for"
                type="datetime-local"
                value={scheduledInput}
                min={minInput}
                onChange={(e) => {
                  const next = e.target.value;
                  setScheduledInput(next);
                  setLeadTimeOk(isFarEnoughAhead(bangkokInputToIso(next)));
                }}
                aria-describedby="bulk-approve-scheduled-for-help"
              />
              {schedulePreview !== null ? (
                <p className="text-sm text-muted-foreground">
                  {t('schedulePreviewLabel')} <span>{schedulePreview}</span>
                </p>
              ) : null}
              <p
                id="bulk-approve-scheduled-for-help"
                className="text-xs text-muted-foreground"
              >
                {t('scheduleHelp')}
              </p>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!scheduleValid}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
          >
            {decision === 'send_now' ? t('confirmSendNow') : t('confirmSchedule')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
