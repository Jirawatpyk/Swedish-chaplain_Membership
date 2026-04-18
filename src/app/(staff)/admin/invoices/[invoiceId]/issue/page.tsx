/**
 * T056 — /admin/invoices/[invoiceId]/issue confirm page.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { IssueConfirmDialog } from '../../_components/issue-confirm-dialog';

export default async function IssueInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.issue');
  await requireSession('staff');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!result.ok) return notFound();
  const invoice = result.value;
  if (invoice.status !== 'draft') {
    // Already-issued invoices redirect back to detail.
    const { redirect } = await import('next/navigation');
    redirect(`/admin/invoices/${invoice.invoiceId}`);
  }

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent className="p-6">
          <IssueConfirmDialog invoiceId={invoice.invoiceId} />
          <div className="mt-6">
            <Link
              href={`/admin/invoices/${invoice.invoiceId}`}
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('cancel')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
