/**
 * T080 — /admin/invoices/[invoiceId]/credit-notes/new (F4 / US6).
 *
 * Admin-only form to issue a credit note against a paid or
 * partially-credited invoice. Refuses if the invoice is in any other
 * status (draft / issued / void / credited) — the server-side
 * use-case guards the same transition, this page just fails fast at
 * the UI layer so admins don't see a form that will always 409.
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
import { CreditNoteForm } from './_components/credit-note-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.new');
  return { title: t('title') };
}

export default async function NewCreditNotePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const t = await getTranslations('admin.creditNotes.new');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const invoiceResult = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!invoiceResult.ok) notFound();
  const invoice = invoiceResult.value;

  // Only paid + partially_credited can be further credited. The
  // use-case enforces the same; this is the fail-fast UI guard.
  if (invoice.status !== 'paid' && invoice.status !== 'partially_credited') {
    notFound();
  }
  if (!invoice.total || !invoice.documentNumber) notFound();

  const remainingSatang = (
    invoice.total.satang - invoice.creditedTotal.satang
  ).toString();

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent>
          <CreditNoteForm
            invoiceId={invoiceId}
            documentNumber={invoice.documentNumber.raw}
            remainingSatang={remainingSatang}
            currencySymbol="THB"
          />
        </CardContent>
      </Card>
      <Link
        href={`/admin/invoices/${invoiceId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t('backToInvoice')}
      </Link>
    </FormContainer>
  );
}
