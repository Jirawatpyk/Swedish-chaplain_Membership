'use client';

/**
 * Phase 5 review-fix S-01 (2026-05-13) — render-time error boundary
 * for the `/admin/settings/integrations/eventcreate` wizard page.
 *
 * Replaces the prior `notFound()` collapse, which masked transient
 * Neon outages as "page doesn't exist". Now the admin sees an
 * actionable retry surface + the request ID exposed in the pino
 * `f6_load_integration_config_page_threw` log line so they can
 * correlate with SRE during incident triage.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function EventCreateWizardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tPage = useTranslations('admin.integrations.eventcreate.page');
  const t = useTranslations('admin.integrations.eventcreate.page.error');

  useEffect(() => {
    // Surface to browser console so devs can debug while the pino log
    // captures the server-side trail. `error.digest` is the Next.js
    // production-mode anonymised stack hash — the only client-visible
    // breadcrumb when the prod build hides the real message.
    console.error('[F6] integration page error boundary', error);
  }, [error]);

  // Wrap in FormContainer + PageHeader so the layout is CLS-0 with the
  // sibling page.tsx + loading.tsx (matches the `pnpm check:layout`
  // pair contract). role="alert" announces the error immediately to
  // assistive tech per WCAG SC 4.1.3.
  return (
    <FormContainer>
      <PageHeader title={tPage('title')} subtitle={tPage('subtitle')} />
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-6"
        role="alert"
      >
        <div className="space-y-1">
          <h2 className="text-h3 font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('body')}</p>
          {error.digest ? (
            <p className="text-xs font-mono text-muted-foreground">
              {t('digest', { digest: error.digest })}
            </p>
          ) : null}
        </div>
        <Button type="button" onClick={reset} className="min-h-11">
          {t('retry')}
        </Button>
      </div>
    </FormContainer>
  );
}
