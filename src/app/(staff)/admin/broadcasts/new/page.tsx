/**
 * DV-4 — /admin/broadcasts/new admin proxy-compose page.
 *
 * Admin-only surface for composing + queueing a broadcast on a member's
 * behalf (Q12). The proxy-submit route enforces admin-only at the API
 * level; this page guard prevents manager (and member) from *seeing* the
 * compose surface. `requireSession('staff')` admits both admin + manager,
 * so the explicit `role !== 'admin' → notFound()` is required to exclude
 * manager (mirrors `admin/members/new/page.tsx`).
 */

import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';
import { loadComposeTemplateOptions } from '@/lib/broadcast-template-options';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { currentAudienceCeiling, isF71aUs7Enabled } from '@/modules/broadcasts';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return { title: t('title') };
}

export default async function AdminProxyComposePage(): Promise<React.ReactElement> {
  const session = await requirePagePermission('broadcasts.write');

  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');

  // F119 T145 (FR-039) — the same templates the member compose screen offers,
  // behind the same flag. The helper swallows and logs its own failures, so a
  // template-list outage costs the picker, never the compose surface.
  const tenant = resolveTenantFromRequest();
  const locale = ((await getLocale()) as 'en' | 'th' | 'sv') ?? 'en';
  const templates = isF71aUs7Enabled()
    ? await loadComposeTemplateOptions(tenant, locale, session.user.id)
    : [];

  return (
    // F119 T148 (FR-050) — 72 rem, not the 42 rem form tier: editor beside the
    // 600 px email preview from `lg` up. Exception in ux-standards § 18.2.
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('pageSubtitle')} />
      {/* Round 2 (i18n H4): the same ceiling the member page resolves — the
          fallback for the too-large copy when a 422 body carries no cap. */}
      <ProxyComposeForm
        audienceCeiling={currentAudienceCeiling()}
        templates={templates}
      />
    </DetailContainer>
  );
}
