'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for the staff
 * E-Blast review page. A broadcast read, a recipient-count read or a body
 * render that fails THROWS from the page and lands here instead of the staff
 * root boundary, keeping the admin shell intact — the queue's boundary, one
 * level down. Same `DetailContainer` as page.tsx + loading.tsx
 * (`check:layout`).
 */
export default function BroadcastReviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tReview = useTranslations('admin.broadcasts.review');

  useEffect(() => {
    console.error('[admin/broadcasts/[id] error boundary]', error);
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
