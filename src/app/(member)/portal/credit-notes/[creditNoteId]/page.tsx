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
import { DownloadIcon } from 'lucide-react';

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
import { formatSatangThb } from '@/lib/format-thb';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.creditNotes.detail.meta');
  return { title: t('title') };
}

function formatIssueDate(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) return isoDate;
  // ICU already renders the Buddhist-Era year for `th` (e.g. 2568) — do NOT
  // append a "(พ.ศ. …)" suffix or the BE year prints twice
  // ("28 พ.ค. 2568 (พ.ศ. 2568)"). EN/SV render Gregorian. UTC construction +
  // `timeZone: 'UTC'` keeps the date stable regardless of server TZ. Mirrors
  // the sibling invoice-detail formatDate() which relies on the same ICU BE
  // behaviour.
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// F4/F5 polish retrospective Phase E (2026-05-17) — `force-dynamic`
// paired with sibling not-found.tsx restores HTTP 404 status on
// `notFound()` (Principle I cross-tenant probe contract). See
// portal/invoices/[invoiceId]/page.tsx for full rationale.
export const dynamic = 'force-dynamic';

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
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(tenantCtx, user.id);
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
          // Back navigation handled by the portal BreadcrumbNav (see
          // portal/layout.tsx). Action row only surfaces the feature
          // action (Download PDF).
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline' })}
            aria-label={t('actions.downloadAria', { number: cn.documentNumber.raw })}
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            {t('actions.download')}
          </a>
        }
      />

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
            <dd>{formatIssueDate(cn.issueDate, locale)}</dd>

            <dt className="text-muted-foreground">{t('fields.originalInvoice')}</dt>
            <dd>
              <Link href={invoiceHref} className="font-mono underline-offset-2 hover:underline">
                {t('fields.originalInvoiceLinkLabel')}
              </Link>
            </dd>

            <dt className="text-muted-foreground">{t('fields.creditAmount')}</dt>
            <dd className="tabular-nums">{formatSatangThb(cn.creditAmount.satang, locale)}</dd>

            <dt className="text-muted-foreground">{t('fields.vat')}</dt>
            <dd className="tabular-nums">{formatSatangThb(cn.vat.satang, locale)}</dd>

            <dt className="text-muted-foreground font-medium">{t('fields.total')}</dt>
            <dd className="font-semibold tabular-nums">
              {formatSatangThb(cn.total.satang, locale)}
            </dd>
          </dl>

          <Separator className="my-6" />

          <section aria-labelledby="cn-reason-heading" className="flex flex-col gap-2">
            <h3 id="cn-reason-heading" className="text-sm font-medium text-muted-foreground">
              {t('reason.heading')}
            </h3>
            <p className="whitespace-pre-wrap text-sm">{cn.reason}</p>
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
