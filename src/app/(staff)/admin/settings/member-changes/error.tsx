'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F114 US6 (UX L2) — segment-scoped error boundary for
 * `/admin/settings/member-changes`. The page THROWS on a settings / pending-
 * count read failure (never renders a switch that asserts "off" about a row
 * it could not read) and lands here, keeping the admin shell intact. Same
 * `FormContainer` as page.tsx + loading.tsx (check:layout).
 *
 * Spec 122 US10c (T1024): the shared AURA `RouteErrorPanel`, as the other
 * settings pages; the digest is still shown for SRE correlation with the
 * `M114.admin.setting_page.*` log.
 */
export default function MemberChangesSettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tPage = useTranslations('admin.settings.memberChanges');

  useEffect(() => {
    console.error('[admin/settings/member-changes error boundary]', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={tPage('pageTitle')} subtitle={tPage('pageDescription')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}
