'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F114 — segment-scoped error boundary for `/admin/change-requests/[id]`
 * (the review page). A repo failure THROWS from the page and lands here
 * instead of the staff root boundary, keeping the admin shell (sidebar + top
 * nav) intact — the queue's boundary, one level down (review round 1, UX I5).
 * Same DetailContainer as page.tsx (check:layout).
 */
export default function ChangeRequestReviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tReview = useTranslations('admin.changeRequests.review');

  useEffect(() => {
    console.error('[admin/change-requests/[id] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={tReview('title')} />
      <Card>
        <CardHeader className="flex flex-row items-start gap-3">
          <AlertCircleIcon className="size-6 text-destructive" aria-hidden />
          <div>
            <CardTitle>{t('generic')}</CardTitle>
            <CardDescription>{error.digest ? t('errorId', { id: error.digest }) : null}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={reset}>{tButtons('retry')}</Button>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
