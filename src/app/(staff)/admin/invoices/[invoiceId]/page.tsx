/**
 * T056 — /admin/invoices/[invoiceId] detail page.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoice, makeGetInvoiceDeps, Money } from '@/modules/invoicing';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans, getFeeConfig } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
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

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  return `${sign}${whole.toLocaleString()}.${rem.toString().padStart(2, '0')}`;
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

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.detail');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const { user: currentUser } = await requireSession('staff');

  const hdrs = await headers();
  const requestId = requestIdFromHeaders(hdrs);
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!result.ok) return notFound();
  const invoice = result.value;

  // Look up plan display name so we don't show the raw planId slug.
  const plansResult = await listPlans(
    { filter: { year: invoice.planYear as never } },
    buildPlansDeps(tenantCtx),
  );
  const foundPlan = plansResult.ok
    ? plansResult.value.data.find((p) => p.plan_id === invoice.planId)
    : undefined;
  const planDisplayName = foundPlan
    ? (typeof foundPlan.plan_name === 'object' && foundPlan.plan_name !== null
        ? ((foundPlan.plan_name as { en?: string }).en ?? invoice.planId)
        : String(foundPlan.plan_name ?? invoice.planId))
    : invoice.planId;

  // Prefer the frozen snapshot on issued/paid/void invoices (FR-038);
  // fall back to a live member lookup only for drafts (which have no
  // snapshot yet). getMember emits `member_cross_tenant_probe` on 404
  // with the signed-in admin's user id as actor.
  const snapshotName = (invoice.memberIdentitySnapshot as { legal_name?: string } | null)?.legal_name;
  let memberDisplayName = snapshotName ?? invoice.memberId;
  if (!snapshotName) {
    const memberResult = await getMember(
      invoice.memberId as MemberId,
      { actorUserId: currentUser.id, requestId },
      buildMembersDeps(tenantCtx),
    );
    if (memberResult.ok) memberDisplayName = memberResult.value.member.companyName;
  }

  const isDraft = invoice.status === 'draft';

  // Drafts don't persist subtotal/vat/total on the row (those are
  // frozen snapshots set on issue). For display, compute a live
  // preview from line totals + current F2 VAT rate. Issued invoices
  // use their stored snapshots.
  let displaySubtotalSatang: bigint | null = invoice.subtotal?.satang ?? null;
  let displayVatSatang: bigint | null = invoice.vat?.satang ?? null;
  let displayTotalSatang: bigint | null = invoice.total?.satang ?? null;
  let displayVatPercent: string | null = invoice.vatRate?.toPercentString() ?? null;

  if (isDraft) {
    let sub = Money.zero();
    for (const line of invoice.lines) sub = sub.add(line.total);
    displaySubtotalSatang = sub.satang;

    const fc = await getFeeConfig(buildPlansDeps(tenantCtx));
    if (fc.ok) {
      const rate = fc.value.vat_rate; // decimal 0.07
      const vatSat = (sub.satang * BigInt(Math.round(rate * 10000))) / 10000n;
      displayVatSatang = vatSat;
      displayTotalSatang = sub.satang + vatSat;
      displayVatPercent = `${(rate * 100).toFixed(2)}%`;
    }
  }

  const breadcrumbLabel = invoice.documentNumber?.raw ?? t('draftTitle');

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={invoiceId} label={breadcrumbLabel} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span>{invoice.documentNumber?.raw ?? t('draftTitle')}</span>
            <Badge variant={statusBadgeVariant(invoice.status)}>
              {tStatus(invoice.status)}
            </Badge>
          </span>
        }
        actions={
          <div className="flex gap-2">
            {isDraft && (
              <>
                <Link
                  href={`/api/invoices/${invoice.invoiceId}/preview`}
                  className={buttonVariants({ variant: 'outline' })}
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
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('actions.download')}
              </Link>
            )}
          </div>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('fields.memberId')}</dt>
              <dd>
                <Link
                  href={`/admin/members/${invoice.memberId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {memberDisplayName}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.plan')}</dt>
              <dd>
                {planDisplayName} <span className="text-muted-foreground">/ {invoice.planYear}</span>
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
              <dd>{formatSatang(displaySubtotalSatang)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('fields.vat')}
                {displayVatPercent && (
                  <span className="ml-1 text-xs">({displayVatPercent})</span>
                )}
              </dt>
              <dd>{formatSatang(displayVatSatang)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('fields.total')}
                {isDraft && <span className="ml-1 text-xs">({t('previewLabel')})</span>}
              </dt>
              <dd className="font-semibold">{formatSatang(displayTotalSatang)} THB</dd>
            </div>
          </dl>
          <section className="mt-6">
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">{t('lines.title')}</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      scope="col"
                      className="text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.description')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.qty')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.unit')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.total')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.lines.map((l) => (
                    <TableRow key={l.lineId}>
                      <TableCell className="align-middle">
                        <div lang="th" className="font-sarabun">{l.descriptionTh}</div>
                        <div className="text-xs text-muted-foreground">{l.descriptionEn}</div>
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="align-middle text-right tabular-nums">
                        {formatSatang(l.unitPrice.satang)}
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">{formatSatang(l.total.satang)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
