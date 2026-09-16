'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * F114 US6 (UX L2) — segment-scoped error boundary for
 * `/admin/settings/member-changes`. The page THROWS on a settings / pending-
 * count read failure (never renders a switch that asserts "off" about a row
 * it could not read) and lands here, keeping the admin shell intact. Same
 * `FormContainer` as page.tsx + loading.tsx (check:layout); the shared
 * `errors.*` / `buttons.retry` copy, as `/admin/change-requests/error.tsx`.
 */
export default function MemberChangesSettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tPage = useTranslations('admin.settings.memberChanges');

  useEffect(() => {
    console.error('[admin/settings/member-changes error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tPage('pageTitle')} subtitle={tPage('pageDescription')} />
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
