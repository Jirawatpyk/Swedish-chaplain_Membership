/**
 * T075 (F7.1a US2) — Admin broadcast settings page.
 *
 * Route: `/admin/settings/broadcasts` (centralised-settings IA — see
 * `src/config/nav.ts` for relocation rationale + breadcrumb impact).
 *
 * Authz: admin-only (manager has read-only on the broadcasts queue;
 * allowlist mutation is privileged, parity with F4 logo upload + F2
 * plan management). Dark-rollout via `isF71aUs2Enabled()` — returns
 * notFound() when flag is OFF.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  const tAllowlist = await getTranslations(
    'admin.broadcasts.settings.allowlist',
  );

  const rows: readonly AllowlistRow[] = await runInTenant(
    tenantCtx,
    async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      // Idempotent — platform-mandated defaults (resend.com etc.)
      // ensured on every visit so admins see a non-empty allowlist
      // on first contact. Storage uses ON CONFLICT DO NOTHING.
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
      <Card>
        <CardHeader>
          <CardTitle>{tAllowlist('heading')}</CardTitle>
          <CardDescription>{tAllowlist('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminImageAllowlistEditor initial={rows} />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
