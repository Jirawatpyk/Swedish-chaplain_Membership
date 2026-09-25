'use client';

/**
 * F119 T064 (US1-AS5, FR-016, FR-017, FR-018) — marketing confirms, changes
 * or cancels the send time of a member-approved E-Blast.
 *
 * Calls `POST /api/admin/broadcasts/[id]/schedule` (`broadcasts.send`). The
 * modes offered are exactly the ones the route accepts from the stage the
 * page rendered — `keep_proposal` from `approved` and `cancel` from
 * `member_approved` answer 409 `mode_not_allowed`, so they are not shown:
 *
 *   member_approved → keep_proposal | schedule | send_now   (promotes the approved version)
 *   approved        → schedule | send_now | cancel          (changes the time, or takes it off the dispatchable stage)
 *
 * The member's proposal is PRE-SELECTED only while it is still at least five
 * minutes away — the route's floor (`broadcast_schedule_too_soon`). The check
 * runs when the dialog OPENS (never during render — `Date.now()` in render is
 * a React 19 purity error), so a proposal that passes while the page sits open
 * is not offered as the default. A proposal that has passed stays visible
 * (FR-016: shown to both sides throughout) with the keep option disabled, and
 * the time picker becomes required. Any other choice than the proposal is
 * called out, because the member is told the difference (FR-018).
 *
 * All wall-time is Bangkok (`bangkok-datetime.ts`), the contract every other
 * E-Blast schedule surface advertises. Focus returns to the trigger on close;
 * on success the page refreshes and the trigger may unmount, so the shared
 * resolver skips it and lands on `#main-content` (WCAG 2.4.3).
 *
 * UX review: a refusal that keeps the dialog open (a 422 other than too-soon,
 * a 429, a 5xx, a network failure) is said INSIDE it (`role="alert"`) — a
 * toast renders outside the modal, which hides everything outside itself from
 * AT (H1) — and the line is cleared at the start of every request so a repeat
 * is announced again. A too-soon refusal focuses the picker (M4). The
 * "differs" callout sits in a live region that is mounted from the start, so
 * its appearance is announced (M4). Submit is `focusableWhenDisabled`: it
 * turns unavailable while it holds focus (H2).
 *
 * The READ_ONLY_MODE write freeze (PR #392 review C1) is main #390's read-only
 * warning — its title AND "nothing was changed" — said INSIDE the dialog only,
 * in the warning tone (review D4/D5): the dialog stays open (the choice is
 * still valid once the freeze lifts), and a toast would sit behind the modal.
 * Every form-level refusal is focused when it lands (review D8, § 6.4).
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { CalendarClock, Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import {
  bangkokInputToIso,
  bangkokMinInputAfterMinutes,
  isoToBangkokInput,
} from '@/components/broadcast/bangkok-datetime';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { approvalErrorMessage, readErrorCode, STANDING_REFUSAL_CODES } from './approval-error';
import { InlineError } from './inline-error';
import { InlineWarning } from './inline-warning';
import { useFocusRefusal } from './use-focus-refusal';

/** The route's floor (`approve-broadcast.ts` / `confirm-schedule.ts`). */
const MIN_LEAD_MS = 5 * 60 * 1000;

const WHEN_ID = 'schedule-confirm-when';
const PROPOSAL_ID = 'schedule-confirm-proposal';
const FORM_ERROR_ID = 'schedule-confirm-error';

/** A form-level refusal on screen — a fresh object each time, so the focus hook refires. */
type FormRefusal = { readonly kind: 'error'; readonly message: string } | { readonly kind: 'read_only' };

export type ScheduleConfirmStatus = 'member_approved' | 'approved';
export type ScheduleConfirmMode = 'keep_proposal' | 'schedule' | 'send_now' | 'cancel';

/** The route's accepted modes per stage (contract § `POST …/schedule`). */
export const SCHEDULE_MODES_BY_STATUS: Readonly<Record<ScheduleConfirmStatus, readonly ScheduleConfirmMode[]>> = {
  member_approved: ['keep_proposal', 'schedule', 'send_now'],
  approved: ['schedule', 'send_now', 'cancel'],
};

export interface ScheduleConfirmActionProps {
  readonly broadcastId: string;
  readonly status: ScheduleConfirmStatus;
  /** The member's proposal (ISO), frozen after submit — or null. */
  readonly proposedSendAt: string | null;
  /** The currently confirmed time (ISO) — set once the E-Blast is Scheduled. */
  readonly scheduledFor: string | null;
}

function isAtLeastFiveMinutesAway(iso: string | null, now: number): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  return !Number.isNaN(at) && at >= now + MIN_LEAD_MS;
}

export function ScheduleConfirmAction({
  broadcastId,
  status,
  proposedSendAt,
  scheduledFor,
}: ScheduleConfirmActionProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approval.schedule');
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const tStatus = useTranslations('admin.broadcasts.queue.status');
  const locale = useLocale();
  const tReadOnly = useTranslations('errors');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ScheduleConfirmMode>('schedule');
  const [when, setWhen] = useState('');
  const [minWhen, setMinWhen] = useState('');
  const [proposalUsable, setProposalUsable] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormRefusal | null>(null);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef(false);
  const focusWhenRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  useFocusRefusal(formError, FORM_ERROR_ID);

  // M4 — a too-soon refusal makes the picker the answer: focus it once it is
  // mounted and no longer inside the `pending`-disabled fieldset.
  useEffect(() => {
    if (!focusWhenRef.current || pending) return;
    const when = document.getElementById(WHEN_ID);
    if (when === null) return;
    focusWhenRef.current = false;
    when.focus();
  }, [pending, fieldError, mode]);

  // The keep option exists only when there is a proposal to keep.
  const modes = SCHEDULE_MODES_BY_STATUS[status].filter((m) => m !== 'keep_proposal' || proposedSendAt !== null);
  const isChange = status === 'approved';

  const fmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  });
  const formatIso = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : fmt.format(d);
  };

  function handleOpen(): void {
    const now = Date.now();
    const usable = status === 'member_approved' && isAtLeastFiveMinutesAway(proposedSendAt, now);
    closedViaSuccessRef.current = false;
    setProposalUsable(usable);
    setMode(usable ? 'keep_proposal' : 'schedule');
    // Changing an already confirmed time starts from that time while it is
    // still valid; otherwise the picker starts empty and must be filled.
    setWhen(isChange && isAtLeastFiveMinutesAway(scheduledFor, now) ? isoToBangkokInput(scheduledFor) : '');
    setMinWhen(bangkokMinInputAfterMinutes(6));
    setFieldError(null);
    setFormError(null);
    focusWhenRef.current = false;
    setOpen(true);
  }

  const chosenIso = mode === 'schedule' ? bangkokInputToIso(when) : null;
  const differs =
    proposedSendAt !== null &&
    (mode === 'send_now' ||
      (mode === 'schedule' && chosenIso !== null && Date.parse(chosenIso) !== Date.parse(proposedSendAt)));

  const submitDisabled =
    pending ||
    (mode === 'schedule' && chosenIso === null) ||
    (mode === 'keep_proposal' && !proposalUsable);

  function onConfirm(): void {
    if (submitDisabled) return;
    if (mode === 'schedule' && (chosenIso === null || Date.parse(chosenIso) < Date.now() + MIN_LEAD_MS)) {
      focusWhenRef.current = true;
      setFieldError(t('tooSoon'));
      return;
    }
    const body = mode === 'schedule' ? { mode, scheduledFor: chosenIso } : { mode };
    // Cleared first, so a repeated refusal mounts a NEW alert and is announced.
    setFormError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcastId}/schedule`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          closedViaSuccessRef.current = true;
          toast.success(mode === 'cancel' ? t('cancelled') : t('confirmed'));
          setOpen(false);
          router.refresh();
          return;
        }
        if (await isReadOnlyResponse(res)) {
          setFormError({ kind: 'read_only' });
          return;
        }
        const code = await readErrorCode(res);
        const message = approvalErrorMessage(tErrors, code);
        if (res.status === 422 && code === 'broadcast_schedule_too_soon') {
          // The proposal (or the picked time) slipped under the floor while
          // the dialog was open: stay here, and make the picker the answer.
          focusWhenRef.current = true;
          setProposalUsable(false);
          setMode('schedule');
          setFieldError(message);
          return;
        }
        if (res.status === 409 && code !== null && STANDING_REFUSAL_CODES.has(code)) {
          // T166 follow-up — the member's standing refused the promotion; the
          // row did not move, so say it here and keep the trigger's focus.
          setFormError({ kind: 'error', message });
          return;
        }
        if (res.status === 409 || res.status === 404) {
          // The stage moved underneath us — the page is stale, not the input.
          closedViaSuccessRef.current = true;
          toast.error(message);
          setOpen(false);
          router.refresh();
          return;
        }
        // The dialog stays open: say it inside it (H1).
        setFormError({ kind: 'error', message });
      } catch {
        setFormError({ kind: 'error', message: approvalErrorMessage(tErrors, null) });
      }
    });
  }

  const proposalLine =
    proposedSendAt === null
      ? t('proposalNone')
      : status === 'member_approved' && !proposalUsable
        ? t('proposalPassed', { time: formatIso(proposedSendAt) })
        : t('proposal', { time: formatIso(proposedSendAt) });

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        data-testid="schedule-confirm-trigger"
        variant={isChange ? 'outline' : 'default'}
        onClick={handleOpen}
      >
        <CalendarClock className="size-4" aria-hidden="true" />
        {isChange ? t('buttonChange') : t('button')}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogContent finalFocus={finalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{isChange ? t('titleChange') : t('title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {isChange ? t('descriptionChange') : t('description')}
              <span id={PROPOSAL_ID} className="mt-2 block font-medium text-foreground" data-testid="schedule-confirm-proposal">
                {proposalLine}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <fieldset className="space-y-3" disabled={pending}>
            <legend className="sr-only">{t('modeLegend')}</legend>
            <RadioGroup
              value={mode}
              onValueChange={(v) => {
                if (modes.includes(v as ScheduleConfirmMode)) {
                  setMode(v as ScheduleConfirmMode);
                  setFieldError(null);
                }
              }}
              disabled={pending}
              className="space-y-2"
            >
              {modes.map((m) => {
                const unavailable = m === 'keep_proposal' && !proposalUsable;
                return (
                  <div key={m} className="flex items-center gap-2">
                    {/* Named by its <Label htmlFor> alone; an unavailable keep
                        option points at the proposal line that says why. */}
                    <RadioGroupItem
                      id={`schedule-mode-${m}`}
                      data-testid={`schedule-mode-${m}`}
                      value={m}
                      disabled={unavailable}
                      {...(unavailable ? { 'aria-describedby': PROPOSAL_ID } : {})}
                    />
                    <Label htmlFor={`schedule-mode-${m}`} className="cursor-pointer">
                      {t(`mode.${m}`)}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>

            {mode === 'schedule' ? (
              <div className="ml-6 space-y-2">
                <Label htmlFor={WHEN_ID}>{t('whenLabel')}</Label>
                <Input
                  id={WHEN_ID}
                  data-testid="schedule-confirm-when"
                  type="datetime-local"
                  required
                  value={when}
                  min={minWhen}
                  onChange={(e) => {
                    setWhen(e.target.value);
                    setFieldError(null);
                  }}
                  aria-invalid={fieldError !== null || undefined}
                  aria-describedby={
                    fieldError !== null ? 'schedule-confirm-when-error schedule-confirm-when-help' : 'schedule-confirm-when-help'
                  }
                />
                <p id="schedule-confirm-when-help" className="text-xs text-muted-foreground">
                  {t('whenHelp')}
                </p>
              </div>
            ) : null}

            {mode === 'cancel' ? (
              <p className="text-sm text-muted-foreground" data-testid="schedule-confirm-cancel-hint">
                {t('cancelHint', { stage: tStatus('changes_requested') })}
              </p>
            ) : null}

            {fieldError !== null ? <InlineError id="schedule-confirm-when-error" message={fieldError} /> : null}

            {/* Mounted from the start and only its content swaps: a live
                region that mounts WITH its text is not announced (M4). */}
            <div role="status" aria-live="polite">
              {differs && proposedSendAt !== null ? (
                <p
                  data-testid="schedule-confirm-differs"
                  className="rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-sm text-warning"
                >
                  {t('differs', { time: formatIso(proposedSendAt) })}
                </p>
              ) : null}
            </div>
          </fieldset>
          {formError === null ? null : formError.kind === 'read_only' ? (
            <InlineWarning
              id={FORM_ERROR_ID}
              data-testid="schedule-confirm-error"
              title={tReadOnly('readOnlyMode')}
              description={tReadOnly('readOnlyNothingChanged')}
            />
          ) : (
            <InlineError id={FORM_ERROR_ID} data-testid="schedule-confirm-error" message={formError.message} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="schedule-confirm-cancel" disabled={pending}>
              {t('close')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="schedule-confirm-submit"
              disabled={submitDisabled}
              focusableWhenDisabled
              aria-busy={pending || undefined}
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
            >
              {pending ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {/* T086a V9 — send-now, the least reversible mode, names its action. */}
              {mode === 'cancel' ? t('confirmCancel') : mode === 'send_now' ? t('confirmSendNow') : t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
