'use client';

/**
 * F114 — the decision banner on /portal/profile (US3 AS2/AS3, FR-010,
 * FR-023, FR-034; T064). Shows the caller's LAST decided request until they
 * dismiss it: an outcome badge (icon + text, never colour alone), the fields
 * with their per-field outcome (the shared diff table with `showOutcome`),
 * the reviewer's reason verbatim (plain text — never markup), an "edit and
 * resubmit" link prefilled with exactly the rejected values, and a Dismiss
 * button calling `POST …/[id]/acknowledge`. `role="status"`: announced
 * without stealing focus. The portal never names the reviewer (FR-029).
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2Icon, ListChecksIcon, XCircleIcon, XIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { InlineAlert } from '@/components/ui/inline-alert';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface DecisionOutcomeBannerProps {
  readonly request: ChangeRequestView;
}

const TONE = { approved: 'success', partially_approved: 'warning', rejected: 'destructive' } as const;

export function DecisionOutcomeBanner({ request }: DecisionOutcomeBannerProps) {
  const t = useTranslations('portal.changeRequests.outcome');
  const locale = useLocale();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();
  const outcome = request.outcome ?? 'rejected';
  const anyRejected = request.fields.some((f) => f.outcome === 'rejected');
  const decidedAt = request.decidedAt
    ? formatLocalisedDate(request.decidedAt, locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  if (dismissed) return null;

  function dismiss(): void {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/portal/change-requests/${request.id}/acknowledge`, { method: 'POST' });
        if (!res.ok) {
          // 409 `not_decided` means the state moved under us — re-fetch rather
          // than pretend the dismiss stuck (review: reliability M-7)
          if (res.status === 409) router.refresh();
          else toast.error(t('dismissError'));
          return;
        }
        setDismissed(true);
        // the banner (and the button holding focus) unmounts — land on the
        // page landmark instead of <body> (review: UX M7)
        document.getElementById('main-content')?.focus({ preventScroll: true });
        router.refresh();
      } catch {
        toast.error(t('dismissError'));
      }
    });
  }

  const Icon = outcome === 'approved' ? CheckCircle2Icon : outcome === 'rejected' ? XCircleIcon : ListChecksIcon;

  return (
    <InlineAlert tone={TONE[outcome]} role="status" className="space-y-3" data-testid="decision-outcome-banner" data-outcome={outcome}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">{t(`title.${outcome}`)}</p>
          <p className="text-sm">{t(`body.${outcome}`, { decidedAt })}</p>
        </div>
      </div>
      <ChangeRequestDiffTable fields={request.fields} showOutcome className="bg-background text-foreground" />
      {request.decisionReason ? (
        <div className="rounded-md bg-background p-3 text-sm text-foreground" data-testid="decision-reason">
          <p className="font-medium">{t('reasonLabel')}</p>
          <p className="whitespace-pre-wrap break-words">{request.decisionReason}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {anyRejected ? (
          <Link href={`/portal/edit?resubmit=${encodeURIComponent(request.id)}`} className={cn(buttonVariants({ size: 'sm' }), 'h-9')} data-testid="resubmit-link">
            {t('resubmit')}
          </Link>
        ) : null}
        <Button type="button" variant="outline" size="sm" className="h-9" onClick={dismiss} disabled={pending} data-testid="dismiss-decision">
          <XIcon className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('dismiss')}
        </Button>
      </div>
    </InlineAlert>
  );
}
