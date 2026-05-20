/**
 * T104 (F7.1a US7) — Admin broadcast templates list page.
 *
 * Route: `/admin/broadcasts/templates`.
 * Authz: admin-only (manager has read-only on the broadcasts queue;
 * template CRUD is privileged, mirrors US2 allowlist scope).
 * Dark-rollout via `isF71aUs7Enabled()` — returns notFound() when OFF.
 *
 * Lean MVP — semantic <table> + "New template" button + Starter badge
 * + Edit link per row. Delete action lands at Phase 5H (T114
 * admin-template-edit-confirm-starter + AlertDialog primitive). Filter
 * pills (Starter / Admin-authored / All) also Phase 5H.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
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

  return (
    <TableContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <div className="flex items-center justify-end mb-4">
        <Link
          href="/admin/broadcasts/templates/new"
          className={buttonVariants()}
        >
          {t('newTemplateButton')}
        </Link>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyState.title')}</CardTitle>
            <CardDescription>{t('emptyState.body')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full border-collapse">
              <caption className="sr-only">{t('pageTitle')}</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="text-left p-3">
                    {t('columns.name')}
                  </th>
                  <th scope="col" className="text-left p-3">
                    {t('columns.locale')}
                  </th>
                  <th
                    scope="col"
                    className="text-right p-3 hidden sm:table-cell"
                    aria-label={t('columns.startedFromAria')}
                  >
                    {t('columns.startedFrom')}
                  </th>
                  <th
                    scope="col"
                    className="text-left p-3 hidden md:table-cell"
                  >
                    {t('columns.updatedAt')}
                  </th>
                  <th scope="col" className="sr-only">
                    {t('columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => (
                  <tr key={tpl.id} className="border-b last:border-b-0">
                    <td className="p-3">
                      <span className="font-medium">{tpl.name}</span>
                      {tpl.isSeeded ? (
                        <span
                          className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-caption bg-muted text-muted-foreground"
                          aria-label={t('starterBadgeAria')}
                        >
                          {t('starterBadge')}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-3 text-caption text-muted-foreground">
                      {t(`locale.${tpl.locale}`)}
                    </td>
                    <td className="p-3 text-right hidden sm:table-cell tabular-nums">
                      {tpl.startedFromCount}
                    </td>
                    <td className="p-3 text-caption text-muted-foreground hidden md:table-cell">
                      {tpl.updatedAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="p-3 text-right">
                      <Link
                        href={`/admin/broadcasts/templates/${tpl.id}/edit`}
                        className={buttonVariants({
                          variant: 'ghost',
                          size: 'sm',
                        })}
                        aria-label={t('rowAction.editAria', {
                          name: tpl.name,
                        })}
                      >
                        {t('rowAction.edit')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </TableContainer>
  );
}
