/**
 * F8 Phase 4 Wave I1b · T086 — `/admin/settings/renewals/schedules`
 * server component (relocated from `/admin/renewals/settings/schedules`
 * for IA consistency with `/admin/settings/invoicing` — settings are
 * centralized under `/admin/settings/<feature>/...`. The old path is
 * 301-redirected to the new path via `next.config.ts redirects()`).
 *
 * Reads all 5 tier-bucket schedule policies via `loadSchedulePolicies`
 * and renders the client-side `ScheduleEditor` (T087) in edit mode —
 * every admitted viewer holds the write key (see Authz below).
 *
 * Authz (016 D4): `settings.renewal_schedules` holders only — admin +
 * super_admin. The design matrix pins "page open → denied (D4)" for
 * manager, retiring the pre-016 manager read-only view (016 post-ship
 * review finding #6 caught this file still promising it). The PUT route
 * at /api/admin/renewals/settings/schedules/[tierBucket] enforces the
 * same key (defence-in-depth). NOTE: API routes intentionally stayed at
 * /api/admin/renewals/* — only the UI page was relocated.
 *
 * Layout: wrapped in `<FormContainer>` (max-width 42rem) per
 * docs/ux-standards.md § 18 — settings/edit surfaces use form width
 * (matches sister `/admin/settings/invoicing`). Earlier draft used
 * `<DetailContainer>` (72rem) reasoning "5 tabs with form rows fit
 * better than 96rem" — but that compared against TableContainer not
 * FormContainer. The 42rem standard width is the right call.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  loadSchedulePolicies,
  makeRenewalsDeps,
  reminderStepToJson,
} from '@/modules/renewals';
import { ErrorCardActions } from '../../../renewals/_components/error-card-actions';
import {
  ScheduleEditor,
  type SchedulePolicyWire,
} from './_components/schedule-editor';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.settings.schedules');
  return { title: t('title'), description: t('subtitle') };
}

export default async function RenewalSchedulesSettingsPage() {
  const t = await getTranslations('admin.renewals.settings.schedules');
  await requirePagePermission('settings.renewal_schedules');

  if (!env.features.f8Renewals) {
    const tShared = await getTranslations('admin.renewals');
    return (
      <FormContainer>
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
      </FormContainer>
    );
  }

  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/settings/renewals/schedules`,
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
      <FormContainer>
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
              pendingLabel={tShared('error.retrying')}
              retryFailedLabel={tShared('error.retryFailed')}
              goBackLabel={tShared('error.goBack')}
              referenceLabel={tShared('error.referenceLabel')}
            />
          </CardContent>
        </Card>
      </FormContainer>
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
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {/*
        016 post-ship review finding #6 — `readOnly` was computed as
        `!canPerform(role, 'settings.renewal_schedules')`, provably
        constant-false one line after a same-key requirePagePermission:
        dead code that implied a manager read-only view D4 retired.
        Hard-code false; the editor KEEPS its read-only mode (banner,
        disabled controls, i18n) so a future design amendment that
        re-admits a read tier only has to change this page's key pair.
      */}
      <ScheduleEditor initialPolicies={initialPolicies} readOnly={false} />
    </FormContainer>
  );
}
