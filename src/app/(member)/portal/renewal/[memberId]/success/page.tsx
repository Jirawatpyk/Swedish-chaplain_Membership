/**
 * F8 Phase 5 Wave C · T131 — `/portal/renewal/[memberId]/success` page.
 *
 * Landing page after F5 payment success redirects back. Shows the new
 * `expires_at` and links to download the receipt PDF.
 *
 * Auth: requireSession('member'). Cross-member guard — URL [memberId]
 * MUST match session-member's memberId.
 *
 * i18n: strings under `portal.renewal.success.*` in EN/TH/SV.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getFormatter, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';

export default async function RenewalSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string }>;
  searchParams: Promise<{ invoice?: string }>;
}) {
  const { memberId: urlMemberId } = await params;
  const { invoice: invoiceId } = await searchParams;
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('portal.renewal.success');
  const tStatus = await getTranslations('portal.renewal.success.cycleStatusValue');
  // I16 review-fix: use next-intl formatter for locale-aware date
  // display (TH applies Buddhist Era; SV/EN use Gregorian) instead of
  // raw `.slice(0, 10)` ISO truncation.
  const formatter = await getFormatter();

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-success-page] no member linked to session user',
    );
    notFound();
  }
  if (memberLookup.value.memberId !== urlMemberId) {
    notFound();
  }

  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const activeCycle = await renewalsDeps.cyclesRepo.findActiveForMember(
    tenant.slug,
    urlMemberId,
  );

  // R7-M6 — fetch the invoice so we can (a) display the real document
  // number (instead of the UUID from the query param) on the download
  // button + filename, (b) choose the right download variant (receipt
  // when paid+rendered, otherwise invoice), and (c) show a "preparing"
  // affordance if the receipt is still rendering async. Falls back to
  // the previous behaviour (download invoice PDF using UUID) if the
  // invoice fetch fails — defensive, since this is a post-payment
  // landing page and we don't want to dead-end the member.
  const reqHeaders = await headers();
  const requestId = requestIdFromHeaders(reqHeaders);
  const invoiceForReceipt = invoiceId
    ? await getInvoice(makeGetInvoiceDeps(tenant.slug), {
        tenantId: tenant.slug,
        invoiceId,
        actor: {
          userId: user.id,
          role: 'member',
          requestId: requestId ?? null,
          memberId: memberLookup.value.memberId,
        },
      }).catch((err) => {
        logger.warn(
          {
            tenantId: tenant.slug,
            memberId: memberLookup.value.memberId,
            invoiceId,
            err,
          },
          '[renewal-success-page] getInvoice failed — falling back to invoice variant',
        );
        return null;
      })
    : null;
  const invoice =
    invoiceForReceipt && invoiceForReceipt.ok ? invoiceForReceipt.value : null;

  return (
    <DetailContainer>
      {/* Staff-Review-2026-05-09 WRN-7 fix: replaced handrolled
          <header><h1><p></header> with the shared <PageHeader> primitive
          for visual rhythm parity with sibling portal pages.

          Round-3 UX H2 fix: auto-focus the H1 after F5 redirect so
          SR + keyboard users land at the heading instead of inheriting
          focus from Stripe's last-focused payment-form element
          (WCAG 2.4.3).

          Round-2 R2-W2 follow-up: focus owned by PageHeader's
          internal ref via `autoFocusTitle` prop (replaces the
          external <AutoFocusH1> component which mutated `tabIndex`
          directly on a React-owned DOM node — fragile if PageHeader
          ever re-rendered client-side). */}
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        autoFocusTitle
      />

      <section
        aria-labelledby="renewal-details-heading"
        className="rounded-lg border bg-card p-4"
      >
        <h2
          id="renewal-details-heading"
          className="mb-3 text-lg font-medium"
        >
          {t('detailsHeading')}
        </h2>
        {activeCycle ? (
          // UX R5 / Mobile #1: responsive grid — single column at
          // <640px so Thai/SV labels don't squeeze the value column.
          <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2 sm:gap-x-4">
            <dt className="text-muted-foreground">{t('newExpiry')}</dt>
            <dd>
              <time dateTime={activeCycle.expiresAt}>
                {formatter.dateTime(new Date(activeCycle.expiresAt), {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
            </dd>
            {/* UX R5 / S3: only show cycle status when it's actually
                completed. Stripe webhooks land async, so a member
                redirected from F5 can briefly see status='awaiting_payment'
                even though the success page heading says "Renewal
                complete" — confusing. Hiding the row keeps the page
                consistent until the cycle truly transitions. */}
            {activeCycle.status === 'completed' && (
              <>
                <dt className="text-muted-foreground">{t('cycleStatus')}</dt>
                <dd>{tStatus(activeCycle.status)}</dd>
              </>
            )}
          </dl>
        ) : (
          // Round-3 UX H1 fix: announce the async-processing state to
          // SR via aria-live="polite" so users hear the transition
          // when Stripe webhook lands and the page re-renders with
          // status=completed (WCAG 4.1.3).
          // Round-3 UX M4 fix: provide a back-to-portal CTA so members
          // who never see the webhook arrive (network drop, blocked)
          // have an explicit next step instead of a dead-end page.
          <div role="status" aria-live="polite" className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('processing')}</p>
            <Link
              href="/portal"
              className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
              data-testid="processing-back-to-portal"
            >
              {t('backToPortal')}
            </Link>
          </div>
        )}
      </section>

      {/* UX R5 / Mobile #2: download receipt is the primary success-
          page action — must hit ≥36px tap target on mobile. Plain
          underline link sat at ~14px (text-sm line height) which
          failed WCAG 2.5.8 on touch. Use the same button-shaped link
          treatment as backToPortal so both primary actions are
          visually equivalent.
          UX R5 / I2: when invoiceId is missing (member navigated to
          success URL directly, or F5 redirect dropped the param),
          fall back to "View all invoices" so the receipt is still
          reachable — empty action row is worse than indirect path. */}
      <div className="flex flex-wrap items-center gap-3">
        {(() => {
          // R7-M6 — render the right download variant based on invoice
          // state, with a real document number so the fallback filename
          // is `INV-2026-0042.pdf` (not the bare UUID).
          const sharedClassName =
            'inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50';
          if (!invoiceId) {
            // No invoice id in URL — F5 redirect dropped the param, or
            // member navigated here directly. Surface the list page
            // instead of a dead-end.
            return (
              <Link
                href="/portal/invoices"
                className={sharedClassName}
                data-testid="view-invoices-fallback"
              >
                {t('viewAllInvoices')}
              </Link>
            );
          }
          if (invoice && invoice.status === 'paid' && invoice.receiptPdfStatus === 'rendered') {
            // Paid + receipt rendered — the legal §86/4 + §105ทวิ doc
            // is what the member should grab. Combined-mode reuses the
            // invoice number; separate-mode has its own RC-… number.
            const documentNumber =
              invoice.receiptDocumentNumberRaw ??
              invoice.documentNumber?.raw ??
              invoiceId;
            return (
              <PortalReceiptDownloadButton
                invoiceId={invoiceId}
                documentNumber={documentNumber}
                label={t('downloadReceipt')}
                data-testid="receipt-download-link"
                className={sharedClassName}
              />
            );
          }
          if (invoice && invoice.status === 'paid') {
            // Paid but receipt PDF still rendering — give the member
            // the invoice (immediately available) + an explicit "your
            // receipt is being prepared" affordance.
            return (
              <>
                <PortalInvoiceDownloadButton
                  invoiceId={invoiceId}
                  documentNumber={invoice.documentNumber?.raw ?? invoiceId}
                  label={t('downloadInvoice')}
                  data-testid="receipt-download-link"
                  className={sharedClassName}
                />
                <span
                  role="status"
                  aria-live="polite"
                  aria-busy="true"
                  className={`${sharedClassName} cursor-progress`}
                >
                  {t('receiptPreparing')}
                </span>
              </>
            );
          }
          // Invoice fetch failed or not-paid — keep the legacy variant
          // (invoice download). Document number falls back to UUID only
          // if the catch path triggered; defensive but correct.
          return (
            <PortalInvoiceDownloadButton
              invoiceId={invoiceId}
              documentNumber={invoice?.documentNumber?.raw ?? invoiceId}
              label={t('downloadReceipt')}
              data-testid="receipt-download-link"
              className={sharedClassName}
            />
          );
        })()}
        <Link
          href="/portal"
          // S-4 review-fix: button-shaped link for primary nav so the
          // hit area meets WCAG 2.5.8 (≥36px). Base UI Button doesn't
          // support `asChild`, so we mirror the `outline` variant
          // styling on a Link directly.
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
        >
          {t('backToPortal')}
        </Link>
      </div>
    </DetailContainer>
  );
}
