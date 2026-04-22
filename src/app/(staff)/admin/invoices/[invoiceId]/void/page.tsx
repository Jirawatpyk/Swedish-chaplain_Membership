/**
 * T102 — /admin/invoices/[invoiceId]/void (F4 / US5 Phase 9).
 *
 * Admin-only confirm surface for voiding an issued-unpaid invoice.
 * Refuses if the invoice is in any other status — the server-side
 * use-case guards the same transition; this page fails fast so admins
 * never see a form that would always 409.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { VoidConfirmDialog } from './_components/void-confirm-dialog';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.void');
  return { title: t('title') };
}

export default async function VoidInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const t = await getTranslations('admin.invoices.void');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const invoiceResult = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!invoiceResult.ok) notFound();
  const invoice = invoiceResult.value;

  // Only `issued` is voidable. `paid` → direct to credit-note (US6);
  // everything else is terminal or pre-issue.
  if (invoice.status !== 'issued') notFound();
  if (!invoice.documentNumber) notFound();

  return (
    <FormContainer>
      {/* UX-5 — back-link above the form card so the escape route is
        * visible without scrolling past the destructive button. */}
      <Link
        href={`/admin/invoices/${invoiceId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t('backToInvoice')}
      </Link>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent>
          <VoidConfirmDialog
            invoiceId={invoiceId}
            documentNumber={invoice.documentNumber.raw}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
