'use client';

/**
 * H7.1 / IMP-R2-1 — route-level error boundary for the PII erasure
 * page. Catches unhandled exceptions that escape page.tsx's try/catch
 * (Neon outage during eventId/registrationId lookup, tenant resolution
 * failure, etc). Without this file, Next.js falls back to a parent
 * error boundary → generic copy, not erase-specific retry.
 *
 * Uses `DetailContainer` to match `page.tsx` + `loading.tsx` so
 * `pnpm check:layout` accepts the layout-pair contract. `role="alert"`
 * announces the error immediately to assistive tech (WCAG SC 4.1.3).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

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
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-6"
        role="alert"
      >
        <div className="space-y-1">
          <p className="text-body">{t('errorDescription')}</p>
          {error.digest ? (
            <p className="text-xs font-mono text-muted-foreground">
              {error.digest}
            </p>
          ) : null}
        </div>
        <Button type="button" onClick={reset} className="min-h-11">
          {t('cancel')}
        </Button>
      </div>
    </DetailContainer>
  );
}
