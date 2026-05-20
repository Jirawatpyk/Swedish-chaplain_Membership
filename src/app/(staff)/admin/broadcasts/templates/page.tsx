/**
 * Admin broadcast templates list (admin-only + flag-gated).
 *
 * Route: `/admin/broadcasts/templates`. Renders <AdminTemplateLibrary>
 * with filter pills (Starter / Admin-authored / All) + per-row Edit
 * link. Delete is performed via PATCH/DELETE on /api/admin/broadcasts/
 * templates/[id] (no in-list AlertDialog confirmation yet — backlog).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LayoutTemplate } from 'lucide-react';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  AdminTemplateLibrary,
  type TemplateLibraryRow,
} from '@/components/broadcast/admin/template-library';
import {
  isF71aUs7Enabled,
  listBroadcastTemplates,
  makeListBroadcastTemplatesDeps,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.templates');
  return { title: t('pageTitle') };
}

export default async function AdminBroadcastTemplatesPage(): Promise<React.ReactElement> {
  if (!isF71aUs7Enabled()) notFound();

  const session = await requireSession('staff');
  if (session.user.role !== 'admin') notFound();

  const tenantCtx = resolveTenantFromRequest();
  const t = await getTranslations('admin.broadcasts.templates');

  const templates = await runInTenant(tenantCtx, async () =>
    listBroadcastTemplates(makeListBroadcastTemplatesDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug as never,
      includeAllLocales: true,
    }),
  );

  const rows: readonly TemplateLibraryRow[] = templates.map((tpl) => ({
    id: tpl.id,
    name: tpl.name,
    locale: tpl.locale,
    startedFromCount: tpl.startedFromCount,
    isSeeded: tpl.isSeeded,
    // Serialise to ISO at the server boundary — client component only
    // needs the YYYY-MM-DD prefix for display, never a Date instance.
    updatedAtIso: tpl.updatedAt.toISOString(),
  }));

  return (
    <TableContainer>
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('pageDescription')}
        actions={
          <Link
            href="/admin/broadcasts/templates/new"
            className={buttonVariants()}
          >
            {t('newTemplateButton')}
          </Link>
        }
      />

      {rows.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <LayoutTemplate
              className="size-12 text-muted-foreground"
              aria-hidden="true"
            />
            <CardTitle>{t('emptyState.title')}</CardTitle>
            <CardDescription className="max-w-md mx-auto">
              {t('emptyState.body')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-6">
            <Link
              href="/admin/broadcasts/templates/new"
              className={buttonVariants()}
            >
              {t('emptyState.cta')}
            </Link>
          </CardContent>
        </Card>
      ) : (
        <AdminTemplateLibrary rows={rows} />
      )}
    </TableContainer>
  );
}
