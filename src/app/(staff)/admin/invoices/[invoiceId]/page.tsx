/**
 * T056 — /admin/invoices/[invoiceId] detail page.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';

function isIssued(status: string): boolean {
  return status === 'issued';
}

function formatSatang(satang: bigint | null): string {
  if (!satang) return '—';
  const whole = satang / 100n;
  const rem = satang % 100n;
  return `${whole.toLocaleString()}.${rem.toString().padStart(2, '0')}`;
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.detail');
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

  const isDraft = invoice.status === 'draft';

  return (
    <DetailContainer>
      <PageHeader
        title={invoice.documentNumber?.raw ?? t('draftTitle')}
        subtitle={`${t('status')}: ${invoice.status}`}
        actions={
          <div className="flex gap-2">
            {isDraft && (
              <>
                <Link
                  href={`/api/invoices/${invoice.invoiceId}/preview`}
                  className={buttonVariants({ variant: 'secondary' })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('actions.preview')}
                </Link>
                <Link
                  href={`/admin/invoices/${invoice.invoiceId}/issue`}
                  className={buttonVariants({ variant: 'default' })}
                >
                  {t('actions.issue')}
                </Link>
              </>
            )}
            {invoice.status === 'issued' && (
              <Link
                href={`/admin/invoices/${invoice.invoiceId}/pay`}
                className={buttonVariants({ variant: 'default' })}
              >
                {t('actions.pay')}
              </Link>
            )}
            {!isDraft && invoice.pdfBlobKey && (
              <Link
                href={`/api/invoices/${invoice.invoiceId}/pdf`}
                className={buttonVariants({ variant: isIssued(invoice.status) ? 'secondary' : 'default' })}
              >
                {t('actions.download')}
              </Link>
            )}
          </div>
        }
      />
      <Card>
        <CardContent className="space-y-4 p-6">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('fields.memberId')}</dt>
              <dd>{invoice.memberId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.plan')}</dt>
              <dd>
                {invoice.planId} / {invoice.planYear}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
              <dd>{invoice.issueDate ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.dueDate')}</dt>
              <dd>{invoice.dueDate ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.subtotal')}</dt>
              <dd>{formatSatang(invoice.subtotal?.satang ?? null)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.vat')}</dt>
              <dd>{formatSatang(invoice.vat?.satang ?? null)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.total')}</dt>
              <dd className="font-semibold">{formatSatang(invoice.total?.satang ?? null)} THB</dd>
            </div>
          </dl>
          <section className="mt-6">
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">{t('lines.title')}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40">
                  <th className="p-2 text-left">{t('lines.description')}</th>
                  <th className="p-2 text-right">{t('lines.qty')}</th>
                  <th className="p-2 text-right">{t('lines.unit')}</th>
                  <th className="p-2 text-right">{t('lines.total')}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((l) => (
                  <tr key={l.lineId} className="border-t">
                    <td className="p-2">
                      <div>{l.descriptionTh}</div>
                      <div className="text-xs text-muted-foreground">{l.descriptionEn}</div>
                    </td>
                    <td className="p-2 text-right tabular-nums">{l.quantity}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatSatang(l.unitPrice.satang)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatSatang(l.total.satang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
