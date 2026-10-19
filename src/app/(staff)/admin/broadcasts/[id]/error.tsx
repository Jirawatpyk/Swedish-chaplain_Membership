'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for the staff
 * E-Blast review page. A broadcast read, a recipient-count read or a body
 * render that fails THROWS from the page and lands here instead of the staff
 * root boundary, keeping the admin shell intact — the queue's boundary, one
 * level down. Same `DetailContainer` as page.tsx + loading.tsx
 * (`check:layout`). Spec 122 US12c-1 — the shared AURA error panel (generic
 * message, error id, retry), as every migrated route.
 */
export default function BroadcastReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const tReview = useTranslations('admin.broadcasts.review');

  useEffect(() => {
    console.error('[admin/broadcasts/[id] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={tReview('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}
