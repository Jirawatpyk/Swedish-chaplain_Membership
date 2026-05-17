'use client';

/**
 * F7 UX hardening — E4: segment-scoped error boundary for member
 * compose page (`/portal/broadcasts/new`).
 *
 * Without this file, a throw from `computeQuotaCounter`, member lookup,
 * or the rendered `<ComposeForm />` would bubble to the portal layout
 * error boundary two levels up — losing the portal chrome (sidebar,
 * top nav) and leaving the member stranded.
 *
 * Mirrors the F3 admin member-detail boundary pattern. Server-pure
 * outside the `'use client'` flag (Next.js convention for `error.tsx`).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AlertCircleIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function ComposeBroadcastError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tBack = useTranslations('portal.broadcasts.detail');

  useEffect(() => {
    console.error('[portal/broadcasts/new error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
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
          <Link
            href="/portal/benefits/e-blasts"
            className={buttonVariants({ variant: 'outline' })}
          >
            {tBack('back')}
          </Link>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
