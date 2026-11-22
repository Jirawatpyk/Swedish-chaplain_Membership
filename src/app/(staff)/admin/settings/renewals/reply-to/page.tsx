/**
 * PR B (#707 follow-up) — the renewal reminder Reply-To at
 * `/admin/settings/renewals/reply-to`.
 *
 * Gate: `settings.renewal_schedules`, the key the schedule editor and the API
 * route behind this form use (admin, super_admin). F8 flag off → `notFound()`.
 * A read failure reaches the error boundary rather than rendering an empty
 * form that would claim no reply-to is set.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { errLogFields } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { requirePagePermission } from '@/lib/rbac';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { loadRenewalReplyTo, makeRenewalsDeps } from '@/modules/renewals';
import { ReplyToForm } from './_components/reply-to-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.settings.renewalReplyTo');
  return { title: t('pageTitle') };
}

export default async function RenewalReplyToSettingsPage(): Promise<React.ReactElement> {
  if (!env.features.f8Renewals) notFound();
  await requirePagePermission('settings.renewal_schedules');
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const result = await loadRenewalReplyTo(makeRenewalsDeps(tenant.slug), tenant.slug);
  if (!result.ok) {
    logger.error(
      { errorId: 'F8.REPLY_TO.PAGE_READ_FAILED', requestId: requestIdFromHeaders(h), tenantId: tenant.slug, ...errLogFields(result.error) },
      'renewals reply-to settings page: read failed',
    );
    throw new Error('renewals.reply-to: load failed');
  }
  return renderRenewalReplyToView({ email: result.value.email, displayName: result.value.displayName });
}

/** The page body, shared with the /test-fixtures/aura-admin preview. */
export async function renderRenewalReplyToView({
  email,
  displayName,
}: {
  readonly email: string | null;
  readonly displayName: string | null;
}): Promise<React.ReactElement> {
  const t = await getTranslations('admin.settings.renewalReplyTo');
  return (
    <FormContainer align="start">
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <Card title={t('title')} description={t('cardDescription')} headingLevel={2}>
        <ReplyToForm initialEmail={email} initialDisplayName={displayName} />
      </Card>
    </FormContainer>
  );
}
