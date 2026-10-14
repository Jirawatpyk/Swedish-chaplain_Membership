/**
 * F114 US6 (T099; FR-031, FR-032, FR-039; research R11) — the per-tenant
 * member-change approval setting at `/admin/settings/member-changes`.
 *
 * Platform flag OFF → `notFound()` (dark ship: flag first, then setting).
 * Gate: `members.write` — the same key the API route behind the switch
 * requires; a manager / marketing user neither sees the hub card nor opens
 * this page. Reads the tenant row (absent = the new-tenant default, off)
 * and the pending count the switch-off confirmation names; a repo failure
 * reaches the error boundary rather than rendering a switch that asserts
 * "off" about a setting we could not read.
 *
 * Spec 122 US10c (T1024; board `Admin-settings-member-changes`): one AURA
 * card titled "Approval requirement" (h2) holding the switch.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@jirawatpyk/aura-react/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { requirePagePermission } from '@/lib/rbac';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { countPendingChangeRequests } from '@/modules/members';
import { ApprovalSwitch } from './_components/approval-switch';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.settings.memberChanges');
  return { title: t('pageTitle') };
}

export default async function MemberChangesSettingsPage(): Promise<React.ReactElement> {
  if (!env.features.memberChangeApproval) notFound();
  await requirePagePermission('members.write');
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const requestId = requestIdFromHeaders(h);
  const deps = buildChangeRequestDeps(tenant);
  const t = await getTranslations('admin.settings.memberChanges');

  // A read failure must reach the error boundary — a switch rendered from a
  // row we could not read would assert "off" about a tenant that may be on.
  const fail: (arm: string, code: string) => never = (arm, code) => {
    logger.error(
      { errorId: `M114.admin.setting_page.${arm}`, requestId, tenantId: tenant.slug, err: code },
      'member-changes.settings page: read failed',
    );
    throw new Error('member-changes.settings: load failed');
  };

  const row = await deps.tenantMemberChangeSettings.readInTenant(tenant);
  if (!row.ok) fail('settings_read_failed', row.error.code);
  const pending = await countPendingChangeRequests(deps);
  if (!pending.ok) fail('pending_count_failed', pending.error.message);

  return (
    <FormContainer align="start">
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <Card title={t('title')} description={t('cardDescription')} headingLevel={2}>
        <ApprovalSwitch
          // no row yet = the new-tenant default (off, FR-031)
          initialEnabled={row.value?.memberChangeApprovalEnabled === true}
          pendingCount={pending.value.count}
        />
      </Card>
    </FormContainer>
  );
}
