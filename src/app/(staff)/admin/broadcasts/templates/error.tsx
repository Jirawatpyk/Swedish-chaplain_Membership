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
 * template library. A template-list read that fails THROWS from the page (it
 * must never render the "no templates yet" empty state, which would invite an
 * operator to re-author templates that already exist) and lands here with the
 * admin shell intact. Same `TableContainer` as page.tsx + loading.tsx
 * (`check:layout`).
 */
export default function BroadcastTemplatesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tTemplates = useTranslations('admin.broadcasts.templates');

  useEffect(() => {
    console.error('[admin/broadcasts/templates error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={tTemplates('pageTitle')} />
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
