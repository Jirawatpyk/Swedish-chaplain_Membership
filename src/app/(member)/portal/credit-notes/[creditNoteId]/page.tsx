/**
 * G-1 Phase C — `/portal/credit-notes/[creditNoteId]` detail page.
 *
 * Member-facing credit-note detail view. Closes the spec gap where
 * members received the `credit_note_issued` cancellation/adjustment
 * email but had no UI path to retrieve the CN afterwards.
 *
 * Access model:
 *   - `requireSession('member')` → portal-scope session only
 *   - member resolved via `findByLinkedUserId` (same as portal
 *     invoice detail)
 *   - `getCreditNote` with `actor.role='member'` + `actor.memberId`
 *     → Application layer enforces that the CN's original-invoice
 *     member_id matches the caller; mismatch returns opaque
 *     `not_found` + emits `credit_note_cross_tenant_probe` audit so
 *     enumeration attempts are recorded.
 *   - Cross-tenant reads are blocked at the repo RLS layer
 *     (`SET LOCAL app.current_tenant`) + at the use-case ownership
 *     check; dual guards per Constitution Principle I.
 *
 * UX differences vs the admin CN detail:
 *   - Drops `issuedByUserId` email (admin internal data)
 *   - Drops tenant identity card (members only care about their
 *     own billing context; the tenant is implicit)
 *   - Drops sibling-CN navigation block (members rarely have more
 *     than one CN on an invoice; they jump back via the portal
 *     invoice list / detail)
 *   - Member-tone copy ("A credit has been issued against your
 *     invoice") instead of admin-neutral labels
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { ArrowLeftIcon, DownloadIcon } from 'lucide-react';

import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getCreditNote, makeGetCreditNoteDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.creditNotes.detail.meta');
  return { title: t('title') };
}

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  // FR-005 — explicit `'en-US'` pin matches the admin surface so
  // customer-facing amounts read identically between admin and
  // portal renders of the same document.
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

function formatIssueDate(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) return isoDate;
  const ce = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  if (locale.startsWith('th')) return `${ce} (พ.ศ. ${year + 543})`;
  return ce;
}

export default async function PortalCreditNoteDetailPage({
  params,
}: {
  params: Promise<{ creditNoteId: string }>;
}) {
  const { creditNoteId } = await params;
  const t = await getTranslations('portal.creditNotes.detail');
  const locale = await getLocale();

  const { user } = await requireSession('member');

  const tenantCtx = resolveTenantFromRequest();
  const reqHeaders = await headers();
  const requestId = requestIdFromHeaders(reqHeaders);

  // Resolve the signed-in user to a member — opaque notFound() on
  // any miss so enumeration via 401/404 differential is blocked.
  const memberDeps = buildMembersDeps(tenantCtx);
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(
    tenantCtx,
    user.id,
  );
  if (!memberResult.ok) notFound();
  const member = memberResult.value;

  const result = await getCreditNote(makeGetCreditNoteDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    creditNoteId,
    actor: {
      userId: user.id,
      role: 'member',
      memberId: member.memberId,
      requestId: requestId ?? null,
    },
  });
  if (!result.ok) notFound();
  const cn = result.value;

  const invoiceHref = `/portal/invoices/${cn.originalInvoiceId}`;
  const pdfHref = `/api/portal/credit-notes/${creditNoteId}/pdf`;

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={creditNoteId} label={cn.documentNumber.raw} />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{cn.documentNumber.raw}</span>
            <Badge variant="default" aria-label={t('status.issued')}>
              {t('status.issued')}
            </Badge>
          </span>
        }
        subtitle={t('subtitle')}
        actions={
          <>
            <Link
              href={invoiceHref}
              className={buttonVariants({ variant: 'outline' })}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {t('actions.backToInvoice')}
            </Link>
            <a
              href={pdfHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'outline' })}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              {t('actions.download')}
            </a>
          </>
        }
      />

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
            <dd>{formatIssueDate(cn.issueDate, locale)}</dd>

            <dt className="text-muted-foreground">{t('fields.originalInvoice')}</dt>
            <dd>
              <Link
                href={invoiceHref}
                className="font-mono underline-offset-2 hover:underline"
              >
                {t('fields.originalInvoiceLinkLabel')}
              </Link>
            </dd>

            <dt className="text-muted-foreground">{t('fields.creditAmount')}</dt>
            <dd className="tabular-nums">
              {formatSatang(cn.creditAmount.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>

            <dt className="text-muted-foreground">{t('fields.vat')}</dt>
            <dd className="tabular-nums">
              {formatSatang(cn.vat.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>

            <dt className="text-muted-foreground font-medium">{t('fields.total')}</dt>
            <dd className="font-semibold tabular-nums">
              {formatSatang(cn.total.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>
          </dl>

          <Separator className="my-6" />

          <section aria-labelledby="cn-reason-heading" className="flex flex-col gap-2">
            <h3
              id="cn-reason-heading"
              className="text-sm font-medium text-muted-foreground"
            >
              {t('reason.heading')}
            </h3>
            <p className="whitespace-pre-wrap text-sm">{cn.reason}</p>
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
