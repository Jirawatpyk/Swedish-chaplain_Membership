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
import { getTranslations, getLocale } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
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
import Link from 'next/link';
import { AlertTriangle, Ban, CheckCircle2, Clock, FileText, type LucideIcon } from 'lucide-react';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from './_utils/format';
import { toInvoiceRowViewModel } from './_utils/invoice-row-view-model';
import { InvoiceFilters } from '@/app/(staff)/admin/invoices/_components/invoice-filters';
import { ResendInvoiceButton } from './_components/resend-invoice-button';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from './_components/portal-pdf-download-button';
import { CombinedReceiptHint } from './_components/combined-receipt-hint';

const PAGE_SIZE = 20;

const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

interface SearchParams {
  readonly page?: string;
  readonly q?: string;
  readonly status?: string;
}

type StatusFilter = 'all' | 'issued' | 'paid' | 'void' | 'credited' | 'partially_credited';

function parseStatusFilter(raw: string | undefined): StatusFilter {
  switch (raw) {
    case 'issued':
    case 'paid':
    case 'void':
    case 'credited':
    case 'partially_credited':
      return raw;
    default:
      return 'all';
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invoices');
  return { title: t('title') };
}

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const userLocale = await getLocale();

  const tenantCtx = resolveTenantFromRequest();
  const memberDeps = buildMembersDeps(tenantCtx);

  // Resolve the member linked to this user — if none, surface the
  // "not linked" empty state instead of listing zero rows (which
  // would be indistinguishable from "member with no invoices").
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(tenantCtx, user.id);
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
  const searchTerm = (query.q ?? '').trim().slice(0, 100);
  const statusFilter = parseStatusFilter(query.status);

  const invoicesResult = await listInvoicesPaged(makeListInvoicesDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    offset,
    pageSize: PAGE_SIZE,
    includeDrafts: false, // members never see drafts
    memberId: member.memberId,
    search: searchTerm.length > 0 ? searchTerm : undefined,
    status: statusFilter,
  });

  // R7-M3 — was: `invoicesResult.ok ? value.rows : []` (silent fallback).
  // Empty fallback is indistinguishable from "no invoices" — members
  // saw a clean empty state on backend failures (DB outage, RLS misconfig,
  // repo bug). Now we log the error AND render an explicit error card
  // with a retry affordance so operators see the diagnostic AND members
  // know to retry instead of assuming their account is empty.
  if (!invoicesResult.ok) {
    logger.warn(
      {
        tenantId: tenantCtx.slug,
        memberId: member.memberId,
        err: invoicesResult.error,
      },
      '[portal-invoices-list] listInvoicesPaged failed — rendering error state',
    );
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{t('loadFailed')}</p>
          </CardContent>
        </Card>
      </TableContainer>
    );
  }
  const rawRows = invoicesResult.value.rows;
  const total = invoicesResult.value.total;
  // T109 — presentation-only overdue derivation (FR-028). Each row's
  // view-model swaps `'issued'` for `'overdue'` (via `toInvoiceRowViewModel`,
  // which calls `computeIsOverdue` internally) when Bangkok-today has
  // passed dueDate. Audit emit is NOT done on portal list reads — the
  // admin surface handles that opportunistically to avoid multiplying
  // per-row inserts on self-service page loads.
  //
  // 060-member-portal-d4 — per-row presentation flags (displayStatus,
  // isCombinedPaid, showInvoice/showReceipt, receiptPending, resendable)
  // are derived ONCE here into a shared view-model so the desktop table
  // (below) and the upcoming mobile card list consume one source of
  // truth and can never drift apart.
  const nowUtcIso = new Date().toISOString();
  const rows = rawRows.map((r) => ({
    row: r,
    vm: toInvoiceRowViewModel(r, nowUtcIso),
  }));

  const hasActiveFilter = searchTerm.length > 0 || statusFilter !== 'all';

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Reuse the admin InvoiceFilters client component for
              UI parity (same shadcn Select, same debounced search,
              same X-clear affordance). The URL contract is identical
              — members just see a subset of statuses that return
              rows (drafts are always excluded at the use-case level). */}
          <InvoiceFilters />
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                {hasActiveFilter ? t('filters.noMatch') : t('empty')}
              </p>
            </div>
          ) : (
            <>
              {/* R8-M1-ux — dual-tone inset shadow signals horizontal
                  scroll on mobile (parity with admin table U-I4). The
                  portal list has 7 columns; without the cue, members
                  on phones miss the right-edge Total + Actions silently. */}
              <div className="overflow-x-auto shadow-[inset_-12px_0_8px_-12px_rgba(0,0,0,0.08)] dark:shadow-[inset_-12px_0_8px_-12px_rgba(255,255,255,0.10)]">
                <Table aria-label={t('title')}>
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
                        className="text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                      >
                        {t('columns.receiptNumber')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.status')}
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
                        {t('columns.dueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.total')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ row: r, vm }) => (
                      <TableRow key={vm.invoiceId}>
                        <TableCell className="align-middle font-mono text-xs">
                          <Link
                            href={`/portal/invoices/${vm.invoiceId}`}
                            className="underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                            aria-label={`${t('actions.viewDetail')} ${vm.documentNumber ?? vm.invoiceId}`}
                          >
                            {vm.documentNumber ?? '—'}
                          </Link>
                        </TableCell>
                        <TableCell className="align-middle whitespace-nowrap">
                          {vm.receiptNumber ? (
                            <span className="font-mono text-sm tabular-nums">
                              {vm.receiptNumber}
                            </span>
                          ) : r.status === 'paid' ? (
                            // Combined-mode = receipt reuses invoice number.
                            // Em-dash + InfoIcon affordance with min-h-6 hit
                            // area for WCAG 2.2 SC 2.5.8 (R5-UX-M2).
                            // F5R6+ — extracted to a Client Component
                            // wrapper because Tooltip.Trigger's `render`
                            // prop is a function; passing it from a Server
                            // Component to a Client Component throws the
                            // "Functions cannot be passed directly to
                            // Client Components" error under React 19 +
                            // Next.js 16 strict SC/CC boundaries.
                            <CombinedReceiptHint
                              ariaLabel={t('receiptNumberCombinedAria')}
                              tooltipText={t('receiptNumberCombinedTooltip')}
                            />
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="align-middle">
                          {(() => {
                            const Icon = STATUS_ICON_MAP[statusIconName(vm.displayStatus)];
                            return (
                              <Badge
                                variant={statusBadgeVariant(vm.displayStatus)}
                                className="inline-flex items-center gap-1"
                              >
                                <Icon className="size-3.5" aria-hidden="true" />
                                {tStatus(vm.displayStatus)}
                              </Badge>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(vm.issueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(vm.dueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle text-right tabular-nums">
                          {formatSatangThb(vm.total?.satang ?? null, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle text-right">
                          {(() => {
                            // 060-member-portal-d4 — per-row flags are now
                            // derived once into `vm` (toInvoiceRowViewModel)
                            // and shared with the upcoming mobile card list.
                            //
                            // Combined-paid rows: the invoice PDF *is*
                            // the receipt — hide the (now-stale) invoice
                            // anchor + show only "Receipt" so the legal
                            // §86/4+§105ทวิ document is what the member
                            // grabs. Separate-paid: show both.
                            // R7-M5 — async receipt-PDF gate: when the
                            // receipt is mid-render (`receiptPending`),
                            // surface a compact "preparing" affordance
                            // alongside any visible download button.
                            if (
                              !vm.showInvoice &&
                              !vm.showReceipt &&
                              !vm.receiptPending &&
                              r.pdf === null
                            ) {
                              return <span className="text-sm text-muted-foreground">—</span>;
                            }
                            return (
                              <div className="flex items-center justify-end gap-1">
                                {vm.resendable ? (
                                  <ResendInvoiceButton
                                    invoiceId={vm.invoiceId}
                                    documentNumber={vm.documentNumber ?? vm.invoiceId}
                                    variant="ghost"
                                    layout="compact"
                                    className="min-h-11 min-w-11"
                                  />
                                ) : null}
                                {vm.showInvoice && (
                                  <PortalInvoiceDownloadButton
                                    invoiceId={vm.invoiceId}
                                    documentNumber={vm.documentNumber ?? vm.invoiceId}
                                    label={
                                      r.status === 'void'
                                        ? t('actions.downloadVoided')
                                        : t('actions.download')
                                    }
                                    ariaLabel={t(
                                      r.status === 'void'
                                        ? 'actions.downloadVoidedAria'
                                        : 'actions.downloadInvoiceAria',
                                      {
                                        number: vm.documentNumber ?? vm.invoiceId,
                                      },
                                    )}
                                    className={cn(
                                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                                      'min-h-11 px-3',
                                    )}
                                  />
                                )}
                                {vm.showReceipt && (
                                  <PortalReceiptDownloadButton
                                    invoiceId={vm.invoiceId}
                                    documentNumber={
                                      vm.receiptNumber ??
                                      vm.documentNumber ??
                                      vm.invoiceId
                                    }
                                    label={
                                      vm.isCombinedPaid
                                        ? t('actions.downloadCombined')
                                        : t('actions.downloadReceipt')
                                    }
                                    ariaLabel={t('actions.downloadReceiptAria', {
                                      number:
                                        vm.receiptNumber ??
                                        vm.documentNumber ??
                                        vm.invoiceId,
                                    })}
                                    className={cn(
                                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                                      'min-h-11 px-3',
                                    )}
                                  />
                                )}
                                {vm.receiptPending && (
                                  <span
                                    role="status"
                                    aria-live="polite"
                                    aria-busy="true"
                                    className={cn(
                                      buttonVariants({ variant: 'outline', size: 'sm' }),
                                      'min-h-11 px-3 cursor-progress',
                                    )}
                                  >
                                    {t('actions.receiptPreparing')}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
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
