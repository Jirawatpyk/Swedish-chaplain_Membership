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
 *
 * Spec 122 US7c (boards `Portal-renewal-success` / `-processing`): a centred
 * hero with a check — "Renewal complete", or "Payment received" while the
 * renewed cycle has not landed yet — then the "Renewal details" AURA card,
 * then the actions as AURA link buttons (the receipt download primary, the
 * rest secondary; full width on a phone). The five download outcomes and
 * their gates are unchanged.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { Card, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import {
  billFirstDocumentNumber,
  getInvoice,
  invoiceStatusHasReceipt,
  makeGetInvoiceDeps,
  type Invoice,
} from '@/modules/invoicing';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';
import { resolveMainPdfKind } from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';
import { formatDatePreset } from '@/lib/format-date-localised';

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
  // I16 review-fix: use next-intl formatter for locale-aware date
  // display (TH applies Buddhist Era; SV/EN use Gregorian) instead of
  // raw `.slice(0, 10)` ISO truncation.
  const locale = await getLocale();

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, user.id);
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
  // 070 — this is the post-payment landing page; the renewed cycle is (or is
  // about to be) `completed`. Use `findMostRecentForMember` (INCLUDES a
  // just-completed cycle) rather than `findActiveForMember` (excludes
  // `completed` per the L135 active invariant) so the "Renewal complete"
  // status row below can actually render once the cycle transitions. Null →
  // the async-processing branch when the member has no displayable cycle.
  const activeCycle = await renewalsDeps.cyclesRepo.findMostRecentForMember(
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
      }).catch((err: unknown) => {
        // R8-M-rel-1 — `getInvoice` returns Result<>, never throws under
        // normal operation. A throw landing here means an unexpected
        // infra failure (Drizzle connection drop, RLS panic, Neon
        // timeout). Use `logger.error` so alert rules fire — `warn` is
        // for expected alternative paths (Result.err is one), but this
        // catch covers ONLY the unexpected-throw case (the legitimate
        // not-found / forbidden path returns Result.err without going
        // through `.catch`).
        logger.error(
          {
            tenantId: tenant.slug,
            memberId: memberLookup.value.memberId,
            invoiceId,
            err,
          },
          '[renewal-success-page] getInvoice threw unexpectedly — falling back to View All Invoices link',
        );
        return null;
      })
    : null;
  const invoice = invoiceForReceipt && invoiceForReceipt.ok ? invoiceForReceipt.value : null;

  return renderRenewalSuccessView({
    locale,
    cycle: activeCycle ? { status: activeCycle.status, expiresAt: activeCycle.expiresAt } : null,
    invoiceId: invoiceId ?? null,
    invoice,
  });
}

/**
 * The success page's presentation, exported for the preview harness
 * (spec 122 US7c, as the invoice pages do). `cycle` null is the processing
 * state; `invoiceId` null means the F5 redirect carried no invoice.
 */
export async function renderRenewalSuccessView({
  locale,
  cycle: activeCycle,
  invoiceId,
  invoice,
}: {
  readonly locale: string;
  readonly cycle: { readonly status: string; readonly expiresAt: string } | null;
  readonly invoiceId: string | null;
  readonly invoice: Invoice | null;
}) {
  const t = await getTranslations('portal.renewal.success');
  const tStatus = await getTranslations('portal.renewal.success.cycleStatusValue');
  // R8-M2-ux — separate translator for invoice-action ariaLabels so SR
  // users hear "Download tax receipt PDF for invoice RC-2026-0001" not
  // the generic button label "Download receipt PDF" (no number).
  const tInvoiceActions = await getTranslations('portal.invoices.actions');

  // The board's two heroes: "Renewal complete" only once the cycle is
  // completed; otherwise (no cycle yet, or one the webhook has not completed)
  // the processing hero — never "complete" for a cycle that isn't (financial
  // review, US7c).
  const processing = activeCycle?.status !== 'completed';
  // Buttons stack at full width on a phone and sit side by side from 640px.
  const actionClass = (variant: 'primary' | 'secondary') =>
    `${buttonClass({ variant, touchHeight: true })} w-full sm:w-auto`;

  return (
    <DetailContainer>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--aura-space-6)]">
        {/* Board hero. Round-3 UX H2: focus lands on the h1 after the F5
            redirect, via PageHeader's `autoFocusTitle` (WCAG 2.4.3). */}
        <div
          data-testid="renewal-hero"
          className="flex flex-col items-center gap-[var(--aura-space-3)] text-center [&_header]:items-center [&_header]:text-center"
        >
          <span className="grid size-16 place-items-center rounded-full bg-[var(--aura-status-ready-bg)] text-[var(--aura-status-ready-fg)]">
            <CircleCheck className="size-8" aria-hidden />
          </span>
          <PageHeader
            title={t(processing ? 'processingTitle' : 'title')}
            subtitle={t(processing ? 'processingSubtitle' : 'subtitle')}
            size="hero"
            autoFocusTitle
          />
        </div>

        <Card
          as="section"
          title={t('detailsHeading')}
          titleId="renewal-details-heading"
          headingLevel={2}
        >
          {activeCycle ? (
            // Board: two columns, each label stacked over its value.
            <dl className="grid grid-cols-2 gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-4)] text-sm">
              <div className="flex min-w-0 flex-col gap-[var(--aura-space-1)]">
                <dt className="text-[var(--aura-fg-secondary)]">{t('newExpiry')}</dt>
                <dd className="font-medium">
                  <time dateTime={activeCycle.expiresAt}>
                    {formatDatePreset(activeCycle.expiresAt, locale, 'dateLong')}
                  </time>
                </dd>
              </div>
              {/* UX R5 / S3: the status row shows only once the cycle is
                  completed — the Stripe webhook lands async, and an
                  "Awaiting payment" row under this heading would confuse. */}
              {activeCycle.status === 'completed' && (
                <div className="flex min-w-0 flex-col items-start gap-[var(--aura-space-1)]">
                  <dt className="text-[var(--aura-fg-secondary)]">{t('cycleStatus')}</dt>
                  <dd>
                    <StatusPill tone="ready">{tStatus(activeCycle.status)}</StatusPill>
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            // Round-3 UX H1: the wait is announced (WCAG 4.1.3); M4: a
            // back-to-portal CTA so a member whose webhook never arrives is
            // not left at a dead end.
            <div role="status" aria-live="polite" className="flex flex-col gap-[var(--aura-space-3)]">
              <p className="flex items-start gap-[var(--aura-space-2)] text-sm text-[var(--aura-fg-secondary)]">
                <LoaderCircle className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
                <span>{t('processing')}</span>
              </p>
              <Link
                href="/portal"
                className={actionClass('secondary')}
                data-testid="processing-back-to-portal"
              >
                {t('backToPortal')}
              </Link>
            </div>
          )}
        </Card>

        {/* UX R5 / I2: with no invoice id (a dropped F5 param, or a direct
            visit) the list page stays reachable — an empty action row is
            worse than an indirect path. */}
        <div className="flex flex-col items-stretch gap-[var(--aura-space-2)] sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
          {(() => {
            // R7-M6 — the download variant follows the invoice state, with a
            // real document number for the fallback filename.
            if (!invoiceId) {
              return (
                <Link
                  href="/portal/invoices"
                  className={actionClass('secondary')}
                  data-testid="view-invoices-fallback"
                >
                  {t('viewAllInvoices')}
                </Link>
              );
            }
            if (
              invoice &&
              invoiceStatusHasReceipt(invoice.status) &&
              invoice.receiptPdfStatus === 'rendered' &&
              // 092 follow-up — blob-gated like the three sibling receipt gates
              // (portal detail, list-row view-model, admin): an as-paid row's
              // receipt IS the main pdf, so there is no separate blob to serve.
              invoice.receiptPdf !== null
            ) {
              // The §86/4 + §105ทวิ receipt. 092 — the gate is the
              // receipt-bearing set {paid, partially_credited, credited}: a
              // §86/10 credit note does not cancel the receipt, so a credited
              // invoice (always `rendered`) matches here first.
              const documentNumber =
                invoice.receiptDocumentNumberRaw ?? invoice.documentNumber?.raw ?? invoiceId;
              return (
                <PortalReceiptDownloadButton
                  invoiceId={invoiceId}
                  documentNumber={documentNumber}
                  label={t('downloadReceipt')}
                  // R8-M2-ux — the document number for screen readers.
                  ariaLabel={tInvoiceActions('downloadReceiptAria', {
                    number: documentNumber,
                  })}
                  data-testid="receipt-download-link"
                  className={actionClass('primary')}
                />
              );
            }
            if (invoice && invoice.status === 'paid') {
              // Paid, receipt still rendering: the invoice now, plus a busy
              // "Receipt preparing…" placeholder where the receipt will be.
              // 088 T069 — a bill carries its number in billDocumentNumberRaw.
              const docNum = billFirstDocumentNumber(invoice) ?? invoiceId;
              const isBill = resolveMainPdfKind(invoice) === 'bill';
              return (
                <>
                  <PortalInvoiceDownloadButton
                    invoiceId={invoiceId}
                    documentNumber={docNum}
                    label={t(isBill ? 'downloadBill' : 'downloadInvoice')}
                    ariaLabel={tInvoiceActions(
                      isBill ? 'downloadBillAria' : 'downloadInvoiceAria',
                      { number: docNum },
                    )}
                    data-testid="invoice-download-link"
                    className={actionClass('secondary')}
                  />
                  {/* A server-rendered placeholder that never updates: busy,
                      not a live region (a busy live region never announces —
                      UX review). */}
                  <span
                    aria-busy="true"
                    className="inline-flex min-h-11 w-full cursor-progress items-center justify-center gap-[var(--aura-space-2)] rounded-full bg-[var(--aura-bg-surface-hover)] px-[var(--aura-space-4)] text-sm text-[var(--aura-fg-secondary)] sm:w-auto"
                  >
                    <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
                    {t('receiptPreparing')}
                  </span>
                </>
              );
            }
            // R8-C1 — an invoice that isn't paid yet: the INVOICE download
            // with its own label (never "Download receipt").
            if (invoice) {
              const docNum = billFirstDocumentNumber(invoice) ?? invoiceId;
              const isBill = resolveMainPdfKind(invoice) === 'bill';
              return (
                <PortalInvoiceDownloadButton
                  invoiceId={invoiceId}
                  documentNumber={docNum}
                  label={t(isBill ? 'downloadBill' : 'downloadInvoice')}
                  ariaLabel={tInvoiceActions(
                    isBill ? 'downloadBillAria' : 'downloadInvoiceAria',
                    { number: docNum },
                  )}
                  data-testid="invoice-download-link"
                  className={actionClass('secondary')}
                />
              );
            }
            // The invoice read failed or the member doesn't own it: the list
            // page rather than a broken button.
            return (
              <Link
                href="/portal/invoices"
                className={actionClass('secondary')}
                data-testid="view-invoices-fallback"
              >
                {t('viewAllInvoices')}
              </Link>
            );
          })()}
          {/* In the processing state the details card already offers
              `processing-back-to-portal`, so this one is suppressed there
              (UX R2-I4). */}
          {activeCycle ? (
            <Link href="/portal" className={actionClass('secondary')}>
              {t('backToPortal')}
            </Link>
          ) : null}
        </div>
      </div>
    </DetailContainer>
  );
}
