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
import { Badge, Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { BackLink } from '@/components/portal/back-link';
import { formatSatangThb } from '@/lib/format-thb';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { CreditNoteOriginalReceipt } from '@/components/invoices/credit-note-original-receipt';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.creditNotes.detail.meta');
  return { title: t('title') };
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
  const tInvoice = await getTranslations('portal.invoices.detail');
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

  // Spec 122 US4 (`Portal-credit-note` board): back link, the number in
  // mono, Download PDF as the primary action, a Details card (facts, then the
  // credit / VAT / total list) and a Reason card. Figures and labels unchanged.
  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={creditNoteId} label={cn.documentNumber.raw} />
      <BackLink href="/portal/invoices">{tInvoice('backToList')}</BackLink>
      <PageHeader
        title={<span className="font-mono">{cn.documentNumber.raw}</span>}
        badge={
          <Badge tone="success" aria-label={t('status.issued')}>
            {t('status.issued')}
          </Badge>
        }
        subtitle={t('subtitle')}
        actions={
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({ variant: 'primary' })}
            aria-label={t('actions.downloadAria', { number: cn.documentNumber.raw })}
          >
            <DownloadIcon className="aura-icon size-4" aria-hidden="true" />
            {t('actions.download')}
          </a>
        }
      />

      <Card title={tInvoice('detailsHeading')} headingLevel={2}>
        <div className="flex flex-col gap-5">
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('fields.issueDate')}</dt>
              <dd className="m-0">{formatTaxDocDate(cn.issueDate, locale)}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('fields.originalReceipt')}</dt>
              <dd className="m-0">
                {cn.originalDocuments ? (
                  <CreditNoteOriginalReceipt
                    original={cn.originalDocuments}
                    invoiceHref={invoiceHref}
                    size="touch"
                  />
                ) : (
                  <span className="text-[var(--aura-fg-secondary)]">—</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <dl className="m-0 grid w-full grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm sm:w-[340px]">
              <dt className="text-[var(--aura-fg-secondary)]">{t('fields.creditAmount')}</dt>
              <dd className="m-0 text-right tabular-nums">{formatSatangThb(cn.creditAmount.satang, locale)}</dd>
              <dt className="text-[var(--aura-fg-secondary)]">{t('fields.vat')}</dt>
              <dd className="m-0 text-right tabular-nums">{formatSatangThb(cn.vat.satang, locale)}</dd>
              <dt className="border-t border-[var(--aura-border-default)] pt-1.5 font-semibold">
                {t('fields.total')}
              </dt>
              <dd className="m-0 border-t border-[var(--aura-border-default)] pt-1.5 text-right font-semibold tabular-nums">
                {formatSatangThb(cn.total.satang, locale)}
              </dd>
            </dl>
          </div>
        </div>
      </Card>

      <Card title={t('reason.heading')} headingLevel={2}>
        <p className="m-0 whitespace-pre-wrap text-sm">{cn.reason}</p>
      </Card>
    </DetailContainer>
  );
}
