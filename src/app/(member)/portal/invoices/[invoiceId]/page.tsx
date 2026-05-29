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
import { getInvoice, makeGetInvoiceDeps, computeIsOverdue } from '@/modules/invoicing';
// Portal CN list — same escape-hatch pattern already used for the
// tenant-settings + credit-note reads on the admin invoice detail
// page. An Application-layer use-case is a Phase-10 consolidation
// candidate. Ownership is still enforced: the repo is tenant-scoped
// via RLS, and this page reaches here only after getInvoice has
// already validated member ownership of the invoice — any CN rows
// against that invoice are, by construction, this member's.

import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { asInvoiceId } from '@/modules/invoicing';
// F5 G4 — presentation-only settings read (FR-016/FR-030 render-gate).
// Same escape-hatch pattern as the CN repo above; the Application-
// layer read-only loader is a Phase-9 consolidation candidate once
// the admin-settings use-case lands. The repo does its own RLS-
// scoped read under `runInTenant`, so this is safe tenant-wise.

import { makeDrizzleTenantPaymentSettingsRepo } from '@/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo';
// H-8 (review 2026-04-27): query audit_log for the auto-refund signal
// to drive the member-facing refund banner. Same escape-hatch pattern
// as tenant-payment-settings + CN repo above; the repo is RLS-scoped
// + read-only. Application-layer use-case is a Phase-10 consolidation
// candidate.

import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { env } from '@/lib/env';
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
import { AlertTriangle, Ban, CheckCircle2, Clock, FileText, type LucideIcon } from 'lucide-react';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from '../_utils/format';
import { ResendInvoiceButton } from '../_components/resend-invoice-button';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from '../_components/portal-pdf-download-button';
import { PayNowButton } from './_components/pay-sheet/pay-now-button';
import { OnlinePaymentDisabledCard } from './_components/online-payment-disabled-card';
import { OptimisticPaidOverlay } from './_components/optimistic-paid-overlay';

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

// F4/F5 polish retrospective Phase E (2026-05-17) — `export const
// dynamic = 'force-dynamic'` paired with the sibling `not-found.tsx`
// is required for `notFound()` to set the response status to HTTP
// 404 (vs the RSC streaming default of 200). Without `force-dynamic`,
// response headers commit before `notFound()` resolves and a 200
// leaks even when the body is the not-found UI — breaking the
// Principle I cross-tenant probe contract (attackers can grep 200
// status to enumerate invoiceIds). Mirrors the admin/invoices/
// [invoiceId] fix from commit a8333ba2 + the F7 broadcasts pattern.
export const dynamic = 'force-dynamic';

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
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(tenantCtx, user.id);
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

  // T109 — derive presentation-only overdue status. Portal detail
  // does not fire the audit emit; the admin detail page handles the
  // opportunistic audit on their read path.
  const displayStatus = computeIsOverdue(invoice, new Date().toISOString())
    ? 'overdue'
    : invoice.status;

  // R5 round-7: pre-render BOTH badge variants on the server so the
  // <OptimisticPaidOverlay> client component can swap between them
  // without having to re-derive the rendered output. Function children
  // are not allowed across the server→client boundary, so we pass the
  // pre-rendered JSX as `whenUnpaid` / `whenPaid` props.
  const renderStatusBadge = (status: typeof displayStatus | 'paid') => {
    const Icon = STATUS_ICON_MAP[statusIconName(status)];
    return (
      <Badge variant={statusBadgeVariant(status)} className="inline-flex items-center gap-1">
        <Icon className="size-3.5" aria-hidden="true" />
        {tStatus(status)}
      </Badge>
    );
  };

  const documentNumber = invoice.documentNumber?.raw ?? '—';
  const subtotal = invoice.subtotal?.satang ?? null;
  const vat = invoice.vat?.satang ?? null;
  const total = invoice.total?.satang ?? null;

  // F5 G4 T081 — load tenant payment settings to drive the Pay-now
  // render-gate (FR-016 / FR-030). The repo is read-only + RLS-scoped;
  // a null/error branch collapses to the disabled-card empty state
  // rather than erroring the page. Feature-flag gating
  // (`FEATURE_F5_ONLINE_PAYMENT`) is defense-in-depth with the
  // middleware-layer 503 behavior.
  const paymentSettings = env.features.f5OnlinePayment
    ? await makeDrizzleTenantPaymentSettingsRepo()
        .getByTenantId(tenantCtx.slug)
        .catch(() => null)
    : null;

  const canPayOnline =
    env.features.f5OnlinePayment &&
    invoice.status === 'issued' &&
    paymentSettings !== null &&
    paymentSettings.onlinePaymentEnabled &&
    paymentSettings.enabledMethods.length > 0 &&
    paymentSettings.processorAccountId.length > 0 &&
    paymentSettings.processorPublishableKey.length > 0;

  // G-1 — load any credit notes attached to this invoice so the
  // member sees + can download them. Best-effort: a repo failure
  // falls back to an empty list rather than 500-ing the detail
  // page. 99% of invoices have zero CNs so rendering is gated on
  // the list being non-empty (no single-item noise).
  const portalCreditNotes = await makeDrizzleCreditNoteRepo(tenantCtx.slug)
    .findByOriginalInvoice(asInvoiceId(invoice.invoiceId), tenantCtx.slug)
    .catch(() => [] as never[]);

  // Graceful-degrade: a repo failure hides the refund line, not the void banner.
  const autoRefund =
    invoice.status === 'void'
      ? await makeDrizzlePaymentsRepo(tenantCtx.slug)
          .findStaleInvoiceAutoRefund(invoice.invoiceId)
          .catch(() => null)
      : null;

  return (
    <DetailContainer>
      <PageHeader
        title={`${t('title')} ${documentNumber}`}
        badge={
          <OptimisticPaidOverlay
            invoiceId={invoice.invoiceId}
            whenUnpaid={renderStatusBadge(displayStatus)}
            whenPaid={renderStatusBadge('paid')}
          />
        }
        actions={
          invoice.pdf ? (
            <>
              {/* Resend is hidden on void — member cannot re-mail a
                  voided invoice from self-service (an admin would need
                  to trigger that via the cancellation-notice path). */}
              {invoice.status !== 'void' ? (
                <ResendInvoiceButton
                  invoiceId={invoice.invoiceId}
                  documentNumber={documentNumber}
                  variant="ghost"
                  layout="full"
                  className="min-h-11 px-3"
                />
              ) : null}
              {(() => {
                // Round 6 portal-harden — combined-mode + paid: the
                // invoice PDF *is* the receipt (Thai RD §86/4 + §105ทวิ),
                // so the only legal document the member should grab is
                // the receipt-rendered combined PDF. Hide the pre-payment
                // invoice PDF in that case (it has no receipt fields).
                // Separate-mode + paid: surface BOTH — invoice (Tax
                // Invoice) and receipt (Official Receipt) are distinct
                // legal docs.
                //
                // R7-L4 — `receiptDocumentNumberRaw === null` is the
                // canonical proxy for combined-mode on paid invoices.
                // The numbering mode lives on `tenant_invoice_settings`
                // (mutable per-tenant config); it is NOT mirrored onto
                // the invoice row at issuance time. For PAID invoices,
                // however, the proxy is unambiguous: separate-mode
                // allocates the RC- number at `recordPayment`, so a
                // paid invoice with NULL receipt-number can only be a
                // combined-mode invoice. Adding a redundant
                // `receiptNumberingMode` column would violate
                // Principle X — the proxy is correct, just
                // documented here.
                const isCombinedPaid =
                  invoice.status === 'paid' && invoice.receiptDocumentNumberRaw === null;
                const showInvoicePdf = invoice.pdf !== null && !isCombinedPaid;
                const showReceiptPdf =
                  invoice.status === 'paid' && invoice.receiptPdfStatus === 'rendered';
                // T166-10 — async receipt PDF gate. When the receipt
                // is still being rendered by the cron worker, surface
                // a polite "preparing…" affordance ALONGSIDE the
                // invoice button (separate-mode the member still gets
                // the invoice; combined-mode the receipt IS the only
                // doc so we show the preparing state on its own).
                const receiptPending =
                  invoice.status === 'paid' &&
                  invoice.receiptPdfStatus !== null &&
                  invoice.receiptPdfStatus !== 'rendered';
                return (
                  <>
                    {showInvoicePdf && (
                      <PortalInvoiceDownloadButton
                        invoiceId={invoice.invoiceId}
                        documentNumber={documentNumber}
                        label={
                          invoice.status === 'void'
                            ? t('void.downloadVoidedPdf')
                            : tList('actions.download')
                        }
                        ariaLabel={`${
                          invoice.status === 'void'
                            ? t('void.downloadVoidedPdf')
                            : tList('actions.downloadInvoiceAria', { number: documentNumber })
                        }`}
                        className={cn(
                          buttonVariants({ variant: 'default', size: 'sm' }),
                          'min-h-11 px-4',
                        )}
                        data-testid="portal-download-invoice"
                      />
                    )}
                    {showReceiptPdf && (
                      <PortalReceiptDownloadButton
                        invoiceId={invoice.invoiceId}
                        documentNumber={invoice.receiptDocumentNumberRaw ?? documentNumber}
                        label={
                          isCombinedPaid
                            ? tList('actions.downloadCombined')
                            : tList('actions.downloadReceipt')
                        }
                        ariaLabel={tList('actions.downloadReceiptAria', {
                          number: invoice.receiptDocumentNumberRaw ?? documentNumber,
                        })}
                        className={cn(
                          buttonVariants({
                            variant: isCombinedPaid ? 'default' : 'outline',
                            size: 'sm',
                          }),
                          'min-h-11 px-4',
                        )}
                        data-testid="portal-download-receipt"
                      />
                    )}
                    {receiptPending && (
                      <span
                        role="status"
                        aria-live="polite"
                        aria-busy="true"
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          'min-h-11 px-4 cursor-progress',
                        )}
                      >
                        {t('pdf.preparing')}
                      </span>
                    )}
                  </>
                );
              })()}
            </>
          ) : null
        }
      />

      {/* G-V2 — voided-invoice state banner. Inline section (not
       * <Alert>, not <Card>) mirrors the admin voidDetails pattern
       * at /admin/invoices/[id]/page.tsx so member/admin/email
       * carry the same destructive visual vocabulary. Renders above
       * the totals block because void IS the most load-bearing
       * fact on the page for a voided invoice — everything below
       * is archival reference. */}
      {invoice.status === 'void' && invoice.voidedAt && (
        <section
          aria-labelledby="invoice-void-heading"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-4"
        >
          <h2 id="invoice-void-heading" className="mb-3 text-sm font-medium text-destructive">
            {t('void.title')}
          </h2>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
            <dt className="text-muted-foreground">{t('void.voidedAt')}</dt>
            <dd>{formatDate(invoice.voidedAt, userLocale)}</dd>
            {invoice.voidReason ? (
              <>
                <dt className="text-muted-foreground">{t('void.reasonLabel')}</dt>
                <dd className="whitespace-pre-wrap">{invoice.voidReason}</dd>
              </>
            ) : null}
          </dl>
          <p className="mt-3 text-sm text-destructive">{t('void.notPayable')}</p>
          {autoRefund && (
            // Reassuring-news block. Outer <section aria-labelledby>
            // creates a screen-reader landmark separate from the
            // destructive void parent. INNER <div role="status"> hosts
            // the live region — split because nesting role="status"
            // and the section's implicit `region` role on the same
            // element causes JAWS to drop the landmark from nav lists.
            // Visual: thick left border (--primary) is dark-mode-safe
            // even if a tenant's --accent token drifts close to
            // --destructive — the border guarantees visual separation
            // from the void block above without relying on bg contrast.
            <section
              aria-labelledby="invoice-auto-refund-heading"
              data-testid="portal-invoice-auto-refund-notice"
              className="mt-4 rounded-md border border-border border-l-4 border-l-primary bg-card p-3"
            >
              <h3 id="invoice-auto-refund-heading" className="text-sm font-medium text-foreground">
                {t('void.autoRefundHeading')}
              </h3>
              <div role="status" aria-live="polite">
                <p className="mt-1 text-sm text-muted-foreground">{t('void.autoRefundBody')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('void.autoRefundContact')}</p>
                {autoRefund.processorRefundId && (
                  <p
                    className="mt-2 font-mono text-xs text-muted-foreground"
                    data-testid="portal-invoice-auto-refund-ref"
                  >
                    {t('void.autoRefundRef', {
                      // Stripe refund IDs are stable identifiers — full
                      // value is safe to surface (no PCI scope; no
                      // member PII). Truncating to last 8 keeps the line
                      // scannable on mobile + matches what most banks
                      // ask for in support tickets.
                      ref: autoRefund.processorRefundId.slice(-8),
                    })}
                  </p>
                )}
              </div>
            </section>
          )}
        </section>
      )}

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
            <p className="text-body">
              {invoice.paidAt ? formatDate(invoice.paidAt, userLocale) : '—'}
            </p>
          </div>
          {/* Round 6 portal-harden — surface receipt document number to
              members in separate-mode + paid. Thai RD requires receipt
              holders to keep the document; admins see this on the admin
              detail page (added Round 1). Combined-mode hides this
              because the invoice number IS the receipt number. */}
          {invoice.status === 'paid' && invoice.receiptDocumentNumberRaw && (
            <div>
              <p className="text-caption uppercase tracking-wide text-muted-foreground">
                {t('fields.receiptNumber')}
              </p>
              <p className="text-body font-mono tabular-nums">{invoice.receiptDocumentNumberRaw}</p>
            </div>
          )}
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
            <Table aria-label={t('linesHeading')}>
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
                  const primaryLang = userLocale === 'th' ? 'th' : 'en';
                  const secondaryLang = userLocale === 'th' ? 'en' : 'th';
                  // R20-03 — `lang` attribute only when it differs from
                  // the page root locale (userLocale drives the page's
                  // <html lang>, so the primary span inherits for free).
                  // Keeps markup cleaner while WCAG 3.1.2 still holds:
                  // the *secondary* span always gets lang tagged
                  // because its language differs from the root.
                  const primaryLangAttr = primaryLang === userLocale ? undefined : primaryLang;
                  const secondaryLangAttr =
                    secondaryLang === userLocale ? undefined : secondaryLang;
                  const primary = userLocale === 'th' ? line.descriptionTh : line.descriptionEn;
                  const secondary = userLocale === 'th' ? line.descriptionEn : line.descriptionTh;
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
                        <span lang={primaryLangAttr} className="block text-body font-medium">
                          {primary}
                        </span>
                        {!sameText ? (
                          <span lang={secondaryLangAttr} className="block text-body">
                            {secondary}
                          </span>
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
            <dd className="tabular-nums sm:justify-self-end">{formatSatangThb(vat, userLocale)}</dd>
            <dt className="text-body font-medium uppercase tracking-wide">{t('totals.total')}</dt>
            <dd className="text-body font-medium tabular-nums sm:justify-self-end">
              {formatSatangThb(total, userLocale)}
            </dd>
          </dl>
        </CardContent>
      </Card>

      {/* F5 G4 T081 — online payment entry point. Only surfaced for
       * 'issued' invoices; other states (paid / void / credited)
       * render nothing here since there is nothing for the member
       * to pay.
       *
       * R5 round-7 (2026-04-26): wrapped in <OptimisticPaidOverlay>
       * so the Pay-now button hides INSTANTLY once PaySheet
       * dispatches the optimistic-paid event — without waiting for
       * the server-side invoice.status flip. Prevents the
       * "ConfirmationPanel up + Pay-now button STILL rendered"
       * UX glitch.
       */}
      {/*
       * R7 (2026-04-26): NO <OptimisticPaidOverlay> wrapper around
       * <PayNowButton> — wrapping unmounts the Radix Sheet portal
       * (rooted at PayNowButton's subtree) the instant the optimistic
       * CustomEvent fires, killing <ConfirmationPanel> mid-render.
       * Visibility instead flips via the page-level `router.refresh()`
       * in PaySheet's settled effect; the drawer's own auto-close
       * covers the brief gap so no "Paid badge + Pay button" glitch.
       * The badge above CAN still use the overlay — it mounts only a
       * static <Badge>, no portal children.
       */}
      {invoice.status === 'issued' ? (
        canPayOnline && paymentSettings ? (
          <PayNowButton
            invoice={{
              id: invoice.invoiceId,
              invoiceNumber: documentNumber,
              amountDue: total !== null ? Number(total) : 0,
              currency: 'THB',
              status: invoice.status,
            }}
            enabledMethods={paymentSettings.enabledMethods}
            tenantPublishableKey={paymentSettings.processorPublishableKey}
          />
        ) : (
          <OnlinePaymentDisabledCard invoiceNumber={documentNumber} tenantContactEmail={null} />
        )
      ) : null}

      {portalCreditNotes.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <h2 className="text-h4">{t('creditNotes.heading')}</h2>
            <p className="text-caption text-muted-foreground">{t('creditNotes.description')}</p>
            <ul role="list" className="flex flex-col gap-2">
              {portalCreditNotes.map((pcn) => (
                <li
                  key={pcn.creditNoteId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-sm font-medium">{pcn.documentNumber.raw}</span>
                    <span className="text-caption text-muted-foreground tabular-nums">
                      {formatDate(pcn.issueDate, userLocale)} ·{' '}
                      {formatSatangThb(pcn.total.satang, userLocale)}
                    </span>
                  </div>
                  <Link
                    href={`/portal/credit-notes/${pcn.creditNoteId}`}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                      'min-h-11 px-4',
                    )}
                    aria-label={t('creditNotes.viewAria', {
                      number: pcn.documentNumber.raw,
                    })}
                  >
                    {t('creditNotes.view')}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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
