/**
 * T105 (F7.1a US7) — Admin new broadcast template page.
 *
 * Route: `/admin/broadcasts/templates/new`. Admin-only + isF71aUs7-
 * Enabled-gated (notFound when off).
 *
 * Hosts <AdminTemplateForm mode="new"> client component which POSTs
 * to /api/admin/broadcasts/templates and routes back to the list on
 * success.
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
import { isF71aUs7Enabled } from '@/modules/broadcasts';
import { requireSession } from '@/lib/auth-session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.templates');
  return { title: t('newPageTitle') };
}

export default async function AdminBroadcastNewTemplatePage(): Promise<React.ReactElement> {
  if (!isF71aUs7Enabled()) notFound();

  const session = await requireSession('staff');
  if (session.user.role !== 'admin') notFound();

  const t = await getTranslations('admin.broadcasts.templates');

  return (
    <FormContainer>
      <PageHeader
        title={t('newPageTitle')}
        subtitle={t('newPageDescription')}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t('newPageTitle')}</CardTitle>
          <CardDescription>{t('newPageDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminTemplateForm
            mode="new"
            initial={{ name: '', subject: '', bodyHtml: '', locale: 'en' }}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
