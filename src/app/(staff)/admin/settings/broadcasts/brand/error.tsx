'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F119 T028 — segment-scoped error boundary for the Brand page.
 *
 * A brand read that fails THROWS from the page (it never degrades into a form
 * that shows "no colour, no address" — that reads as data rather than as an
 * outage, and the operator would then save those blanks over a row they could
 * not see). It lands here, with the admin shell intact. Same FormContainer as
 * `page.tsx` and `loading.tsx` — `check:layout` pins the trio.
 */
export default function BrandSettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tBrand = useTranslations('admin.settings.broadcasts.brand');

  useEffect(() => {
    console.error('[admin/settings/broadcasts/brand error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tBrand('pageTitle')} />
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
    </FormContainer>
  );
}
