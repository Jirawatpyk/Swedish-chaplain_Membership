/**
 * T072 (R7-B3 polish completion) — `/portal/invoices/[invoiceId]`.
 *
 * Member-scope **read-only** invoice detail. Companion to the list at
 * `/portal/invoices` and the byte-streamed PDF route at
 * `/api/portal/invoices/[invoiceId]/pdf`.
 *
 * Ownership semantics (US3 AS2 — Constitution Principle I clause 3):
 *   - `requireSession('member')` gates the route.
 *   - `findByLinkedUserId` resolves the signed-in user to a member.
 *     Not-linked → `notFound()` (no info leak about whether the
 *     invoice id exists for some other member).
 *   - `getInvoice` runs under `runInTenant` so RLS hides cross-tenant
 *     rows; the `actor` payload makes the use case emit
 *     `invoice_cross_tenant_probe` on miss.
 *   - Same-tenant-different-member case: even if the invoice resolves,
 *     a member-scope check (`invoice.memberId !== member.memberId`)
 *     calls `notFound()` AND emits a probe audit row mirroring the
 *     `getInvoicePdfSignedUrl` member branch (so the page surface
 *     can't be used to enumerate sibling-member invoice ids inside
 *     the same chamber).
 *
 * Drafts are never exposed to members (the use case returns the row
 * but we treat `status === 'draft'` as `notFound()` here too — drafts
 * have no document number, no PDF, and no member-facing meaning).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations, getLocale } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from '../_utils/format';

const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

interface RouteParams {
  readonly invoiceId: string;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invoices.detail');
  return { title: t('title') };
}

export default async function PortalInvoiceDetailPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { invoiceId } = await params;
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invoices.detail');
  const tList = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const userLocale = await getLocale();

  const tenantCtx = resolveTenantFromRequest();
  const reqHeaders = await headers();
  const requestId = requestIdFromHeaders(reqHeaders);

  const memberDeps = buildMembersDeps(tenantCtx);
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(
    tenantCtx,
    user.id,
  );
  if (!memberResult.ok) {
    // Same opacity as a missing invoice — no enumeration signal.
    notFound();
  }
  const member = memberResult.value;

  // Cross-tenant + same-tenant-member-mismatch probe both surface
  // through `getInvoice` when `actor.memberId` is supplied — the use
  // case emits the audit row and returns `not_found` / `forbidden`.
  // We collapse both into `notFound()` at the route layer so members
  // can't enumerate sibling invoice ids by error-code differential.
  const invoiceResult = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
    actor: {
      userId: user.id,
      role: 'member',
      requestId: requestId ?? null,
      memberId: member.memberId,
    },
  });
  if (!invoiceResult.ok) {
    notFound();
  }
  const invoice = invoiceResult.value;

  // Drafts have no member-facing surface. Treat as not-found rather
  // than rendering a half-state.
  if (invoice.status === 'draft') {
    notFound();
  }

  const documentNumber = invoice.documentNumber?.raw ?? '—';
  const subtotal = invoice.subtotal?.satang ?? null;
  const vat = invoice.vat?.satang ?? null;
  const total = invoice.total?.satang ?? null;

  return (
    <DetailContainer>
      <PageHeader
        title={`${t('title')} ${documentNumber}`}
        badge={(() => {
          const Icon = STATUS_ICON_MAP[statusIconName(invoice.status)];
          return (
            <Badge
              variant={statusBadgeVariant(invoice.status)}
              className="inline-flex items-center gap-1"
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {tStatus(invoice.status)}
            </Badge>
          );
        })()}
        actions={
          invoice.pdf ? (
            <a
              href={`/api/portal/invoices/${invoice.invoiceId}/pdf`}
              aria-label={`${tList('actions.download')} — ${documentNumber}`}
              className={cn(
                buttonVariants({ variant: 'default', size: 'sm' }),
                'min-h-11 px-4',
              )}
              download
            >
              {tList('actions.download')}
            </a>
          ) : null
        }
      />

      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('fields.issueDate')}
            </p>
            <p className="text-body">{formatDate(invoice.issueDate, userLocale)}</p>
          </div>
          <div>
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('fields.dueDate')}
            </p>
            <p className="text-body">{formatDate(invoice.dueDate, userLocale)}</p>
          </div>
          <div>
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('fields.paidDate')}
            </p>
            <p className="text-body">{formatDate(invoice.paidAt, userLocale)}</p>
          </div>
          <div>
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('fields.planYear')}
            </p>
            <p className="text-body">{invoice.planYear}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <h2 className="text-h4">{t('linesHeading')}</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('lines.description')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('lines.quantity')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('lines.unitPrice')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('lines.lineTotal')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.lines.map((line) => {
                  const sameText = line.descriptionTh === line.descriptionEn;
                  const primary =
                    userLocale === 'th' ? line.descriptionTh : line.descriptionEn;
                  const secondary =
                    userLocale === 'th' ? line.descriptionEn : line.descriptionTh;
                  return (
                    <TableRow key={line.lineId}>
                      <TableCell className="align-top">
                        {/* Thai tax invoices require bilingual display
                            at co-equal visual weight (§86); primary
                            locale gets a subtle medium weight so the
                            reader's chosen language leads without
                            demoting the other. If the two strings
                            are identical (common for plan-year items)
                            collapse to a single row. */}
                        <span className="block text-body font-medium">{primary}</span>
                        {!sameText ? (
                          <span className="block text-body">{secondary}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {line.quantity}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {formatSatangThb(line.unitPrice.satang, userLocale)}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {formatSatangThb(line.total.satang, userLocale)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        {/* dl/dt/dd preserves the semantic label-value pairing for
            screen readers; the previous `div.contents` flattening
            caused VoiceOver/NVDA to read the six cells as loose
            items with no association. */}
        <CardContent>
          <dl className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <dt className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('totals.subtotal')}
            </dt>
            <dd className="tabular-nums sm:justify-self-end">
              {formatSatangThb(subtotal, userLocale)}
            </dd>
            <dt className="text-caption uppercase tracking-wide text-muted-foreground">
              {t('totals.vat')}
            </dt>
            <dd className="tabular-nums sm:justify-self-end">
              {formatSatangThb(vat, userLocale)}
            </dd>
            <dt className="text-body font-medium uppercase tracking-wide">
              {t('totals.total')}
            </dt>
            <dd className="text-body font-medium tabular-nums sm:justify-self-end">
              {formatSatangThb(total, userLocale)}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <div>
        <Link
          href="/portal/invoices"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-11 px-3')}
        >
          {t('backToList')}
        </Link>
      </div>
    </DetailContainer>
  );
}
