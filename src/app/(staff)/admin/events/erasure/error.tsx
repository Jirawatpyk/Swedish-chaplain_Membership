'use client';

/**
 * F6 remediation PR 2.2 / P4 — route-level error boundary for the
 * erase-by-email page. Catches unhandled exceptions that escape page.tsx's
 * try/catch (Neon outage during tenant resolution, etc). Uses `TableContainer`
 * to match `page.tsx` + `loading.tsx` so `pnpm check:layout` accepts the
 * container pair. `role="alert"` announces immediately to assistive tech
 * (WCAG SC 4.1.3).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function EraseByEmailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('admin.events.erasure');
  // Reuse the shipped per-registration erase "Try again" label (same F6
  // erase family) rather than adding a duplicate key.
  const tErase = useTranslations('admin.events.detail.erase');

  useEffect(() => {
    console.error('[F6] erase-by-email page error boundary', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('errorTitle')} />
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-6"
        role="alert"
      >
        <div className="space-y-1">
          <p className="text-body">{t('errorState')}</p>
          {error.digest ? (
            <p className="text-xs font-mono text-muted-foreground">
              {error.digest}
            </p>
          ) : null}
        </div>
        <Button type="button" onClick={reset} className="min-h-11">
          {tErase('tryAgain')}
        </Button>
      </div>
    </TableContainer>
  );
}
