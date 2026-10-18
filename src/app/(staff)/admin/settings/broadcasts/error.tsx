'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for the E-Blast
 * settings page. A settings read that fails THROWS from the page (it never
 * renders a form asserting "off" / "unlimited" about a row it could not read,
 * which the operator would then save back over the real values) and lands here
 * with the admin shell intact. Same `FormContainer` as page.tsx +
 * loading.tsx (`check:layout`); the sibling of
 * `/admin/settings/broadcasts/brand/error.tsx`.
 */
export default function BroadcastSettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tSettings = useTranslations('admin.broadcasts.settings');

  useEffect(() => {
    console.error('[admin/settings/broadcasts error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tSettings('pageTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}
