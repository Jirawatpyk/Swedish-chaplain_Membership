/**
 * F8 Phase 4 Wave I1b · T086 — `/admin/renewals/settings/schedules`
 * server component.
 *
 * Reads all 5 tier-bucket schedule policies via `loadSchedulePolicies`
 * and renders the client-side `ScheduleEditor` (T087) with `readOnly`
 * derived from the session role.
 *
 * Authz: admin OR manager. Manager view is read-only; PUT route at
 * /api/admin/renewals/settings/schedules/[tierBucket] enforces the
 * canonical RBAC gate (defence-in-depth).
 *
 * Layout: wrapped in `<DetailContainer>` (max-width 72rem) per
 * docs/ux-standards.md § 18 — settings/edit surfaces use detail width;
 * 5 tabs with form rows fit better than the wider TableContainer
 * 96rem used for the pipeline list.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  loadSchedulePolicies,
  makeRenewalsDeps,
  reminderStepToJson,
} from '@/modules/renewals';
import { ErrorCardActions } from '../../_components/error-card-actions';
import {
  ScheduleEditor,
  type SchedulePolicyWire,
} from './_components/schedule-editor';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.settings.schedules');
  return { title: `${t('title')} · SweCham`, description: t('subtitle') };
}

export default async function RenewalSchedulesSettingsPage() {
  const t = await getTranslations('admin.renewals.settings.schedules');
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
    redirect('/portal');
  }
  const readOnly = currentUser.role !== 'admin';

  if (!env.features.f8Renewals) {
    const tShared = await getTranslations('admin.renewals');
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent
            role="status"
            aria-live="polite"
            className="py-12 text-center text-muted-foreground"
          >
            {tShared('error.featureDisabled')}
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/renewals/settings/schedules`,
    { headers: reqHeaders },
  );
  const tenantCtx = resolveTenantFromRequest(fakeRequest);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const result = await loadSchedulePolicies(deps, {
    tenantId: tenantCtx.slug,
  });

  if (!result.ok) {
    const correlationId = randomUUID();
    logger.error(
      {
        tenantId: tenantCtx.slug,
        error: result.error.kind,
        correlationId,
      },
      'renewals schedule-settings page: loadSchedulePolicies failed',
    );
    const tShared = await getTranslations('admin.renewals');
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent
            role="alert"
            aria-live="assertive"
            className="flex flex-col items-center gap-4 py-12 text-center"
          >
            <AlertTriangle
              aria-hidden="true"
              className="h-10 w-10 text-destructive"
            />
            <div className="text-base font-medium text-destructive">
              {tShared('error.loadFailed')}
            </div>
            {/*
              K3-BLK-2 + K12-1 (UX-K-3): error state was missing a
              Retry CTA. K3 added one as a `<Link>` with `_retry`
              query param — K12-1 replaces that with the shared
              `ErrorCardActions` client component which runs
              `router.refresh()` inside `useTransition`. Semantic
              button, no URL pollution, pending state during the
              RSC re-fetch.
            */}
            <ErrorCardActions
              correlationId={correlationId}
              goBackHref="/admin/renewals"
              retryLabel={tShared('error.retry')}
              goBackLabel={tShared('error.goBack')}
              referenceLabel={tShared('error.referenceLabel')}
            />
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  const initialPolicies: SchedulePolicyWire[] = result.value.policies.map(
    (p) => ({
      tier_bucket: p.tierBucket,
      steps: p.steps.map(reminderStepToJson) as SchedulePolicyWire['steps'],
      updated_at: p.updatedAt,
    }),
  );

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ScheduleEditor initialPolicies={initialPolicies} readOnly={readOnly} />
    </DetailContainer>
  );
}
