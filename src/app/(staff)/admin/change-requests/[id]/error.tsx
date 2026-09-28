'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F114 — segment-scoped error boundary for `/admin/change-requests/[id]`
 * (the review page). A repo failure THROWS from the page and lands here
 * instead of the staff root boundary, keeping the admin shell (sidebar + top
 * nav) intact — the queue's boundary, one level down (review round 1, UX I5).
 * Same DetailContainer as page.tsx (check:layout).
 */
export default function ChangeRequestReviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tReview = useTranslations('admin.changeRequests.review');

  useEffect(() => {
    console.error('[admin/change-requests/[id] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={tReview('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}
