'use client';

/**
 * Approve dialog (T118 helper). Variants:
 *   - send_now: confirms immediate dispatch (cron picks up within 60s)
 *   - schedule: collects datetime-local with min=now+5min defence
 *
 * Calls POST /api/admin/broadcasts/[id]/approve.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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

const MIN_LEAD_MS = 5 * 60 * 1000;

function minLocalDateTime(): string {
  const future = new Date(Date.now() + MIN_LEAD_MS + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
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
  function isScheduleValid(): boolean {
    if (decision === 'send_now') return true;
    if (scheduledFor === '') return false;
    return new Date(scheduledFor).getTime() > Date.now() + MIN_LEAD_MS;
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
                scheduledFor: new Date(scheduledFor).toISOString(),
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
        <fieldset className="space-y-3" aria-disabled={pending}>
          <RadioGroup
            value={decision}
            onValueChange={(v) =>
              setDecision(v === 'schedule' ? 'schedule' : 'send_now')
            }
            disabled={pending}
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="approve-send-now" value="send_now" />
              <Label htmlFor="approve-send-now" className="cursor-pointer">
                {t('decision.sendNow')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="approve-schedule" value="schedule" />
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
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
