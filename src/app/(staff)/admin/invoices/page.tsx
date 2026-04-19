/**
 * T056 / T057 — /admin/invoices list page.
 *
 * Server Component — parses URL filters (q, status, page) + calls
 * `listInvoicesPaged` with offset pagination so we can render a proper
 * numbered `<TablePagination />` (parity with members directory).
 * Default filter excludes drafts (R2-P2); `?status=draft` opts in.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { PlusIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { InvoicesTable, type InvoicesTableRow } from './_components/invoice-table';
import { InvoiceFilters } from './_components/invoice-filters';

const VALID_STATUSES = new Set([
  'draft',
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
  'partially_credited',
]);

const PAGE_SIZE = 50;

interface SearchParams {
  readonly q?: string;
  readonly status?: string;
  readonly page?: string;
}

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const t = await getTranslations('admin.invoices');
  const tShared = await getTranslations('shared');
  const query = await searchParams;

  await requireSession('staff');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const qTrim = query.q?.trim();
  const statusFilter =
    query.status && VALID_STATUSES.has(query.status) ? query.status : undefined;
  const includeDrafts = statusFilter === 'draft';
  const hasFilters = Boolean(qTrim) || Boolean(statusFilter);

  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const [invoicesResult, membersResult] = await Promise.all([
    listInvoicesPaged(makeListInvoicesDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      offset,
      pageSize: PAGE_SIZE,
      includeDrafts,
      ...(statusFilter && statusFilter !== 'draft'
        ? { status: statusFilter as 'issued' | 'paid' | 'void' | 'credited' | 'partially_credited' }
        : {}),
      ...(qTrim ? { search: qTrim } : {}),
    }),
    directorySearch(
      { tenant: tenantCtx, memberRepo: buildMembersDeps(tenantCtx).memberRepo },
      { status: ['active', 'inactive', 'archived'], limit: 100 },
    ),
  ]);

  const memberNameById = new Map<string, string>();
  if (membersResult.ok) {
    for (const row of membersResult.value.items) {
      memberNameById.set(row.member.memberId, row.member.companyName);
    }
  }

  const rows: InvoicesTableRow[] = invoicesResult.ok
    ? invoicesResult.value.rows.map((r) => ({
        invoiceId: r.invoiceId,
        documentNumber: r.documentNumber?.raw ?? '—',
        status: r.status,
        memberId: r.memberId,
        memberName: memberNameById.get(r.memberId) ?? '—',
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        totalSatang: r.total?.satang.toString() ?? '0',
        hasPdf: Boolean(r.pdfBlobKey),
      }))
    : [];

  const total = invoicesResult.ok ? invoicesResult.value.total : 0;

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
        <CardContent className="flex flex-col gap-4">
          <InvoiceFilters />
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                {hasFilters ? t('list.filteredEmpty') : t('list.empty')}
              </p>
              {!hasFilters && (
                <Link
                  href="/admin/invoices/new"
                  className={buttonVariants({ variant: 'default', className: 'mt-4' })}
                >
                  {t('list.actions.new')}
                </Link>
              )}
            </div>
          ) : (
            <>
              <InvoicesTable rows={rows} />
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                baseHref="/admin/invoices"
              />
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}
