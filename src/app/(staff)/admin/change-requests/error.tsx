'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F114 — segment-scoped error boundary for `/admin/change-requests` (the
 * queue). A repo failure THROWS from the page (never renders as "no requests
 * are waiting" — review UX C3) and lands here, keeping the admin shell
 * (sidebar + top nav) intact. Same TableContainer as page.tsx (check:layout).
 */
export default function ChangeRequestsQueueError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tQueue = useTranslations('admin.changeRequests.queue');

  useEffect(() => {
    console.error('[admin/change-requests error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={tQueue('title')} />
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
    </TableContainer>
  );
}
