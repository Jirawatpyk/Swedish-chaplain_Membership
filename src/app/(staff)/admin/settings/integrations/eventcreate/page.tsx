/**
 * /admin/settings/integrations/eventcreate page (F6 Phase 5 / US3).
 *
 * Server component — loads the integration config view via
 * `runLoadIntegrationConfig` and renders the 3-phase progressive
 * disclosure wizard (`<WebhookConfigWizard>`).
 *
 * Authz:
 *   - admin only — manager + member return 404 (FR-035 surface
 *     disclosure; the existence of secret-bearing surfaces is
 *     itself sensitive).
 *   - kill-switch off → 404
 *
 * Path note (Phase 5 verify-fix 2026-05-13): route moved from
 * `/admin/integrations/eventcreate` (Phase 4 placeholder origin) to
 * `/admin/settings/integrations/eventcreate` so the breadcrumb
 * (URL-derived) matches the sidebar grouping under Settings ("the
 * wizard IS a setting" per stakeholder review). API routes stay at
 * `/api/admin/integrations/eventcreate/**` — page and API namespaces
 * are decoupled. Phase 4 placeholder REPLACED in-place by T080.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runLoadIntegrationConfig } from '@/lib/events-admin-integration-deps';
import { deriveWebhookBaseUrlFromHeaders } from '@/app/api/admin/integrations/eventcreate/_lib/role-violation-audit';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { WebhookConfigWizard } from '@/components/events/webhook-config-wizard';
import { ZapierWalkthrough } from '@/components/events/zapier-walkthrough';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.integrations.eventcreate');
  return { title: t('page.title') };
}

interface PageProps {
  readonly searchParams: Promise<{ includeTestDeliveries?: string }>;
}

export default async function EventCreateIntegrationPage({
  searchParams,
}: PageProps) {
  if (!env.features.f6EventCreate) {
    notFound();
  }

  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') {
    notFound();
  }

  const h = await headers();
  const tenantCtx = resolveTenantFromHeaders(h);

  // Round-6 verify-fix 2026-05-13 (H4) — derive webhook base URL via
  // the allowlisted helper so a spoofed Host header on staging /
  // preview cannot render a webhook URL pointing at an attacker host.
  // Falls back to `APP_BASE_URL` on off-allowlist Host + logs a warn.
  const proto = h.get('x-forwarded-proto');
  const host = h.get('host') ?? h.get('x-forwarded-host');
  const webhookBaseUrl = deriveWebhookBaseUrlFromHeaders(proto, host);

  const params = await searchParams;
  const includeTestDeliveries = params.includeTestDeliveries === 'true';

  let view: Awaited<ReturnType<typeof runLoadIntegrationConfig>>;
  try {
    view = await runLoadIntegrationConfig(tenantCtx.slug, {
      includeTestDeliveries,
      webhookBaseUrl,
    });
  } catch (e) {
    logger.error(
      {
        event: 'f6_load_integration_config_page_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] integration config page render — runLoadIntegrationConfig threw',
    );
    notFound();
  }

  const t = await getTranslations('admin.integrations.eventcreate.page');

  // Round-6 verify-fix 2026-05-13 (type-design C4) — narrow on the
  // `secretConfigured` discriminant; the wizard receives the entire
  // view + walks the same union internally. Eliminates the previous
  // `{...(secretLastFour !== undefined ? ...)}` ternary spread which
  // could compile with mismatched fields under the old flat-bag
  // interface.
  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <WebhookConfigWizard
        view={view}
        walkthrough={<ZapierWalkthrough webhookUrl={view.webhookUrl} />}
      />
    </FormContainer>
  );
}
