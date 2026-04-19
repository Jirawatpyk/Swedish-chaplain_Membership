/**
 * R7-B3 — /portal/invoices (F4 US3).
 *
 * Member self-service view of their company's invoices. Scoped via
 * `requireSession('member')` + member lookup by linked user id; the
 * `listInvoicesPaged` call passes `memberId` so RLS + application
 * filters together never leak a sibling company's documents.
 *
 * US3 AS1 — member with 3 invoices sees 3 rows (status, amount,
 * issue/due/paid dates, download button).
 * US3 AS2 — cross-tenant URL attempt → RLS hides the invoice; 404
 * with probe audit emitted by `getInvoicePdfSignedUrl` on download.
 * US3 AS3 — member with 0 invoices → friendly empty state.
 *
 * PDF download goes through `/api/portal/invoices/[id]/pdf` (byte-
 * streamed, never exposes Blob URL — same B1 pattern as admin).
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

interface SearchParams {
  readonly page?: string;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invoices');
  return { title: t('title') };
}

function formatSatangThb(satang: bigint | null): string {
  if (satang === null) return '—';
  const whole = satang / 100n;
  const rem = satang % 100n;
  // N11 — explicit locale pins output on server runtimes whose
  // process locale defaults to `C`. FR-005.
  return `${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')} THB`;
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type InvoiceStatusBadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';
function statusBadgeVariant(status: string): InvoiceStatusBadgeVariant {
  switch (status) {
    case 'paid':
      return 'default';
    case 'issued':
      return 'secondary';
    case 'overdue':
      return 'destructive';
    default:
      return 'outline';
  }
}

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const locale = (await import('next-intl/server')).getLocale;
  const userLocale = await locale();

  const tenantCtx = resolveTenantFromRequest();
  const memberDeps = buildMembersDeps(tenantCtx);

  // Resolve the member linked to this user — if none, surface the
  // "not linked" empty state instead of listing zero rows (which
  // would be indistinguishable from "member with no invoices").
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(
    tenantCtx,
    user.id,
  );
  if (!memberResult.ok) {
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{t('notLinked')}</p>
          </CardContent>
        </Card>
      </TableContainer>
    );
  }
  const member = memberResult.value;

  const query = await searchParams;
  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 1000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const invoicesResult = await listInvoicesPaged(
    makeListInvoicesDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      offset,
      pageSize: PAGE_SIZE,
      includeDrafts: false, // members never see drafts
      memberId: member.memberId,
    },
  );
  const rows = invoicesResult.ok ? invoicesResult.value.rows : [];
  const total = invoicesResult.ok ? invoicesResult.value.total : 0;

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">{t('empty')}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.documentNumber')}
                      </TableHead>
                      <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.status')}
                      </TableHead>
                      <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.issueDate')}
                      </TableHead>
                      <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.dueDate')}
                      </TableHead>
                      <TableHead scope="col" className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.total')}
                      </TableHead>
                      <TableHead scope="col" className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                        {t('columns.actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.invoiceId}>
                        <TableCell className="align-middle font-mono text-xs">
                          {r.documentNumber?.raw ?? '—'}
                        </TableCell>
                        <TableCell className="align-middle">
                          <Badge variant={statusBadgeVariant(r.status)}>
                            {tStatus(r.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(r.issueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(r.dueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle text-right tabular-nums">
                          {formatSatangThb(r.total?.satang ?? null)}
                        </TableCell>
                        <TableCell className="align-middle text-right">
                          {r.pdf ? (
                            <a
                              href={`/api/portal/invoices/${r.invoiceId}/pdf`}
                              aria-label={`${t('actions.download')} — ${r.documentNumber?.raw ?? r.invoiceId}`}
                              className={cn(
                                buttonVariants({ variant: 'ghost', size: 'sm' }),
                                'min-h-11 px-3',
                              )}
                              target="_blank"
                              rel="noopener noreferrer"
                              download
                            >
                              {t('actions.download')}
                            </a>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                baseHref="/portal/invoices"
              />
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{t('loaded')}</span>
    </TableContainer>
  );
}
