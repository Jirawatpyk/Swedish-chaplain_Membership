import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MailIcon } from 'lucide-react';
import { Alert, Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { KILL_SWITCH_RETRY_AFTER_SECONDS } from '@/lib/kill-switch-retry';
import { readPauseState, type PauseState } from '@/lib/pause-state';
import { requirePagePermission } from '@/lib/rbac';

/**
 * Staff help and support page at `/admin/support`.
 *
 * Every 503 the proxy's kill switches return (read-only mode, a feature
 * switched off) carries `supportUrl: '/admin/support'` (`src/proxy.ts`
 * `build503`), but the route did not exist until R84 found it answering "Page
 * not available". It gives the support address (`SUPPORT_EMAIL`, the one the
 * portal's contact links use) and says, in staff words, what a paused change
 * means — the same wording as the `State-maintenance` board's banner.
 * What happened comes first (a staff user arrives here from a refused
 * action); the retry window is the proxy's own `Retry-After`.
 *
 * No board draws this page; it uses the staff form frame, as `/admin/account`
 * does. Gated like the dashboard: every staff role may open it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.support');
  return { title: t('title') };
}

export default async function StaffSupportPage(): Promise<React.ReactElement> {
  await requirePagePermission('dashboard.view');
  // The proxy's own flags, read per request as it reads them.
  return renderStaffSupportView(readPauseState(env));
}

/** The page body, shared with the /test-fixtures/aura-admin preview. */
export async function renderStaffSupportView(pause: PauseState): Promise<React.ReactElement> {
  const t = await getTranslations('admin.support');
  const minutes = KILL_SWITCH_RETRY_AFTER_SECONDS / 60;
  const nothingPaused = !pause.readOnly && pause.featuresOff.length === 0;

  return (
    <FormContainer align="start">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {/* What is paused RIGHT NOW (board `Admin-support`, status tweak), so a
          staff user who was refused learns which case they hit. */}
      {nothingPaused ? (
        <Alert id="support-status-ok" tone="success" role="status" title={t('status.ok')} />
      ) : null}
      {pause.readOnly ? (
        <Alert id="support-status-maintenance" tone="warning" role="status" title={t('status.maintenance')}>
          {t('status.maintenanceBody', { minutes })}
        </Alert>
      ) : null}
      {pause.featuresOff.length > 0 ? (
        <Alert
          id="support-status-off"
          tone="warning"
          role="status"
          title={t('status.featuresOff', {
            features: pause.featuresOff.map((feature) => t(`feature.${feature}`)).join(', '),
          })}
        >
          {t('status.featuresOffBody')}
        </Alert>
      ) : null}

      <Card title={t('paused.title')} headingLevel={2}>
        <div className="flex flex-col gap-[var(--aura-space-2)] aura-text-sm">
          <p>{t('paused.maintenance', { minutes })}</p>
          <p>{t('paused.featureOff')}</p>
          <p className="text-[var(--aura-fg-secondary)]">{t('paused.nothingChanged')}</p>
        </div>
      </Card>

      <Card title={t('contact.title')} headingLevel={2}>
        <div className="flex flex-col gap-[var(--aura-space-3)]">
          <p className="aura-text-sm text-[var(--aura-fg-secondary)]">{t('contact.body')}</p>
          {/* The address is the button's text, not hidden behind "Email us":
              a mailto does nothing without a mail app set up, so it must be
              readable and copyable. Same affordance as the portal's contact
              link (invoices-summary-card). */}
          <a
            href={`mailto:${env.supportEmail}`}
            className={buttonClass({
              variant: 'secondary',
              touchHeight: true,
              className: 'self-start [overflow-wrap:anywhere]',
            })}
          >
            <MailIcon aria-hidden className="size-4" />
            {env.supportEmail}
          </a>
          <p className="aura-text-sm text-[var(--aura-fg-secondary)]">{t('contact.includeId')}</p>
        </div>
      </Card>
    </FormContainer>
  );
}
