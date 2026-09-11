'use client';

/**
 * F114 — "Pending review" banner (US1 AS1, FR-010; T042). Rendered on
 * /portal/profile and /portal/edit while the caller's OWN request is
 * pending. `role="status"` so the state is announced without stealing focus;
 * the submission time goes through `formatLocalisedDate` (BE display-only
 * for th-TH); the proposed vs current values reuse the shared diff table.
 * The withdraw control lands in US5 (T089).
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ClockIcon } from 'lucide-react';
import { InlineAlert } from '@/components/ui/inline-alert';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface PendingRequestBannerProps {
  readonly request: ChangeRequestView;
  /** Show the "edit your request" link (hidden on the edit page itself). */
  readonly showEditLink?: boolean;
}

export function PendingRequestBanner({ request, showEditLink = true }: PendingRequestBannerProps) {
  const t = useTranslations('portal.changeRequests.pending');
  const locale = useLocale();
  const submittedAt = formatLocalisedDate(request.submittedAt, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <InlineAlert tone="info" role="status" className="space-y-3" data-testid="pending-request-banner">
      <div className="flex items-start gap-2">
        <ClockIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">{t('title')}</p>
          <p className="text-sm">{t('body', { submittedAt })}</p>
        </div>
      </div>
      <ChangeRequestDiffTable fields={request.fields} className="bg-background" />
      {showEditLink ? (
        <p className="text-sm">
          <Link href="/portal/edit" className="text-primary underline-offset-4 hover:underline">
            {t('editLink')}
          </Link>
        </p>
      ) : null}
    </InlineAlert>
  );
}
