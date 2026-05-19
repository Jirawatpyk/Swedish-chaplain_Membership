/**
 * T075 (F7.1a US2) — Admin broadcast settings page.
 *
 * Route: `/admin/broadcasts/settings`
 *
 * Currently houses a single section: image-source allowlist editor
 * (FR-010 + FR-015). Future F7.1a / F7.1b sections will live here too
 * (attachment-source allowlist, marketing-consent toggle, etc).
 *
 * Authz: admin (manager not allowed — modifying the allowlist is a
 * privileged surface; manager can read but cannot mutate). When the
 * F71A US2 flag is OFF, the route returns notFound() so admins can't
 * stumble onto an empty form during dark rollout.
 *
 * Tenant scoping: `resolveTenantFromRequest()` + `runInTenant()` —
 * same pattern as the F7 admin queue page (admin/broadcasts/page.tsx).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  AdminImageAllowlistEditor,
  type AllowlistRow,
} from '@/components/broadcast/admin-image-allowlist-editor';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { seedPlatformDefaults } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runInTenant } from '@/lib/db';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.settings');
  return { title: t('pageTitle') };
}

export default async function AdminBroadcastSettingsPage(): Promise<React.ReactElement> {
  if (!isF71aUs2Enabled()) notFound();

  // Admin role mandatory (manager has read-only on broadcasts queue
  // but mutating allowlist is privileged — keep parity with F4 logo
  // upload + F2 plan management restrictions).
  const session = await requireSession('staff');
  if (session.user.role !== 'admin') notFound();

  const tenantCtx = resolveTenantFromRequest();
  const t = await getTranslations('admin.broadcasts.settings');

  const rows: readonly AllowlistRow[] = await runInTenant(
    tenantCtx,
    async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      // C1 fix (verify-run 2026-05-20) — seed platform-mandated default
      // hosts (resend.com etc.) on every page visit so the admin sees a
      // non-empty allowlist row set on first contact with the surface.
      // Idempotent at storage layer via ON CONFLICT DO NOTHING.
      await seedPlatformDefaults(repo, tenantCtx.slug as never);
      const entries = await repo.findByTenantId(tenantCtx.slug as never);
      return entries.map((e) => ({
        hostname: e.hostname as string,
        isDefault: e.isDefault,
      }));
    },
  );

  return (
    <FormContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <AdminImageAllowlistEditor initial={rows} />
    </FormContainer>
  );
}
