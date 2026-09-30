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
 *
 * 122 US7a (T706): AURA `Dialog` (`role="alertdialog"`, Cancel focused
 * first) with the duration as an AURA `RadioGroup`; the request, its error
 * mapping and the toasts are unchanged.
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button, Dialog, RadioGroup } from '@jirawatpyk/aura-react';

export type SnoozeDuration = 7 | 30 | 90;

export interface SnoozeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly memberId: string;
  readonly memberCompanyName: string | null;
  /**
   * a11y fix — focus-return target on close (WCAG 2.1 AA SC 2.4.3).
   * `SnoozeDialog` is opened from a plain visible "Snooze" button in
   * `at-risk-widget.tsx` (mirrors `OutreachDialog`'s `finalFocus`
   * pattern for its "Contact" button). Optional: omitting it returns focus
   * to whatever had it when the dialog opened (AURA's default).
   */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}

export function SnoozeDialog({
  open,
  onOpenChange,
  memberId,
  memberCompanyName,
  finalFocus,
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
          // next-intl's `t` has no `fallback` option — a missing key would
          // render the raw dotted KEY PATH. Guard with `t.has` and fall back
          // to the generic localized server_error copy for unmapped codes.
          const key = `toast.error.${code}`;
          toast.error(t('toast.failure'), {
            description: t.has(key) ? t(key) : t('toast.error.server_error'),
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
  const durations: ReadonlyArray<SnoozeDuration> = [7, 30, 90];

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      role="alertdialog"
      {...(finalFocus ? { finalFocus } : {})}
      title={t('title')}
      description={
        memberCompanyName
          ? t('description', { company: memberCompanyName })
          : t('descriptionFallback')
      }
      footer={
        <>
          <Button
            variant="secondary"
            data-autofocus=""
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} loading={pending}>
            {pending ? t('confirming') : t('confirm')}
          </Button>
        </>
      }
    >
      <RadioGroup
        label={t('durationLabel')}
        value={String(duration)}
        onChange={(v) => setDuration(Number.parseInt(v, 10) as SnoozeDuration)}
        options={durations.map((d) => ({ value: String(d), label: t('option', { days: d }) }))}
      />
    </Dialog>
  );
}
