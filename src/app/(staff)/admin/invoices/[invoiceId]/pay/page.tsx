/**
 * T066 — /admin/invoices/[invoiceId]/pay — record-payment form.
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
import { PaymentForm } from '../../_components/payment-form';

export default async function RecordPaymentPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.pay');
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

  if (invoice.status !== 'issued') {
    return (
      <FormContainer>
        <PageHeader title={t('title')} subtitle={t('errors.invalidStatus', { status: invoice.status })} />
        <Link href={`/admin/invoices/${invoice.invoiceId}`} className="text-sm underline">
          ← {t('cancel')}
        </Link>
      </FormContainer>
    );
  }

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent className="p-6">
          <PaymentForm invoiceId={invoice.invoiceId} documentNumber={invoice.documentNumber?.raw ?? null} />
        </CardContent>
      </Card>
      <div className="mt-4">
        <Link href={`/admin/invoices/${invoice.invoiceId}`} className="text-sm text-muted-foreground hover:underline">
          ← {t('cancel')}
        </Link>
      </div>
    </FormContainer>
  );
}
