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
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * Segment-level error boundary for `/admin/plans/[year]/[planId]`
 * (detail page).
 *
 * Renders inside `<DetailContainer>` (72rem) to match the detail page's
 * width. Post-ship R6 I12.
 */
export default function PlanDetailError({
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
    console.error('[admin/plans/[year]/[planId] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
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
    </DetailContainer>
  );
}
