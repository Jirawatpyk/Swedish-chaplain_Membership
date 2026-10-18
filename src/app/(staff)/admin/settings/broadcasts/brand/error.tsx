'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

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
  const tBrand = useTranslations('admin.settings.broadcasts.brand');

  useEffect(() => {
    console.error('[admin/settings/broadcasts/brand error boundary]', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={tBrand('pageTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}
