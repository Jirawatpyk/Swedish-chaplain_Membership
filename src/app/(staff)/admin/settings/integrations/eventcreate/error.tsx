'use client';

/**
 * Phase 5 review-fix S-01 (2026-05-13) — render-time error boundary for
 * the `/admin/settings/integrations/eventcreate` wizard page, so a
 * transient Neon outage shows a retry surface instead of a 404.
 *
 * Spec 122 US9c — the shared AURA `RouteErrorPanel` in the page's own frame
 * (`FormContainer` + header, the `pnpm check:layout` pair), as the other
 * settings pages and the import history page do. The digest is still shown
 * for SRE correlation with the `f6_load_integration_config_page_threw` log.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function EventCreateWizardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tPage = useTranslations('admin.integrations.eventcreate.page');

  useEffect(() => {
    console.error('[F6] integration page error boundary', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={tPage('title')} subtitle={tPage('subtitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}
