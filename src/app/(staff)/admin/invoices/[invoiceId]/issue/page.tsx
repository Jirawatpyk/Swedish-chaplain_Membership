/**
 * T056 — /admin/invoices/[invoiceId]/issue confirm page.
 *
 * Pre-confirm summary block (member, plan+year, subtotal, line count,
 * projected due date) is rendered above the typed-phrase Input so the
 * admin can verify what will be committed before allocating a RD §87
 * sequence number. Typed-phrase "ISSUE" input guards the POST.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans, getFeeConfig } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { Card, CardContent } from '@/components/ui/card';
import { IssueConfirmDialog } from '../../_components/issue-confirm-dialog';

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  return `${sign}${whole.toLocaleString()}.${rem.toString().padStart(2, '0')}`;
}

export default async function IssueInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.issue');
  const tDetail = await getTranslations('admin.invoices.detail');
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') notFound();

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
  if (invoice.status !== 'draft') {
    const { redirect } = await import('next/navigation');
    redirect(`/admin/invoices/${invoice.invoiceId}`);
  }

  const breadcrumbLabel = invoice.documentNumber?.raw ?? t('draftLabel');

  // Pre-confirm summary data — same pattern as detail page.
  const [memberResult, plansResult, feeConfig] = await Promise.all([
    getMember(
      invoice.memberId as MemberId,
      { actorUserId: currentUser.id, requestId },
      buildMembersDeps(tenantCtx),
    ),
    listPlans(
      { filter: { year: invoice.planYear as never } },
      buildPlansDeps(tenantCtx),
    ),
    getFeeConfig(buildPlansDeps(tenantCtx)),
  ]);
  const memberDisplayName = memberResult.ok
    ? memberResult.value.member.companyName
    : invoice.memberId;
  const foundPlan = plansResult.ok
    ? plansResult.value.data.find((p) => p.plan_id === invoice.planId)
    : undefined;
  const planDisplayName = foundPlan
    ? typeof foundPlan.plan_name === 'object' && foundPlan.plan_name !== null
      ? ((foundPlan.plan_name as { en?: string }).en ?? invoice.planId)
      : String(foundPlan.plan_name ?? invoice.planId)
    : invoice.planId;

  let subtotalSatang: bigint | null = null;
  let vatSatang: bigint | null = null;
  let totalSatang: bigint | null = null;
  let vatPercent = '';
  if (invoice.lines.length > 0) {
    let subSat = 0n;
    for (const l of invoice.lines) subSat += l.total.satang;
    subtotalSatang = subSat;
    if (feeConfig.ok) {
      const rate = feeConfig.value.vat_rate;
      const vs = (subSat * BigInt(Math.round(rate * 10000))) / 10000n;
      vatSatang = vs;
      totalSatang = subSat + vs;
      vatPercent = `${(rate * 100).toFixed(2)}%`;
    }
  }

  return (
    <FormContainer>
      <PlanBreadcrumbLabel segment={invoiceId} label={breadcrumbLabel} />
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent className="flex flex-col gap-[var(--page-section-gap)]">
          {/* Destructive-action warning — legally irreversible (UX-L1). */}
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {t('irreversibleWarning')}
          </div>
          {/* Pre-confirm summary — `id` referenced from IssueConfirmPanel
              via aria-describedby so AT users hear the numbers before
              the typed-phrase input takes focus. */}
          <dl
            id="issue-invoice-summary"
            className="grid grid-cols-2 gap-4 text-sm"
          >
            <div>
              <dt className="text-muted-foreground">{tDetail('fields.memberId')}</dt>
              <dd>{memberDisplayName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tDetail('fields.plan')}</dt>
              <dd>
                {planDisplayName}{' '}
                <span className="text-muted-foreground">/ {invoice.planYear}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tDetail('fields.subtotal')}</dt>
              <dd className="tabular-nums">{formatSatang(subtotalSatang)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {tDetail('fields.vat')}
                {vatPercent && <span className="ml-1 text-xs">({vatPercent})</span>}
              </dt>
              <dd className="tabular-nums">{formatSatang(vatSatang)} THB</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">{tDetail('fields.total')}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatSatang(totalSatang)} THB
              </dd>
            </div>
          </dl>
          <IssueConfirmDialog
            invoiceId={invoice.invoiceId}
            summaryId="issue-invoice-summary"
          />
        </CardContent>
      </Card>
      <Link
        href={`/admin/invoices/${invoice.invoiceId}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← {t('cancel')}
      </Link>
    </FormContainer>
  );
}
