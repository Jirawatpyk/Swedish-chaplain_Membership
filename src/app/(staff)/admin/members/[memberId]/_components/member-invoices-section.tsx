/**
 * Member detail page "Invoices" section — US7 AS1, AS3.
 *
 * Server Component reading through `listInvoicesByMember` with the
 * same tenant-scoped deps as the sibling `getMember` fetch on the
 * parent page.
 *
 * Why direct use-case call (not `fetch('/api/members/<id>/invoices')`):
 *   This renders on the same request as the parent page. An internal
 *   HTTP hop would double the DB round-trips and serialise/parse the
 *   payload twice for zero functional gain. Sibling convention: see
 *   `page.tsx` calling `getMember` directly. The REST route remains
 *   the source of truth for programmatic clients (contract tests,
 *   future client-side sort/filter).
 *
 * RBAC:
 *   - `admin`   — list + all quick actions (view, record payment, issue CN).
 *   - `manager` — list only; mutating actions rendered disabled with a
 *     tooltip explaining the role constraint.
 *   - `member`  — never reaches this surface (admin route).
 */
import Link from 'next/link';
import { getTranslations, getFormatter } from 'next-intl/server';
import { FileTextIcon, PlusIcon, ReceiptIcon } from 'lucide-react';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing';
import type { TenantContext } from '@/modules/tenants';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { MemberInvoicesFilters } from './member-invoices-filters';

interface MemberInvoicesSectionProps {
  readonly tenant: TenantContext;
  readonly memberId: string;
  readonly role: 'admin' | 'manager';
  /**
   * G-U7F — status filter from URL (`?invStatus=paid`). `undefined`
   * means "all". Legal values narrowed at the page layer before
   * passing in, so any non-matching string falls back to `all`.
   */
  readonly statusFilter?: string | undefined;
  /** G-U7F — fiscal-year filter from URL (`?invYear=2026`). */
  readonly fiscalYearFilter?: number | undefined;
  /** G-U7F — document-number substring search from URL (`?invQ=`). */
  readonly searchFilter?: string | undefined;
}

function statusBadgeVariant(
  status: InvoiceStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'paid':
      return 'default';
    case 'void':
      return 'destructive';
    case 'credited':
    case 'partially_credited':
      return 'outline';
    case 'issued':
    case 'draft':
    default:
      return 'secondary';
  }
}

/** Difference between invoice total and credited total = amount owing. */
function remainingSatang(inv: Invoice): bigint | null {
  if (!inv.total) return null;
  return inv.total.satang - inv.creditedTotal.satang;
}

/**
 * Role-gated action shown as a disabled Button wrapped in a Tooltip
 * explaining the role constraint. Extracted from three near-identical
 * inline Tooltip blocks (Record Payment / Void / Issue Credit Note)
 * per the UX review — centralises tooltip copy and destructive tint so
 * future changes apply once, not three times.
 */
function ManagerDisabledAction({
  label,
  tooltipMessage,
  destructive = false,
  ariaLabel,
}: {
  readonly label: string;
  readonly tooltipMessage: string;
  readonly destructive?: boolean;
  readonly ariaLabel?: string;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={destructive ? 'destructive-outline' : 'outline'}
            size="sm"
            disabled
            aria-disabled="true"
            {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
          >
            {label}
          </Button>
        }
      />
      <TooltipContent>{tooltipMessage}</TooltipContent>
    </Tooltip>
  );
}

export async function MemberInvoicesSection({
  tenant,
  memberId,
  role,
  statusFilter,
  fiscalYearFilter,
  searchFilter,
}: MemberInvoicesSectionProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.invoices');
  const format = await getFormatter();

  // G-U7F — fetch the unfiltered count once so we know whether to
  // show the filter bar at all (member with zero invoices gets the
  // empty-CTA without filter noise). Year derivation was moved to
  // the filter component (now a free-text number input; no dropdown
  // options needed).
  const allYearsResult = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenant.slug),
    { tenantId: tenant.slug, memberId, pageSize: 1, offset: 0, status: 'all' },
  );

  const VALID_STATUSES = new Set([
    'draft',
    'issued',
    'paid',
    'void',
    'credited',
    'partially_credited',
  ]);
  const narrowedStatus =
    statusFilter && VALID_STATUSES.has(statusFilter)
      ? (statusFilter as
          | 'draft'
          | 'issued'
          | 'paid'
          | 'void'
          | 'credited'
          | 'partially_credited')
      : 'all';

  const result = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenant.slug),
    {
      tenantId: tenant.slug,
      memberId,
      pageSize: 100,
      offset: 0,
      status: narrowedStatus,
      ...(fiscalYearFilter !== undefined ? { fiscalYear: fiscalYearFilter } : {}),
      ...(searchFilter ? { search: searchFilter } : {}),
    },
  );

  // Surface repo failures to the parent error boundary instead of
  // silently rendering an empty state — an admin on a renewal call
  // needs to distinguish "no invoices" from "DB failed".
  if (!result.ok) {
    throw new Error(
      `MemberInvoicesSection: listInvoicesByMember failed (${String(result.error.cause)})`,
    );
  }

  const rows = result.value.rows;
  const total = result.value.total;
  const canMutate = role === 'admin';

  const formatBaht = (satang: bigint | null): string =>
    satang === null
      ? '—'
      : format.number(Number(satang) / 100, {
          style: 'currency',
          currency: 'THB',
        });

  const formatDate = (iso: string | null): string =>
    iso === null ? '—' : format.dateTime(new Date(iso), 'dateMedium2Digit');

  return (
    <section aria-labelledby="member-invoices-heading">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          {/* 056 fix #1 — real <h2> (was a CardTitle <div>) so the section
              appears in the SR heading tree; aria-labelledby on the wrapping
              <section> resolves to this id. */}
          <h2
            id="member-invoices-heading"
            className="flex items-center gap-2 font-heading text-base font-medium leading-snug"
          >
            <ReceiptIcon className="size-4" aria-hidden="true" />
            {t('title')}
            <span className="text-xs text-muted-foreground font-normal">
              {t('count', { count: total })}
            </span>
          </h2>
          {/* "New invoice" CTA visible whenever the member already
            * has any invoices (total > 0). MUTUALLY EXCLUSIVE with
            * the empty-state CTA in CardContent (which only renders
            * when total === 0 AND no filters active) — so the member
            * page NEVER shows two "New invoice" buttons at once.
            * Admin-only: managers are read-only on finance per
            * Constitution Principle V. */}
          {canMutate && total > 0 && (
            <Link
              href={`/admin/invoices/new?memberId=${encodeURIComponent(memberId)}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {t('newInvoice')}
            </Link>
          )}
        </CardHeader>
        <CardContent data-testid="member-invoices-content">
          {/* G-U7F — status + year filter. Only render when the
            * unfiltered set is non-empty: if the member has ZERO
            * invoices there is nothing to filter, so the empty-CTA
            * stays the dominant focus. */}
          {allYearsResult.ok && allYearsResult.value.total > 0 && (
            <MemberInvoicesFilters />
          )}
          {/* G-U7S — Spec US7 AS1 "sortable" deferred to Phase 10
            * polish. Rationale: typical member has ≤20 invoices;
            * server default `ORDER BY issue_date DESC` already
            * surfaces 'most recent first' (the 95% user intent).
            * Filter (G-U7F) + paid-date column (G-U7P) together
            * cover the 'I can find invoice X' job that 'sortable'
            * is a proxy for. Revisit when members regularly carry
            * ≥50 invoices. */}
          {rows.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <p className="text-sm text-muted-foreground">
                {statusFilter !== undefined ||
                fiscalYearFilter !== undefined ||
                searchFilter !== undefined
                  ? t('emptyFiltered')
                  : t('empty')}
              </p>
              {statusFilter === undefined &&
                fiscalYearFilter === undefined &&
                searchFilter === undefined &&
                canMutate && (
                <Link
                  href={`/admin/invoices/new?memberId=${encodeURIComponent(memberId)}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('emptyCta')}
                </Link>
              )}
            </div>
          ) : (
            <TooltipProvider>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('cols.number')}</TableHead>
                      <TableHead scope="col">{t('cols.status')}</TableHead>
                      <TableHead scope="col">{t('cols.issued')}</TableHead>
                      <TableHead scope="col">{t('cols.due')}</TableHead>
                      {/* G-U7P — spec US7 AS1 requires "issue/due/paid dates" */}
                      <TableHead scope="col">{t('cols.paid')}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('cols.total')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t('cols.remaining')}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        <span className="sr-only">{t('cols.actions')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((inv) => {
                      const docNum =
                        inv.documentNumber?.raw ?? t('draftPlaceholder');
                      const canRecordPayment = inv.status === 'issued';
                      // G-V1 / US7 AS1 — spec-required Void action
                      // per-row. Gate matches /admin/invoices/[id]/page.tsx
                      // Void button exactly: status === 'issued'.
                      const canVoid = inv.status === 'issued';
                      const canIssueCreditNote =
                        inv.status === 'paid' ||
                        inv.status === 'partially_credited';
                      const remaining = remainingSatang(inv);
                      return (
                        <TableRow key={inv.invoiceId}>
                          <TableCell className="font-mono text-xs">
                            {docNum}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadgeVariant(inv.status)}>
                              {t(`statuses.${inv.status}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatDate(inv.issueDate)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatDate(inv.dueDate)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {/* G-U7P — paid date. SR aria-label on the
                              * em-dash so screen readers read 'Not
                              * paid yet' instead of a meaningless dash. */}
                            {inv.paidAt ? (
                              formatDate(inv.paidAt)
                            ) : (
                              <span
                                className="text-muted-foreground"
                                aria-label={t('cols.paidEmpty')}
                              >
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatBaht(inv.total?.satang ?? null)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-mono text-xs',
                              remaining !== null &&
                                remaining > 0n &&
                                inv.status !== 'paid' &&
                                // amber-700 (not -600) on white = 4.8:1, meets
                                // WCAG 2.1 AA 1.4.3 (a11y scan fix); dark mode
                                // keeps amber-400 (sufficient on dark bg).
                                'text-amber-700 dark:text-amber-400',
                            )}
                          >
                            {formatBaht(remaining)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                              <Link
                                href={`/admin/invoices/${inv.invoiceId}`}
                                className={buttonVariants({
                                  variant: 'ghost',
                                  size: 'sm',
                                })}
                              >
                                <FileTextIcon
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                <span>{t('actions.view')}</span>
                              </Link>
                              {canRecordPayment &&
                                (canMutate ? (
                                  <Link
                                    // W1-44: target the RecordPaymentDialog trigger
                                    // (id="record-payment") that renders for ISSUED invoices.
                                    // The old #payment anchor only exists on PAID invoices, so
                                    // the link from this issued-invoice CTA resolved to nothing.
                                    href={`/admin/invoices/${inv.invoiceId}#record-payment`}
                                    className={buttonVariants({
                                      variant: 'outline',
                                      size: 'sm',
                                    })}
                                  >
                                    {t('actions.recordPayment')}
                                  </Link>
                                ) : (
                                  <ManagerDisabledAction
                                    label={t('actions.recordPayment')}
                                    tooltipMessage={t('actions.disabledForManager')}
                                  />
                                ))}
                              {canVoid &&
                                (canMutate ? (
                                  <Link
                                    href={`/admin/invoices/${inv.invoiceId}/void`}
                                    className={buttonVariants({
                                      variant: 'destructive-outline',
                                      size: 'sm',
                                    })}
                                    aria-label={t('actions.voidAriaLabel', {
                                      number: inv.documentNumber?.raw ?? inv.invoiceId,
                                    })}
                                  >
                                    {t('actions.void')}
                                  </Link>
                                ) : (
                                  <ManagerDisabledAction
                                    label={t('actions.void')}
                                    tooltipMessage={t('actions.disabledForManager')}
                                    destructive
                                  />
                                ))}
                              {canIssueCreditNote &&
                                (canMutate ? (
                                  <Link
                                    href={`/admin/invoices/${inv.invoiceId}/credit-notes/new`}
                                    className={buttonVariants({
                                      variant: 'outline',
                                      size: 'sm',
                                    })}
                                  >
                                    {t('actions.issueCreditNote')}
                                  </Link>
                                ) : (
                                  <ManagerDisabledAction
                                    label={t('actions.issueCreditNote')}
                                    tooltipMessage={t('actions.disabledForManager')}
                                  />
                                ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
