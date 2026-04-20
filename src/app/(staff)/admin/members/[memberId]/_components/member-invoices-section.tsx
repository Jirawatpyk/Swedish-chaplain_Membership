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
import { FileTextIcon, ReceiptIcon } from 'lucide-react';
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
  CardTitle,
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

interface MemberInvoicesSectionProps {
  readonly tenant: TenantContext;
  readonly memberId: string;
  readonly role: 'admin' | 'manager';
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

export async function MemberInvoicesSection({
  tenant,
  memberId,
  role,
}: MemberInvoicesSectionProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.invoices');
  const format = await getFormatter();

  const result = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenant.slug),
    {
      tenantId: tenant.slug,
      memberId,
      pageSize: 100,
      offset: 0,
      status: 'all',
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
    iso === null
      ? '—'
      : format.dateTime(new Date(iso), {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
        });

  return (
    <section aria-labelledby="member-invoices-heading">
      <Card>
        <CardHeader>
          <CardTitle
            id="member-invoices-heading"
            className="text-base flex items-center gap-2"
          >
            <ReceiptIcon className="size-4" aria-hidden="true" />
            {t('title')}
            <span className="text-xs text-muted-foreground font-normal">
              {t('count', { count: total })}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent data-testid="member-invoices-content">
          {rows.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
              {canMutate && (
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
                          <TableCell className="text-right font-mono text-xs">
                            {formatBaht(inv.total?.satang ?? null)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-mono text-xs',
                              remaining !== null &&
                                remaining > 0n &&
                                inv.status !== 'paid' &&
                                'text-amber-600 dark:text-amber-400',
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
                                    href={`/admin/invoices/${inv.invoiceId}#payment`}
                                    className={buttonVariants({
                                      variant: 'outline',
                                      size: 'sm',
                                    })}
                                  >
                                    {t('actions.recordPayment')}
                                  </Link>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled
                                          aria-disabled="true"
                                        >
                                          {t('actions.recordPayment')}
                                        </Button>
                                      }
                                    />
                                    <TooltipContent>
                                      {t('actions.disabledForManager')}
                                    </TooltipContent>
                                  </Tooltip>
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
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled
                                          aria-disabled="true"
                                        >
                                          {t('actions.issueCreditNote')}
                                        </Button>
                                      }
                                    />
                                    <TooltipContent>
                                      {t('actions.disabledForManager')}
                                    </TooltipContent>
                                  </Tooltip>
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
