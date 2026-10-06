'use client';

/**
 * H7.1 / IMP-R2-1 — route-level error boundary for the PII erasure
 * page. Catches unhandled exceptions that escape page.tsx's try/catch
 * (Neon outage during eventId/registrationId lookup, tenant resolution
 * failure, etc). Without this file, Next.js falls back to a parent
 * error boundary → generic copy, not erase-specific retry.
 *
 * Uses `DetailContainer` to match `page.tsx` + `loading.tsx` so
 * `pnpm check:layout` accepts the layout-pair contract. Spec 122 US9b-1
 * (T926): the shared AURA `RouteErrorPanel` (`role="alert"`, WCAG SC 4.1.3).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function ErasePiiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('admin.events.detail.erase');

  useEffect(() => {
    console.error('[F6] erase-pii page error boundary', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('errorTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}
