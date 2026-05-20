/**
 * T106 (F7.1a US7) — Admin edit broadcast template page.
 *
 * Route: `/admin/broadcasts/templates/[id]/edit`. Admin-only + flag-
 * gated. Loads the template via runInTenant + RLS-confined findById
 * (null → notFound).
 *
 * When the loaded template has `is_seeded=TRUE`, surfaces a banner
 * explaining the consequence of editing a starter (FR-021 + critique
 * P6). Banner is currently inline; richer dismissible version lands
 * at Phase 5H T114 (`admin-template-edit-confirm-starter` component).
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
import { AdminTemplateForm } from '@/components/broadcast/admin/template-form';
import {
  isF71aUs7Enabled,
  makeListBroadcastTemplatesDeps,
} from '@/modules/broadcasts';
import { makeDrizzleBroadcastTemplatesRepo } from '@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo';
import { runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.templates');
  return { title: t('editPageTitle') };
}

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function AdminBroadcastEditTemplatePage({
  params,
}: RouteParams): Promise<React.ReactElement> {
  if (!isF71aUs7Enabled()) notFound();

  const session = await requireSession('staff');
  if (session.user.role !== 'admin') notFound();

  const { id } = await params;
  const tenantCtx = resolveTenantFromRequest();
  const t = await getTranslations('admin.broadcasts.templates');

  // findById is RLS-confined — null for cross-tenant probes OR
  // genuine not-found OR soft-deleted templates.
  // Note: makeListBroadcastTemplatesDeps wraps the same repo factory
  // we want here; could split into a make...Deps for findById but
  // this single-call boundary doesn't justify the indirection yet.
  void makeListBroadcastTemplatesDeps; // satisfy module reference
  const template = await runInTenant(tenantCtx, async () => {
    const repo = makeDrizzleBroadcastTemplatesRepo();
    return repo.findById(tenantCtx.slug as never, id);
  });
  if (!template) notFound();

  return (
    <FormContainer>
      <PageHeader
        title={t('editPageTitle')}
        subtitle={t('editPageDescription')}
      />

      {template.isSeeded ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm"
        >
          <p className="font-medium">{t('starterEditBannerTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            {t('starterEditBannerBody')}
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{template.name}</CardTitle>
          <CardDescription>{t('editPageDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminTemplateForm
            mode="edit"
            initial={{
              templateId: template.id,
              name: template.name,
              subject: template.subject,
              bodyHtml: template.bodyHtml,
              locale: template.locale,
              isSeeded: template.isSeeded,
            }}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
