/**
 * G-3 — /admin/credit-notes directory page.
 *
 * Tenant-scoped list of every credit note issued against any of the
 * tenant's invoices. Closes the discoverability gap where admins
 * with a CN document number (e.g. bookkeeper query) had no UI
 * search path — previously only reachable per-invoice.
 *
 * Pattern mirrors the sibling `/admin/invoices` list:
 *   - TableContainer (96rem) per docs/ux-standards.md § 18
 *   - Offset pagination (server-rendered; 50 rows/page)
 *   - Filters: fiscal year (exact) + document-number search
 *     (case-insensitive substring)
 *   - Per-row actions: View + Download PDF
 *
 * RBAC: `requireSession('staff')` admits admin + manager. Manager is
 * finance-read per CLAUDE.md and the list is read-only so no extra
 * gate is needed.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowUpRightIcon, DownloadIcon, EyeIcon } from 'lucide-react';

import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { listCreditNotes, makeListCreditNotesDeps } from '@/modules/invoicing';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { CreditNoteFilters } from './_components/credit-note-filters';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.list.meta');
  return { title: t('title') };
}

const PAGE_SIZE = 50;

function formatSatang(sRaw: string): string {
  // Same deterministic formatter the invoice list uses — pinned
  // `'en-US'` locale per FR-005 for tax-amount display
  // consistency across surfaces.
  const n = BigInt(sRaw);
  const abs = n < 0n ? -n : n;
  const sign = n < 0n ? '-' : '';
  return `${sign}${(abs / 100n).toLocaleString('en-US')}.${(abs % 100n).toString().padStart(2, '0')}`;
}


export default async function AdminCreditNotesDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession('staff');
  // Manager is read-only finance — allowed. Member / unauth blocked
  // by requireSession / layout.
  if (user.role !== 'admin' && user.role !== 'manager') notFound();

  const t = await getTranslations('admin.creditNotes.list');
  const tCommon = await getTranslations('shared');
  const locale = await getLocale();
  const sp = await searchParams;

  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const qRaw = typeof sp.q === 'string' ? sp.q.trim() : '';
  const fyRaw = typeof sp.fy === 'string' ? Number.parseInt(sp.fy, 10) : NaN;
  const fiscalYear =
    Number.isFinite(fyRaw) && fyRaw >= 2020 && fyRaw <= 2100 ? fyRaw : undefined;
  const hasFilters = qRaw.length > 0 || fiscalYear !== undefined;

  const pageRaw = typeof sp.page === 'string' ? Number.parseInt(sp.page, 10) : 1;
  const page =
    Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const result = await listCreditNotes(makeListCreditNotesDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    offset,
    pageSize: PAGE_SIZE,
    ...(fiscalYear !== undefined ? { fiscalYear } : {}),
    ...(qRaw.length > 0 ? { search: qRaw } : {}),
  });
  const rows = result.ok ? result.value.rows : [];
  const total = result.ok ? result.value.total : 0;

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent className="flex flex-col gap-6">
          <CreditNoteFilters />
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                {hasFilters ? t('filteredEmpty') : t('empty')}
              </p>
              {hasFilters && (
                <Link
                  href="/admin/credit-notes"
                  className={buttonVariants({
                    variant: 'outline',
                    className: 'mt-4',
                  })}
                >
                  {t('actions.clearFilters')}
                </Link>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.documentNumber')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.issueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.originalInvoice')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.member')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.reason')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.total')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="w-[1%] text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        <span className="sr-only">{t('columns.actions')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.creditNoteId}>
                        <TableCell className="font-mono font-medium">
                          <Link
                            href={`/admin/credit-notes/${r.creditNoteId}`}
                            className="hover:underline"
                          >
                            {r.documentNumberRaw}
                          </Link>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatTaxDocDate(r.issueDate, locale)}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {r.originalInvoiceNumberRaw ? (
                            <Link
                              href={`/admin/invoices/${r.originalInvoiceId}`}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {r.originalInvoiceNumberRaw}
                              <ArrowUpRightIcon
                                className="size-3.5 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{r.memberLegalName}</TableCell>
                        <TableCell
                          className="max-w-[18rem] truncate"
                          title={r.reason}
                        >
                          {r.reason}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatSatang(r.totalSatang)}{' '}
                          <span className="text-muted-foreground">THB</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Link
                              href={`/admin/credit-notes/${r.creditNoteId}`}
                              className={buttonVariants({
                                variant: 'secondary',
                                size: 'sm',
                              })}
                              aria-label={t('actions.viewAria', {
                                number: r.documentNumberRaw,
                              })}
                            >
                              <EyeIcon className="size-4" aria-hidden="true" />
                              {t('actions.view')}
                            </Link>
                            <a
                              href={`/api/credit-notes/${r.creditNoteId}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              download
                              className={buttonVariants({
                                variant: 'outline',
                                size: 'sm',
                              })}
                              aria-label={t('actions.pdfAria', {
                                number: r.documentNumberRaw,
                              })}
                            >
                              <DownloadIcon
                                className="size-4"
                                aria-hidden="true"
                              />
                              {t('actions.pdf')}
                            </a>
                          </div>
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
                baseHref="/admin/credit-notes"
              />
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only" role="status" aria-live="polite">
        {tCommon('loaded')}
      </span>
    </TableContainer>
  );
}
