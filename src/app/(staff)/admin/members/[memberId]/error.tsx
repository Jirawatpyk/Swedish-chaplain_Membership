'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * Segment-scoped error boundary for the member detail page
 * (`/admin/members/[memberId]`).
 *
 * Exists so a throw from any Server Component on this page (notably
 * `MemberInvoicesSection` on a Neon failure, per US7 remediation)
 * stops at the member page — not at the admin layout two levels up.
 * Without this file a repo error would blank the sidebar + top nav,
 * worse than the pre-remediation silent empty state. Spec 122 US5b-1: the
 * shared AURA error panel (Retry + the error id).
 */
export default function MemberDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[members/[memberId] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}
