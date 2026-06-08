'use client';

/**
 * Approve dialog (T118 helper). Variants:
 *   - send_now: confirms immediate dispatch (cron picks up within 60s)
 *   - schedule: collects datetime-local with min=now+5min defence
 *
 * Calls POST /api/admin/broadcasts/[id]/approve.
 */
import { useMemo, useState, useTransition } from 'react';
import { Loader2Icon } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { LocalDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import { getDateFormatLocale } from '@/lib/format-date-localised';

const MIN_LEAD_MS = 5 * 60 * 1000;
const BANGKOK_ZONE = ZoneId.of('Asia/Bangkok');

/**
 * Code-review TZ fix — `<input type="datetime-local">` returns a naive
 * local string ("2026-05-04T14:00") with no offset. The new
 * scheduleHelp microcopy + preview formatter both claim the input is
 * Asia/Bangkok wall-time, so we must parse it as Bangkok-zoned, not
 * the browser's local zone (which is what `new Date(localString)`
 * does). Mismatch would let an admin in UTC type "14:00 Bangkok" but
 * the system would dispatch at 21:00 Bangkok — UX claim broken.
 *
 * `LocalDateTime.parse` accepts the `YYYY-MM-DDTHH:mm` shape directly
 * (the input adds `:ss` if seconds enabled — we don't). Then bind to
 * Asia/Bangkok and convert to a real `Date`/ISO instant.
 */
function bangkokInputToInstant(scheduledFor: string): Date {
  // Pad with `:00` seconds if missing (datetime-local without `step`
  // omits seconds).
  const normalised =
    scheduledFor.length === 16 ? `${scheduledFor}:00` : scheduledFor;
  const local = LocalDateTime.parse(normalised);
  const instant = local.atZone(BANGKOK_ZONE).toInstant();
  return new Date(instant.toEpochMilli());
}

function minLocalDateTime(): string {
  // `min=` attribute on `<input type="datetime-local">` is interpreted
  // by the browser in its OWN local zone — the spec doesn't allow
  // overriding. We compute "5 minutes from now" in Bangkok wall-time
  // (the contract advertised in microcopy) and serialise. A non-
  // Bangkok admin's browser may still allow earlier selections within
  // its local +X-hour window; the server-side use-case enforces the
  // hard 5-minute minimum so the client min is best-effort.
  const future = LocalDateTime.now(BANGKOK_ZONE).plusMinutes(6);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${future.year()}-${pad(future.monthValue())}-${pad(future.dayOfMonth())}T${pad(future.hour())}:${pad(future.minute())}`;
}

export interface ApproveDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function ApproveDialog({
  broadcastId,
  open,
  onOpenChange,
}: ApproveDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approveDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  const locale = useLocale();
  const router = useRouter();
  const [decision, setDecision] = useState<'send_now' | 'schedule'>('send_now');
  const [scheduledFor, setScheduledFor] = useState<string>('');
  const [pending, startTransition] = useTransition();
  const minLocal = useMemo(() => minLocalDateTime(), []);

  // Reset state via onOpenChange wrapper (avoids setState-in-effect
  // cascade warning under React 19 strict mode).
  function handleOpenChange(next: boolean): void {
    if (!next) {
      setDecision('send_now');
      setScheduledFor('');
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
          toast.success(tToast('approved'));
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
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* C3 UX hardening — removed `aria-disabled` on the fieldset.
            HTML `disabled` on a `<fieldset>` disables all descendant
            form controls natively + sets `aria-disabled` implicitly.
            The duplicated attribute risked confusing future maintainers
            who might think two different semantics were intended. */}
        <fieldset className="space-y-3" disabled={pending}>
          <RadioGroup
            value={decision}
            onValueChange={(v) =>
              setDecision(v === 'schedule' ? 'schedule' : 'send_now')
            }
            disabled={pending}
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="approve-send-now" value="send_now" aria-label={t('decision.sendNow')} />
              <Label htmlFor="approve-send-now" className="cursor-pointer">
                {t('decision.sendNow')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="approve-schedule" value="schedule" aria-label={t('decision.schedule')} />
              <Label htmlFor="approve-schedule" className="cursor-pointer">
                {t('decision.schedule')}
              </Label>
            </div>
          </RadioGroup>
          {decision === 'schedule' ? (
            <div className="ml-6 space-y-2">
              <Label htmlFor="approve-when">{t('scheduleLabel')}</Label>
              <Input
                id="approve-when"
                type="datetime-local"
                value={scheduledFor}
                min={minLocal}
                onChange={(e) => setScheduledFor(e.target.value)}
                disabled={pending}
                aria-describedby="approve-when-help"
              />
              {scheduledFor !== '' ? (
                <p className="text-xs font-medium text-foreground">
                  {t('schedulePreviewLabel')}{' '}
                  {/* The preview only renders when `scheduledFor !== ''`,
                      which is initialised to '' by useState — so this
                      branch is unreachable during SSR. The previous
                      `suppressHydrationWarning` was dead defensive code
                      and has been removed. */}
                  <span>
                    {(() => {
                      try {
                        // Parse as Bangkok wall-time then render in
                        // Bangkok TZ — round-trip is identity, so the
                        // preview matches what the admin typed in the
                        // input regardless of browser TZ.
                        const instant = bangkokInputToInstant(scheduledFor);
                        const formatter = new Intl.DateTimeFormat(
                          getDateFormatLocale(locale),
                          {
                            dateStyle: 'long',
                            timeStyle: 'short',
                            timeZone: 'Asia/Bangkok',
                          },
                        );
                        return formatter.format(instant);
                      } catch {
                        return '';
                      }
                    })()}
                  </span>
                </p>
              ) : null}
              <p
                id="approve-when-help"
                className="text-xs text-muted-foreground"
              >
                {t('scheduleHelp')}
              </p>
            </div>
          ) : null}
        </fieldset>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitDisabled}
            aria-busy={pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending ? (
              <>
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                {t('confirm')}
              </>
            ) : (
              t('confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
