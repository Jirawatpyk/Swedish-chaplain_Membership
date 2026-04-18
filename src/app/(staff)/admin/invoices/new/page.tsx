/**
 * T056 — /admin/invoices/new — create draft form.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { CreateDraftForm } from '../_components/invoice-form';

export default async function NewInvoiceDraftPage() {
  const t = await getTranslations('admin.invoices.new');
  await requireSession('staff');
  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent className="p-6">
          <CreateDraftForm />
        </CardContent>
      </Card>
      <div className="mt-4">
        <Link href="/admin/invoices" className="text-sm text-muted-foreground hover:underline">
          ← {t('cancel')}
        </Link>
      </div>
    </FormContainer>
  );
}
