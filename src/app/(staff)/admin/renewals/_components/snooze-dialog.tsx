/**
 * F8 Phase 6 Wave E · T169 — `SnoozeDialog`.
 *
 * Admin-only confirmation dialog for snoozing an at-risk member per
 * FR-032. RadioGroup with 7 / 30 / 90 day options + Confirm /
 * Cancel buttons. On confirm, POSTs to
 * `/api/admin/renewals/at-risk/[memberId]/snooze` with the chosen
 * duration. Shows toast on success per docs/ux-standards.md § 5.
 *
 * UX standards (docs/ux-standards.md § 4): focus on Cancel by default
 * (destructive-ish action — the member will disappear from the widget
 * for the chosen duration, so we want admin to think before
 * confirming).
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

export type SnoozeDuration = 7 | 30 | 90;

export interface SnoozeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly memberId: string;
  readonly memberCompanyName: string | null;
}

export function SnoozeDialog({
  open,
  onOpenChange,
  memberId,
  memberCompanyName,
}: SnoozeDialogProps) {
  const t = useTranslations('admin.renewals.atRisk.snooze');
  const router = useRouter();
  const [duration, setDuration] = useState<SnoozeDuration>(30);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/at-risk/${encodeURIComponent(memberId)}/snooze`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration_days: duration }),
          },
        );
        if (!res.ok) {
          let code = 'server_error';
          try {
            const body = (await res.json()) as { error?: { code?: string } };
            code = body.error?.code ?? code;
          } catch {
            /* ignore */
          }
          toast.error(t('toast.failure'), {
            description: t(`toast.error.${code}`, {
              fallback: t('toast.error.server_error'),
            }),
          });
          return;
        }
        toast.success(t('toast.success', { days: duration }));
        onOpenChange(false);
        router.refresh();
      } catch {
        toast.error(t('toast.failure'));
      }
    });
  };

  // Phase 6 review S8 — focus on Cancel via @base-ui Dialog
  // `initialFocus` ref (the `autoFocus` prop on Button doesn't survive
  // the focus-trap which would otherwise steal initial focus to the
  // close X). Canonical pattern for ux-standards § 4 "focus on Cancel
  // by default".
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {memberCompanyName
              ? t('description', { company: memberCompanyName })
              : t('descriptionFallback')}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={String(duration)}
          onValueChange={(v) => setDuration(Number.parseInt(v, 10) as SnoozeDuration)}
          className="my-3 space-y-2"
        >
          {[7, 30, 90].map((d) => (
            <div key={d} className="flex items-center gap-2">
              <RadioGroupItem id={`snooze-${d}`} value={String(d)} />
              <Label htmlFor={`snooze-${d}`} className="cursor-pointer">
                {t('option', { days: d })}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? t('confirming') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
