'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * Segment-level error boundary for `/admin/plans` (list page).
 *
 * Renders inside `<TableContainer>` (96rem) to match the list page's
 * width so an exception on a wide-table fetch (Neon timeout, RLS
 * misconfig, taxPolicy bootstrap missing) doesn't render in the
 * parent `/admin/error.tsx`'s `<DetailContainer>` (72rem) — that
 * width mismatch was post-ship R6 I12. Sidebar + top bar remain
 * usable via the staff shell layout.
 */
export default function PlansListError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tPlans = useTranslations('admin.plans.errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[admin/plans error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <Card>
        <CardHeader className="flex flex-row items-start gap-3">
          <AlertCircleIcon className="size-6 text-destructive" aria-hidden />
          <div>
            <CardTitle>{t('generic')}</CardTitle>
            <CardDescription>
              {error.digest ? t('errorId', { id: error.digest }) : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={reset}>{tButtons('retry')}</Button>
          <Link href="/admin/plans" className={buttonVariants({ variant: 'outline' })}>
            {tPlans('backToList')}
          </Link>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
