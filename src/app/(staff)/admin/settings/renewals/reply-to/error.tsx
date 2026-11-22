'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * PR B — segment error boundary for `/admin/settings/renewals/reply-to`. The
 * page throws on a read failure rather than render an empty form that would
 * claim no reply-to is set. Same `FormContainer` as page.tsx + loading.tsx.
 */
export default function RenewalReplyToSettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('admin.settings.renewalReplyTo');

  useEffect(() => {
    console.error('[admin/settings/renewals/reply-to error boundary]', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}
