/**
 * Admin edit broadcast template page (admin-only + flag-gated).
 *
 * Route: `/admin/broadcasts/templates/[id]/edit`. Loads the template via
 * runInTenant + RLS-confined findById. Starter templates surface a
 * dismissible `<AdminTemplateEditConfirmStarter>` warning per FR-021 +
 * critique P6. Null findById emits `broadcast_cross_tenant_probe` audit
 * (R1.1 CRIT-2) before notFound() so cross-tenant enumeration via GET
 * leaves a forensic trail.
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
import { AdminTemplateEditConfirmStarter } from '@/components/broadcast/admin/template-edit-confirm-starter';
import { isF71aUs7Enabled } from '@/modules/broadcasts';
import { makeDrizzleBroadcastTemplatesRepo } from '@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo';
import { f7AuditAdapter } from '@/modules/broadcasts';
import { safeAuditEmit } from '@/modules/broadcasts/application/use-cases/_safe-audit-emit';
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
  const template = await runInTenant(tenantCtx, async () => {
    const repo = makeDrizzleBroadcastTemplatesRepo();
    return repo.findById(tenantCtx.slug as never, id);
  });
  if (!template) {
    // R1.1 CRIT-2: emit cross-tenant probe audit so SSR page render
    // path matches the API surface's audit coverage (Constitution I
    // sub-clause 4). safeAuditEmit so a transient audit-storage hiccup
    // does not 500 the admin's notFound flow.
    await safeAuditEmit(f7AuditAdapter, null, {
      eventType: 'broadcast_cross_tenant_probe',
      actorUserId: session.user.id,
      tenantId: tenantCtx.slug,
      summary: `Cross-tenant probe on template edit page render ${id}`,
      payload: {
        probedTenantId: tenantCtx.slug,
        probedTemplateId: id,
        resourceKind: 'template',
      },
      requestId: null,
    });
    notFound();
  }

  return (
    <FormContainer>
      <PageHeader
        title={t('editPageTitle')}
        subtitle={t('editPageDescription')}
      />

      {template.isSeeded ? (
        <AdminTemplateEditConfirmStarter
          templateId={template.id}
          templateName={template.name}
        />
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
