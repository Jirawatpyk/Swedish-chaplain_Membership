'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for the E-Blast
 * review queue. A queue or SLA read that fails THROWS from the page (it never
 * renders as "nothing is waiting for review" — an empty queue and an unread
 * queue are opposite operational facts) and lands here, keeping the admin
 * shell intact. Same `TableContainer` as page.tsx + loading.tsx
 * (`check:layout` pins the trio); the shared `errors.*` / `buttons.retry`
 * copy, as `/admin/change-requests/error.tsx`.
 */
export default function BroadcastQueueError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tQueue = useTranslations('admin.broadcasts.queue');

  useEffect(() => {
    console.error('[admin/broadcasts error boundary]', error);
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
