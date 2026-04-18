/**
 * T056 / T057 — /admin/invoices list page.
 *
 * Server Component — calls listInvoices directly. Default filter
 * excludes drafts (R2-P2); Drafts tab + empty state live in the
 * client-side filter component (future polish).
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listInvoices, makeListInvoicesDeps } from '@/modules/invoicing';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { headers } from 'next/headers';
import { InvoicesTable, type InvoicesTableRow } from './_components/invoice-table';

export default async function AdminInvoicesPage() {
  const t = await getTranslations('admin.invoices');
  const tShared = await getTranslations('shared');

  await requireSession('staff');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await listInvoices(makeListInvoicesDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    pageSize: 50,
    includeDrafts: false,
  });

  const rows: InvoicesTableRow[] = result.ok
    ? result.value.rows.map((r) => ({
        invoiceId: r.invoiceId,
        documentNumber: r.documentNumber?.raw ?? '—',
        status: r.status,
        memberId: r.memberId,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        totalSatang: r.total?.satang.toString() ?? '0',
      }))
    : [];

  return (
    <TableContainer>
      <PageHeader
        title={t('list.title')}
        subtitle={t('list.description')}
        actions={
          <Link
            href="/admin/invoices/new"
            className={buttonVariants({ variant: 'default' })}
          >
            <PlusIcon className="size-4" />
            {t('list.actions.new')}
          </Link>
        }
      />
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-muted-foreground">{t('list.empty')}</p>
              <Link
                href="/admin/invoices/new"
                className={buttonVariants({ variant: 'default', className: 'mt-4' })}
              >
                {t('list.actions.new')}
              </Link>
            </div>
          ) : (
            <InvoicesTable rows={rows} />
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}
