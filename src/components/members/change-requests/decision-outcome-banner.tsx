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
import { Button } from '@jirawatpyk/aura-react';
import { Alert, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface DecisionOutcomeBannerProps {
  readonly request: ChangeRequestView;
}

// Partially approved reads as information (the `Portal-profile-states` board), not a warning.
const TONE = { approved: 'success', partially_approved: 'info', rejected: 'danger' } as const;

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
    ? formatLocalisedDate(request.decidedAt, locale, { dateStyle: 'medium' })
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

  // AURA Alert (spec 122 US3) with each tone's own icon, as the board draws
  // it. It stays `role="status"` whatever the tone: a decision is news, not
  // an interruption. The per-field table stays (FR-010: each field's outcome).
  return (
    <Alert
      tone={TONE[outcome]}
      role="status"
      title={t(`title.${outcome}`)}
      data-testid="decision-outcome-banner"
      data-outcome={outcome}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {anyRejected ? (
            <Link
              href={`/portal/edit?resubmit=${encodeURIComponent(request.id)}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
              data-testid="resubmit-link"
            >
              {t('resubmit')}
            </Link>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={dismiss} disabled={pending} data-testid="dismiss-decision">
            {t('dismiss')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p>{t(`body.${outcome}`, { decidedAt })}</p>
        <ChangeRequestDiffTable fields={request.fields} showOutcome variant="plain" />
        {request.decisionReason ? (
          <div className="mt-2 flex flex-col gap-0.5" data-testid="decision-reason">
            <p className="text-xs font-semibold">{t('reasonLabel')}</p>
            <p className="whitespace-pre-wrap break-words">{request.decisionReason}</p>
          </div>
        ) : null}
      </div>
    </Alert>
  );
}
