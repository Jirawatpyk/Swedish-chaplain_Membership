/**
 * T149 — /admin/settings/fees page (US5).
 *
 * Server component — reads fee config directly via `getFeeConfig`.
 * The form is a client component (`<FeeConfigForm>`) that PATCHes
 * `/api/fee-config` on submit.
 *
 * RBAC: admin + manager can reach the page; the form renders the
 * save button only for admin (FR-017 read-only for manager). The
 * server-side guard sits inside the PATCH route, so the client-side
 * disabling is a UX nicety — not a security boundary.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getFeeConfig } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FeeConfigForm } from '@/components/plans/fee-config-form';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { logger } from '@/lib/logger';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Fee configuration · SweCham' };
}

export default async function FeeConfigPage() {
  const { user: currentUser } = await requireSession('staff');
  const t = await getTranslations('admin.settings.fees');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);

  const result = await getFeeConfig({
    tenant: deps.tenant,
    feeConfigRepo: deps.feeConfigRepo,
  });

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      notFound();
    }
    logger.error(
      {
        route: '/admin/settings/fees',
        errorType: result.error.type,
      },
      'fee_config_load_failed',
    );
    return (
      <ContentContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <p className="text-body text-destructive" role="alert">
          {t('errors.generic')}
        </p>
      </ContentContainer>
    );
  }

  const feeConfig = result.value;

  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<Badge variant="secondary">{currentUser.role}</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FeeConfigForm
            initialValues={{
              currency_code: feeConfig.currency_code,
              vat_rate: feeConfig.vat_rate,
              registration_fee_minor_units: feeConfig.registration_fee_minor_units,
            }}
            currentUserRole={currentUser.role as 'admin' | 'manager' | 'member'}
          />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
