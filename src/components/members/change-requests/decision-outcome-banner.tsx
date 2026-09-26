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
import { toast } from '@/lib/toast';
import { CheckCircle2Icon, ListChecksIcon, XCircleIcon } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';
import { AuraAlert, auraButtonClass } from '@/components/shell/aura-markup';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface DecisionOutcomeBannerProps {
  readonly request: ChangeRequestView;
}

const TONE = { approved: 'success', partially_approved: 'warning', rejected: 'danger' } as const;

export function DecisionOutcomeBanner({ request }: DecisionOutcomeBannerProps) {
  const t = useTranslations('portal.changeRequests.outcome');
  const locale = useLocale();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();
  // a decided request always carries an outcome (0300 `outcome_iff_decided_ck`);
  // the null arm renders NOTHING rather than guess (the staff toast guesses
  // nothing either — round 6, silent-failure #15)
  const outcome = request.outcome;
  const anyRejected = request.fields.some((f) => f.outcome === 'rejected');
  const decidedAt = request.decidedAt
    ? formatLocalisedDate(request.decidedAt, locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  if (dismissed || outcome === null) return null;

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
      } catch (e) {
        console.error('[decision-outcome-banner] acknowledge failed', e);
        toast.error(t('dismissError'));
      }
    });
  }

  const Icon = outcome === 'approved' ? CheckCircle2Icon : outcome === 'rejected' ? XCircleIcon : ListChecksIcon;

  // AURA Alert markup (spec 122 US3). The helper, not AURA's `Alert`: the
  // banner stays `role="status"` whatever the tone (a decision is news, not an
  // interruption), and carries its outcome icon and test hooks.
  return (
    <AuraAlert
      tone={TONE[outcome]}
      role="status"
      icon={Icon}
      title={t(`title.${outcome}`)}
      data-testid="decision-outcome-banner"
      data-outcome={outcome}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {anyRejected ? (
            <Link
              href={`/portal/edit?resubmit=${encodeURIComponent(request.id)}`}
              className={auraButtonClass()}
              data-testid="resubmit-link"
            >
              {t('resubmit')}
            </Link>
          ) : null}
          <Button type="button" variant="secondary" icon="x" onClick={dismiss} disabled={pending} data-testid="dismiss-decision">
            {t('dismiss')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p>{t(`body.${outcome}`, { decidedAt })}</p>
        <ChangeRequestDiffTable
          fields={request.fields}
          showOutcome
          className="bg-[var(--aura-bg-surface)] text-[var(--aura-fg-primary)]"
        />
        {request.decisionReason ? (
          <div
            className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface)] p-3 text-[var(--aura-fg-primary)]"
            data-testid="decision-reason"
          >
            <p className="font-medium">{t('reasonLabel')}</p>
            <p className="whitespace-pre-wrap break-words">{request.decisionReason}</p>
          </div>
        ) : null}
      </div>
    </AuraAlert>
  );
}
