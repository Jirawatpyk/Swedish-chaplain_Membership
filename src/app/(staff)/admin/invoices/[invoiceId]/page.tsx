/**
 * T056 — /admin/invoices/[invoiceId] detail page.
 *
 * F5R6+ fix — `export const dynamic = 'force-dynamic'` paired with
 * the sibling `not-found.tsx` is required for `notFound()` to set
 * HTTP status 404 (not 200) under Next.js 16 RSC streaming. Mirrors
 * the F7 broadcast pattern at `src/app/(member)/portal/broadcasts/
 * [id]/page.tsx:44`. Without `force-dynamic`, response headers commit
 * before `notFound()` resolves and 200 leaks even when the body
 * renders the not-found UI. Pinned by `tests/e2e/invoice-draft-issue
 * .spec.ts` AS6.
 */
export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.meta');
  return { title: t('title') };
}
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { env } from '@/lib/env';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import {
  getInvoice,
  makeGetInvoiceDeps,
  Money,
  calculateVat,
  computeIsOverdue,
  displayDocumentNumber,
  billFirstDocumentNumber,
  invoiceStatusHasReceipt,
  resolveTaxDocumentKind,
  maybeEmitOverdueDetected,
  makeOverdueAuditPort,
} from '@/modules/invoicing';
// Direct infra import for the settings read — same escape-hatch as
// the B2 settings page. This is a READ against the public port
// `getForIssue`, not a deep reach into internals.
 
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
// Same escape-hatch as the tenant-settings repo read above: a public-
// port read (`findByOriginalInvoice`) used to populate the "Credit
// Notes attached" section. No Application-layer use-case exists yet
// for this list (Phase 10 candidate); the infra repo is called
// directly.
 
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
// Same documented escape-hatch as the two reads above: a tenant-scoped infra
// read (FR-026 failed-auto-email surface), no Application use-case needed.
import {
  findFailedAutoEmailsByInvoice,
  resendVariantForFailedEvent,
} from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { asInvoiceId } from '@/modules/invoicing';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
// Raw repo read mirrors the escape hatch used by /admin/users page.tsx —
// an Application-layer `getStaffUser` would be a passthrough. Read is
// admin-gated by the layout guard.
 
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asUserId } from '@/modules/auth';
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
import { IssueInvoiceDialog } from '../_components/issue-invoice-dialog';
import { RecordPaymentDialog } from '../_components/record-payment-dialog';
import { DeleteDraftDialog } from '../_components/delete-draft-dialog';
import { InvoiceMoreMenu } from '../_components/invoice-more-menu';
import { EmailFailureAlert } from '../_components/email-failure-alert';
import { AutoRefundFailedAlert } from '../_components/auto-refund-failed-alert';
import { PaymentTimeline } from './_components/payment-timeline';
import { PaymentTimelineSkeleton } from './_components/payment-timeline-skeleton';
import { RefundDialog } from './_components/refund-dialog';
import { computeRemainingRefundable } from '@/modules/payments';
// F5 UX D2 — tenant-scoped audit read for the failed-auto-refund alert. Same
// documented escape-hatch as the tenant-settings / credit-note reads above:
// a tenant-scoped infra read (RLS+FORCE), no Application use-case needed.
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { getInvoicePaymentActivity } from './_lib/cached-payment-activity';

// F5 UX D2 — the out-of-band-refund reconciliation runbook (repo-relative doc
// path, same literal the `auto_refund_failed_needs_manual_reconcile` forensic
// stamps into its payload). Surfaced to the admin so they can follow it.
const OOB_RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  // N11 — explicit `'en-US'` locale pins thousand-separator output on
  // Vercel runtimes whose process locale may be `C`/`POSIX` (emits no
  // separator). Thai-tax amounts are legal figures; deterministic
  // formatting is required by FR-005.
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
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
  // M3 — use the next-intl locale for date display so TH/SV users
  // see their localised format instead of the browser default.
  const locale = (await import('next-intl/server')).getLocale;
  const userLocale = await locale();

  const hdrs = await headers();
  const requestId = requestIdFromHeaders(hdrs);
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const result = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
    // Actor context — enables invoice_cross_tenant_probe audit emit
    // when an admin navigates to /admin/invoices/<foreign-id>.
    actor: {
      userId: currentUser.id,
      role: currentUser.role as 'admin' | 'manager' | 'member',
      requestId,
    },
  });
  if (!result.ok) return notFound();
  const invoice = result.value;

  // Look up plan display name so we don't show the raw planId slug.
  // Event-fee invoices have NO plan (`invoices_subject_fields_ck` pins
  // plan_id/plan_year NULL) — skip the lookup entirely instead of
  // querying listPlans with a null year on every event detail view.
  const plansResult =
    invoice.invoiceSubject === 'membership'
      ? await listPlans({ filter: { year: invoice.planYear as never } }, buildPlansDeps(tenantCtx))
      : null;
  const foundPlan = plansResult?.ok
    ? plansResult.value.data.find((p) => p.plan_id === invoice.planId)
    : undefined;
  // 054-event-fee-invoices — plan_id is non-null on membership invoices
  // (`invoices_subject_fields_ck`); coalesce to '—' so the display string
  // narrows for event-fee invoices (no plan) reaching this membership view.
  const planDisplayName: string = foundPlan
    ? (typeof foundPlan.plan_name === 'object' && foundPlan.plan_name !== null
        ? ((foundPlan.plan_name as { en?: string }).en ?? invoice.planId ?? '—')
        : String(foundPlan.plan_name ?? invoice.planId ?? '—'))
    : (invoice.planId ?? '—');

  // Prefer the frozen snapshot on issued/paid/void invoices (FR-038);
  // fall back to a live member lookup only for drafts (which have no
  // snapshot yet). getMember emits `member_cross_tenant_probe` on 404
  // with the signed-in admin's user id as actor.
  const snapshotName = (invoice.memberIdentitySnapshot as { legal_name?: string } | null)?.legal_name;
  // 064 main-agent recheck — this detail page serves BOTH subjects (the
  // earlier "event invoices get their own surface later" assumption was
  // stale). Non-member event invoices (member_id NULL) display the
  // draft/issue-pinned buyer snapshot's legal_name and MUST NOT render a
  // member link — `/admin/members/null` 404s; same rule the invoices LIST
  // applies to its buyer column (054 spec).
  let memberDisplayName = snapshotName ?? invoice.memberId ?? '—';
  // 066-membership-no-tin — default true so the pre-issue "no Tax ID" hint never
  // shows on a false assumption; only flipped false when we positively load a
  // draft buyer with no TIN. Drafts have no pinned snapshot, so this live member
  // lookup (already done for the display name) is the source of truth.
  let buyerHasTaxId = true;
  // 088 T017a / FR-027 — buyer legal_entity_type drives the pre-issue Head-Office/
  // Branch preview + the fail-closed NULL-entity warning. Loaded from the live
  // member (drafts only) alongside the display name; NULL for a non-member event
  // draft (which the review dialog treats as non-membership).
  let buyerLegalEntityType: string | null = null;
  if (!snapshotName && invoice.memberId !== null) {
    const memberResult = await getMember(
      invoice.memberId as MemberId,
      { actorUserId: currentUser.id, requestId },
      buildMembersDeps(tenantCtx),
    );
    if (memberResult.ok) {
      memberDisplayName = memberResult.value.member.companyName;
      buyerHasTaxId = memberResult.value.member.taxId !== null;
      buyerLegalEntityType = memberResult.value.member.legalEntityType;
    }
  }

  // Resolve staff-user display names for the audit fields on the
  // paid / void sections. Showing a raw UUID in "Recorded by" tells
  // the admin nothing — email is the smallest humane identifier we
  // have today (TODO: add display_name when F1 user profile lands).
  async function resolveUserEmail(userId: string | null): Promise<string> {
    if (!userId) return '—';
    const row = await userRepo.findById(asUserId(userId));
    return row?.email ?? userId;
  }
  const [paymentRecordedByEmail, voidedByEmail] = await Promise.all([
    resolveUserEmail(invoice.paymentRecordedByUserId),
    resolveUserEmail(invoice.voidedByUserId),
  ]);

  // Phase-10 polish — load any credit notes attached to this invoice
  // so the detail page can surface the CN list inline. Cheap: no CN
  // rows are returned for 99% of invoices (only paid/credited ones
  // can have any); the "don't render when empty" rule keeps the
  // section invisible on the common path.
  const creditNoteRepo = makeDrizzleCreditNoteRepo(tenantCtx.slug);
  const creditNotes = await creditNoteRepo.findByOriginalInvoice(
    asInvoiceId(invoiceId),
    tenantCtx.slug,
  );

  const isDraft = invoice.status === 'draft';
  const isAdmin = currentUser.role === 'admin';

  // Resend-eligibility gates — SHARED with InvoiceMoreMenu below so the
  // failure banner + the action menu stay in lockstep (combined-mode rule,
  // Thai RD §86/4): paid+combined hides invoice-resend (the combined receipt
  // is the single legal document; the issue-time invoice PDF is a stale draft),
  // and receipt-resend requires a paid invoice with a rendered receipt PDF.
  //
  // 064 — `pdfDocKind === 'receipt_combined'` marks an as-paid TIN event
  // invoice whose MAIN pdf already IS the final combined §86/4+§105ทวิ
  // document (issued straight to paid; receipt_* blob columns stay NULL).
  // The stale-draft-hiding rule therefore applies ONLY when the main pdf is
  // an issue-time 'invoice' — without the `!mainPdfIsFinalCombined` guard an
  // as-paid row matched BOTH heuristics (paid + raw NULL + no receiptPdf)
  // and rendered with NO downloadable document at all. Download + resend of
  // the main pdf on these rows ships the real final document.
  const mainPdfIsFinalCombined = invoice.pdfDocKind === 'receipt_combined';
  // 092 — the receipt-availability + bill-hiding gates use the receipt-bearing
  // status set {paid, partially_credited, credited}, not `paid` alone: a §86/10
  // credit note does NOT cancel the §86/4 receipt (it stays downloadable +
  // re-sendable) NOR un-hide the stale combined-mode bill. `void` excluded (its
  // own VOID-stamped path, FR-015). Lockstep with the portal fix.
  const isPaidCombined =
    invoiceStatusHasReceipt(invoice.status) &&
    invoice.receiptDocumentNumberRaw === null &&
    !mainPdfIsFinalCombined;
  const hasReceiptPdf =
    invoiceStatusHasReceipt(invoice.status) && Boolean(invoice.receiptPdf);

  // FR-026 — surface permanently-failed auto-email deliveries to admins.
  // Drafts never auto-email, so skip the read for them.
  const failedEmails = isDraft
    ? []
    : await findFailedAutoEmailsByInvoice(invoiceId, tenantCtx.slug);
  // An invoice can have BOTH a failed invoice-copy AND a failed receipt-copy
  // email (e.g. issue bounced, then the paid-receipt also bounced). Surface ONE
  // banner per distinct document so neither stays hidden + un-resendable. Rows
  // arrive newest-first, so the first per variant is the latest failure.
  const failedEmailBanners: ReadonlyArray<{
    readonly variant: 'invoice' | 'receipt';
    readonly recipientEmail: string;
    readonly canResend: boolean;
  }> = (() => {
    const byVariant = new Map<'invoice' | 'receipt', string>();
    for (const e of failedEmails) {
      const v = resendVariantForFailedEvent(e.eventType);
      if (!byVariant.has(v)) byVariant.set(v, e.recipientEmail);
    }
    return [...byVariant.entries()].map(([variant, recipientEmail]) => ({
      variant,
      recipientEmail,
      // Mirror InvoiceMoreMenu's showResendInvoice / showResendReceipt gates.
      canResend:
        variant === 'receipt'
          ? hasReceiptPdf
          : invoice.status !== 'void' &&
            Boolean(invoice.pdf) &&
            !isPaidCombined,
    }));
  })();

  // F5 UX D2 — surface a permanently-failed auto-refund (a
  // `auto_refund_failed_needs_manual_reconcile` forensic exists → the stale-
  // invoice auto-refund did NOT return the money; funds stuck pending manual
  // reconciliation). Reuses the SAME tenant-scoped audit read as the member
  // banner (`findStaleInvoiceAutoRefund`, which now also reports `failed`).
  // Drafts never auto-refund, so skip the read for them; best-effort so a repo
  // failure hides the alert rather than 500-ing the page (mirrors the void
  // banner's graceful-degrade on the member surface).
  const autoRefundStatus = isDraft
    ? null
    : await makeDrizzlePaymentsRepo(tenantCtx.slug)
        .findStaleInvoiceAutoRefund(invoiceId)
        .catch(() => null);
  const autoRefundFailed = autoRefundStatus?.failed === true;

  // T109 — derive the presentation-only `overdue` variant + fire the
  // opportunistic `invoice_overdue_detected` audit on first detection
  // per Bangkok-local day (idempotent via migration 0021's partial
  // unique idx). Detail page is a single-invoice read, so the emit
  // is cheap (one insert, dedup by index on repeat views the same
  // day). Fire-and-forget — swallowed-adapter errors do not 500 the
  // page because the adapter's catch logs pino and returns false.
  const nowUtcIso = new Date().toISOString();
  // Tenant-timezone (Asia/Bangkok) "today" — the SAME helper that stamps
  // `issue_date`. Threaded to the Record-payment dialog so its date
  // picker clamps against the Bangkok date, not the client's UTC date
  // (the UTC date lags Bangkok by one for ~7h/day, which made the
  // payment-date window empty for same-day-issued invoices).
  const bangkokTodayIso = bangkokLocalDate(nowUtcIso);
  const overdueDetected = computeIsOverdue(invoice, nowUtcIso);
  const displayStatus = overdueDetected ? 'overdue' : invoice.status;
  if (overdueDetected) {
    void maybeEmitOverdueDetected(
      makeOverdueAuditPort(),
      invoice,
      nowUtcIso,
      { userId: currentUser.id, requestId: requestId ?? null },
    );
  }

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

    // R7-B2 follow-up — source VAT from `tenant_invoice_settings`
    // (the `issue-invoice` use-case's source of truth, FR-009/011),
    // NOT from F2 `tenant_fee_config`. The two tables can drift and
    // the invoice will be snapshotted from invoice-settings at
    // issue time — the draft preview MUST match what issuance will
    // produce, otherwise admin sees one number and commits another.
    const invoiceSettings = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);
    if (invoiceSettings) {
      const { vat, total } = calculateVat(sub, invoiceSettings.vatRate);
      displayVatSatang = vat.satang;
      displayTotalSatang = total.satang;
      displayVatPercent = invoiceSettings.vatRate.toPercentString();
    }
  }

  // 064 remediation S2 — β as-paid no-TIN rows have a NULL invoice document
  // number; their printed §105 number lives in receiptDocumentNumberRaw.
  // `displayDocumentNumber` resolves whichever exists so a PAID β row never
  // renders under the "Draft invoice" title/breadcrumb. Both-null = a true
  // draft → the draft label.
  const displayNumber = displayDocumentNumber(invoice);
  // 088 A-refined (FR-016) — the two-document kind, gated on the flag AND this
  // being a real 088 bill (bill number present). The invoice is ALWAYS
  // identified by its OWN (SC) NON-§87 bill number — paid or unpaid — so
  // `headerNumber` is the SC bill for ANY 088 bill (never the RC on payment).
  // The RC §86/4 tax receipt is surfaced in the "Receipt No." field below.
  const taxDocKind = resolveTaxDocumentKind(
    invoice,
    env.features.f088TaxAtPayment,
  );
  const headerNumber =
    taxDocKind !== 'none' ? invoice.billDocumentNumberRaw : displayNumber;
  const breadcrumbLabel = headerNumber ?? displayNumber ?? t('draftTitle');

  // Load payment activity at page level so the Refund action button
  // can be rendered conditionally on succeeded-payment + remaining-
  // refundable presence. Shares the React `cache()`-deduplicated
  // loader with the Suspense'd PaymentTimeline panel below — one
  // DB roundtrip per request, not two.
  let refundButtonProps: {
    paymentId: string;
    remainingRefundableSatang: bigint;
    pendingRefundExists: boolean;
  } | null = null;
  if (
    isAdmin &&
    (invoice.status === 'paid' || invoice.status === 'partially_credited')
  ) {
    const activity = await getInvoicePaymentActivity(
      tenantCtx.slug,
      invoiceId,
    );
    if (activity.ok) {
      const remaining = computeRemainingRefundable(activity.value);
      if (remaining) {
        // Gap E (2026-07-12) — gate the Issue-refund action on a NON-terminal
        // (pending/async) refund for THIS payment. Pending amounts are NOT
        // subtracted from `remaining` (a pending refund can still FAIL, after
        // which the balance must be refundable again); the button is disabled
        // on pending-EXISTENCE instead, so a later failure re-enables it.
        const pendingRefundExists = activity.value.refunds.some(
          (r) =>
            r.paymentId === remaining.paymentId && r.status === 'pending',
        );
        refundButtonProps = {
          paymentId: remaining.paymentId,
          remainingRefundableSatang: remaining.remainingSatang,
          pendingRefundExists,
        };
      }
    }
  }

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={invoiceId} label={breadcrumbLabel} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {/* 088 A-refined — the header ALWAYS reads under the invoice's OWN
                (SC) bill number for a real 088 bill (paid or unpaid, never "Draft
                invoice"); a paid bill's RC §86/4 tax receipt is surfaced in the
                "Receipt No." field below. No extra document-kind tag — the SC-
                prefix + the "Receipt No." field are self-documenting. */}
            <span>{headerNumber ?? displayNumber ?? t('draftTitle')}</span>
            <Badge variant={statusBadgeVariant(displayStatus)}>
              {tStatus(displayStatus)}
            </Badge>
          </span>
        }
        actions={
          <>
            {isDraft && isAdmin && (
              <>
                <a
                  href={`/api/invoices/${invoice.invoiceId}/preview`}
                  className={buttonVariants({ variant: 'outline' })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('actions.preview')}
                </a>
                {/* Issue — AlertDialog pattern (align with F3 archive /
                    F2 clone-year). Confirmation stays in-context so
                    the admin sees the summary numbers as they type
                    the irreversible phrase. */}
                <DeleteDraftDialog invoiceId={invoice.invoiceId} />
                <IssueInvoiceDialog
                  invoiceId={invoice.invoiceId}
                  // 066 — only MEMBERSHIP no-TIN buyers get the input-VAT note;
                  // events are issue-blocked (event_no_tin_requires_paid_issue),
                  // so the hint would never apply to them.
                  showNoTaxIdHint={
                    invoice.invoiceSubject === 'membership' && !buyerHasTaxId
                  }
                  // 088 T017a / FR-027 — pre-issue review + immutable-snapshot
                  // acknowledgement, gated by the tax-at-payment flag. The §86/4
                  // branch preview + WHT-note row are membership-scoped;
                  // vatTreatment / cert / bank-block-payment-path light up when
                  // US8 / US5 land (default off until then).
                  taxAtPayment={env.features.f088TaxAtPayment}
                  isMembership={invoice.invoiceSubject === 'membership'}
                  legalEntityType={buyerLegalEntityType}
                  // 088 US8 (T061d) — draft subtotal in satang (plain number;
                  // a bigint cannot cross the RSC → client-prop boundary)
                  // drives the ≥ 5,000 THB zero-rate advisory in the form.
                  subtotalSatang={
                    displaySubtotalSatang !== null
                      ? Number(displaySubtotalSatang)
                      : null
                  }
                  summary={{
                    memberName: memberDisplayName,
                    planDisplayName,
                    // 054-event-fee-invoices — membership invoices always carry
                    // plan_year (`invoices_subject_fields_ck`); coalesce for type.
                    planYear: invoice.planYear ?? 0,
                    subtotalText: formatSatang(displaySubtotalSatang),
                    vatText: formatSatang(displayVatSatang),
                    vatPercent: displayVatPercent ?? '',
                    totalText: formatSatang(displayTotalSatang),
                  }}
                />
              </>
            )}
            {invoice.status === 'issued' && isAdmin && (
              // Pay — Dialog pattern (align with F1 invite / F1 change
              // password). Short 4-field form, in-context overlay so
              // the admin still sees the invoice total + document
              // number in the background card.
              <RecordPaymentDialog
                invoiceId={invoice.invoiceId}
                // 088 FR-030 — bill-first: an issued 088 bill's number is its SC
                // (`billDocumentNumberRaw`); legacy §87 rows keep documentNumber.
                documentNumber={billFirstDocumentNumber(invoice)}
                issueDate={invoice.issueDate}
                todayIso={bangkokTodayIso}
              />
            )}
            {invoice.status === 'issued' && isAdmin && (
              // Void — destructive terminal action on issued-unpaid
              // invoices (US5 / FR-008). Routes to the typed-phrase
              // confirm page at /admin/invoices/[id]/void rather than
              // using an in-context dialog — a typed-phrase gate is
              // high-friction by design (the phrase is the invoice's
              // document number; see void-confirm-dialog.tsx) and
              // deserves its own route for deep-linking + staging walk-
              // throughs (CP-9.3). Rendered as a destructive outline
              // button so it sits visually next to Pay without
              // outranking it as a primary action.
              <Link
                href={`/admin/invoices/${invoice.invoiceId}/void`}
                className={buttonVariants({ variant: 'destructive-outline' })}
                data-testid="void-invoice-trigger"
              >
                {t('actions.void')}
              </Link>
            )}
            {(invoice.status === 'paid' || invoice.status === 'partially_credited') &&
              isAdmin && (
                <Link
                  href={`/admin/invoices/${invoice.invoiceId}/credit-notes/new`}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('actions.issueCreditNote')}
                </Link>
              )}
            {/* F5 Phase 6 (T112) — Refund online payment. Only appears
                when the invoice was paid via Stripe (i.e. there is a
                succeeded F5 payment with remaining refundable balance
                > 0). Sits next to the F4 manual credit-note CTA so
                admins see both options on paid invoices. */}
            {refundButtonProps && (
              // C1: wrap in <Suspense> because
              // RefundDialog reads useSearchParams() — without a
              // Suspense boundary Next.js bails the entire page out
              // to CSR, losing SSR + streaming.
              <Suspense
                fallback={
                  /* R2 F-3 (2026-04-27): invisible-but-present
                   * placeholder reserves the button's layout space so
                   * the surrounding grid does not shift while the
                   * dialog hydrates. `aria-hidden` keeps it out of AT
                   * during the brief flash. */
                  <div
                    aria-hidden="true"
                    className="h-9 w-32 opacity-0"
                  />
                }
              >
                <RefundDialog
                  paymentId={refundButtonProps.paymentId}
                  invoiceId={invoice.invoiceId}
                  memberCompanyName={memberDisplayName}
                  remainingRefundableSatang={
                    refundButtonProps.remainingRefundableSatang
                  }
                  currencyCode={
                    (invoice.tenantIdentitySnapshot as { currency_code?: string } | null)
                      ?.currency_code ?? 'THB'
                  }
                  receiptDocumentNumberRaw={invoice.receiptDocumentNumberRaw}
                  // 088 FR-030 — bill-first for an 088 bill (documentNumber NULL).
                  invoiceDocumentNumber={billFirstDocumentNumber(invoice)}
                  // Gap E — disable + show "settling" while a pending async
                  // refund exists for this payment.
                  pendingRefundExists={refundButtonProps.pendingRefundExists}
                />
              </Suspense>
            )}
            {/* Secondary actions (Download PDF, Resend invoice, Resend
                receipt) collapse into one "⋯" icon dropdown so the
                action row exposes only primary/destructive CTAs as
                standalone buttons. Menu returns null when nothing to
                show. T107 visibility rules preserved inside the menu. */}
            {/* Combined-mode rule (Thai RD §86/4 + §105ทวิ): ONE legal document
                with dual function. paid+combined (bill-first) → hide the
                pre-payment invoice PDF + resend (stale drafts), show only the
                combined receipt; paid+separate → all 4 items; issued/void →
                invoice PDF only. 064 as-paid TIN → the MAIN pdf IS the final
                combined doc (no receipt blob), so the main Download/Resend stay
                visible and the Download item carries the combined label via
                `mainDownloadKind`. isPaidCombined + hasReceiptPdf are
                hoisted above (shared with the FR-026 failure banner so both
                surfaces gate identically). */}
            {!isDraft && (
              <InvoiceMoreMenu
                invoiceId={invoice.invoiceId}
                // 064 remediation S2 — display number, never a raw UUID: β
                // rows resolve to their printed §105 receipt number (drives
                // the download filename + every aria inside the menu).
                // 088 FR-030 — fall back to the SC bill number before the UUID so
                // an unpaid 088 bill (displayNumber NULL) is named by its SC.
                documentNumber={displayNumber ?? invoice.billDocumentNumberRaw ?? invoice.invoiceId}
                // 088 (T065 review fix) — on a paid 088 bill `displayNumber`
                // resolves to the RC §86/4 tax-receipt number, but the MAIN
                // (`showDownload`) PDF is the non-tax SC bill, so name that
                // download by the SC bill number (the receipt arm keeps the RC).
                // Conditional spread honours `exactOptionalPropertyTypes`.
                {...(taxDocKind === 'tax_receipt' && invoice.billDocumentNumberRaw
                  ? { invoiceDownloadNumber: invoice.billDocumentNumberRaw }
                  : {})}
                showDownload={Boolean(invoice.pdf) && !isPaidCombined}
                showResendInvoice={
                  isAdmin &&
                  invoice.status !== 'void' &&
                  Boolean(invoice.pdf) &&
                  !isPaidCombined
                }
                showResendReceipt={isAdmin && hasReceiptPdf}
                showDownloadReceipt={hasReceiptPdf}
                // 064 remediation A4 — what the main pdf IS: combined for
                // as-paid TIN rows, receipt for β/legacy §105 rows whose
                // main pdf is itself the receipt; plain invoice otherwise.
                mainDownloadKind={
                  invoice.pdfDocKind === 'receipt_combined'
                    ? 'combined'
                    : invoice.pdfDocKind === 'receipt_separate'
                      ? 'receipt'
                      : undefined
                }
                // combinedModeReceipt is derived inside the menu component
                // from (showDownloadReceipt && !showDownload).
              />
            )}
          </>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* FR-026 — one delivery-failure banner per failed document (admins
              only); invoice + receipt copies can both fail independently. */}
          {isAdmin &&
            failedEmailBanners.map((b) => (
              <EmailFailureAlert
                key={b.variant}
                invoiceId={invoice.invoiceId}
                recipientEmail={b.recipientEmail}
                variant={b.variant}
                canResend={b.canResend}
              />
            ))}
          {/* F5 UX D2 — failed stale-invoice auto-refund (money not returned);
              admins only. Ranks with the email-failure banners as a top-of-card
              red flag so an admin cannot miss stuck funds. */}
          {isAdmin && autoRefundFailed && (
            <AutoRefundFailedAlert
              invoiceId={invoice.invoiceId}
              processorRefundId={autoRefundStatus?.processorRefundId ?? null}
              runbookUrl={OOB_RUNBOOK_URL}
            />
          )}
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t('fields.memberId')}</dt>
              <dd>
                {/* Non-member event buyer: plain text — a member link would
                    href /admin/members/null and 404 (LIST buyer-column rule). */}
                {invoice.memberId !== null ? (
                  <Link
                    href={`/admin/members/${invoice.memberId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {memberDisplayName}
                  </Link>
                ) : (
                  memberDisplayName
                )}
              </dd>
            </div>
            {/* Plan row is membership-only: event-fee invoices carry no plan
                (plan_id/plan_year NULL) — rendering it would show "— / ". */}
            {invoice.invoiceSubject === 'membership' && (
              <div>
                <dt className="text-muted-foreground">{t('fields.plan')}</dt>
                <dd>
                  {planDisplayName}{' '}
                  <span className="text-muted-foreground">/ {invoice.planYear}</span>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
              <dd>{formatLocalisedDate(invoice.issueDate ?? '', userLocale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.dueDate')}</dt>
              <dd>{formatLocalisedDate(invoice.dueDate ?? '', userLocale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</dd>
            </div>
            {/* Receipt No. — visible on separate-mode rows (the receipt has
                its own §87 sequence) that reached payment. Shown on paid AND
                credited/partially_credited: the receipt number, once issued,
                is a permanent §87 record even after a credit note corrects
                the invoice. Combined-mode rows reuse the invoice doc number
                (receiptDocumentNumberRaw null) and render nothing here.
                thai-tax review 2026-06-07. */}
            {invoice.receiptDocumentNumberRaw &&
              invoiceStatusHasReceipt(invoice.status) && (
              <div>
                <dt className="text-muted-foreground">{t('fields.receiptNumber')}</dt>
                <dd
                  className="font-mono"
                  data-testid="invoice-receipt-number"
                >
                  {invoice.receiptDocumentNumberRaw}
                </dd>
              </div>
            )}
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

          {/* Payment details — visible once a payment has been recorded. Shows
              who recorded the payment, when, and the supporting reference/notes
              so finance + audit both have the story on one screen. Gated on the
              receipt-bearing set {paid, partially_credited, credited} (092): a
              recorded payment does NOT disappear when a §86/10 credit note later
              reduces the invoice — the panel would otherwise vanish on the first
              credit note, hiding who/when the payment was recorded. `void` is
              excluded (its own path). */}
          {invoiceStatusHasReceipt(invoice.status) && (
            <section
              id="payment"
              className="mt-2 scroll-mt-20 rounded-md border bg-muted/30 p-4"
              aria-labelledby="payment-details-heading"
            >
              <h3
                id="payment-details-heading"
                className="mb-3 text-sm font-medium"
              >
                {t('payment.title')}
              </h3>
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('payment.paymentDate')}</dt>
                  {/* paymentDate is a Postgres `date` (date-only) — UTC-pin so the
                      day never shifts for browsers west of UTC. */}
                  <dd>{formatLocalisedDate(invoice.paymentDate ?? '', userLocale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.paidAt')}</dt>
                  {/* paidAt is a Postgres `timestamptz` (real instant) — do NOT
                      UTC-pin; render in the user's local timezone intentionally. */}
                  <dd>{formatLocalisedDate(invoice.paidAt ?? '', userLocale, { year: 'numeric', month: 'short', day: 'numeric' })}</dd>
                </div>
                {/* No separate "Amount paid" row — partial payments are
                    out of MVP scope (spec §US2 AS4), so paid amount is
                    always invoice.total which is already in the main
                    summary above. Add this row when partial payments
                    land. */}
                <div>
                  <dt className="text-muted-foreground">{t('payment.method')}</dt>
                  <dd>
                    {invoice.paymentMethod
                      ? t(`payment.methods.${invoice.paymentMethod}`)
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.reference')}</dt>
                  <dd className="font-mono text-xs">
                    {invoice.paymentReference ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.recordedBy')}</dt>
                  <dd>{paymentRecordedByEmail}</dd>
                </div>
                {invoice.paymentNotes && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('payment.notes')}</dt>
                    <dd className="whitespace-pre-wrap">
                      {invoice.paymentNotes}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {/* Void details — parallel structure for voided invoices. */}
          {invoice.status === 'void' && (
            <section
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-4"
              aria-labelledby="void-details-heading"
            >
              <h3
                id="void-details-heading"
                className="mb-3 text-sm font-medium text-destructive"
              >
                {t('voidDetails.title')}
              </h3>
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('voidDetails.voidedAt')}</dt>
                  {/* voidedAt is a Postgres `timestamptz` (real instant) — do NOT
                      UTC-pin; render in the user's local timezone intentionally. */}
                  <dd>{formatLocalisedDate(invoice.voidedAt ?? '', userLocale, { year: 'numeric', month: 'short', day: 'numeric' })}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('voidDetails.voidedBy')}</dt>
                  <dd>{voidedByEmail}</dd>
                </div>
                {invoice.voidReason && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('voidDetails.reason')}</dt>
                    <dd className="whitespace-pre-wrap">{invoice.voidReason}</dd>
                  </div>
                )}
              </dl>
              {/* Next-step hint (M6) — voided invoices are terminal in
                  §87 terms but finance almost always wants to issue a
                  credit note as the legal undo. F4 US6 ships the flow;
                  until then we surface the intent as a disabled CTA
                  with tooltip so admins know where it's coming. */}
              <p className="mt-3 text-xs text-muted-foreground">
                {t('voidDetails.creditNoteHint')}
              </p>
            </section>
          )}

          {creditNotes.length > 0 && (
            <section
              aria-labelledby="credit-notes-heading"
              className="mt-6 border-t pt-6"
            >
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h3
                  id="credit-notes-heading"
                  className="text-sm font-medium text-muted-foreground"
                >
                  {t('creditNotesSection.title', { count: creditNotes.length })}
                </h3>
                <p className="text-xs text-muted-foreground">
                  <span>{t('creditNotesSection.totalCredited')}</span>{' '}
                  <span className="font-medium tabular-nums text-foreground">
                    {formatSatang(invoice.creditedTotal.satang)}{' '}
                    <span className="text-muted-foreground">THB</span>
                  </span>
                </p>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.number')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.issueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.reason')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.total')}
                      </TableHead>
                      <TableHead scope="col" className="w-[1%] text-right">
                        <span className="sr-only">
                          {t('creditNotesSection.col.actions')}
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditNotes.map((cn) => (
                      <TableRow key={cn.creditNoteId}>
                        <TableCell className="font-mono font-medium">
                          {cn.documentNumber.raw}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {/* CN issueDate is a tax-document date — use formatTaxDocDate
                              so th locale renders CE + (พ.ศ.) matching the CN detail +
                              directory pages; UTC-pin is internal to formatTaxDocDate. */}
                          {formatTaxDocDate(cn.issueDate, userLocale)}
                        </TableCell>
                        <TableCell
                          className="max-w-[20rem] truncate"
                          title={cn.reason}
                        >
                          {cn.reason}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatSatang(cn.total.satang)}{' '}
                          <span className="text-muted-foreground">THB</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <a
                              href={`/api/credit-notes/${cn.creditNoteId}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={buttonVariants({
                                variant: 'outline',
                                size: 'sm',
                              })}
                              aria-label={t(
                                'creditNotesSection.action.pdfAria',
                                { number: cn.documentNumber.raw },
                              )}
                            >
                              {t('creditNotesSection.action.pdf')}
                            </a>
                            <Link
                              href={`/admin/credit-notes/${cn.creditNoteId}`}
                              className={buttonVariants({
                                variant: 'secondary',
                                size: 'sm',
                              })}
                              aria-label={t(
                                'creditNotesSection.action.viewAria',
                                { number: cn.documentNumber.raw },
                              )}
                            >
                              {t('creditNotesSection.action.view')}
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <section className="mt-6" aria-labelledby="invoice-lines-heading">
            <h3
              id="invoice-lines-heading"
              className="mb-2 text-sm font-medium text-muted-foreground"
            >
              {t('lines.title')}
            </h3>
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
      {/* F5 Phase 5 (T097–T099) — payment activity timeline. Renders
          for both admin + manager (read-only); mutating refund/void/
          record-payment actions are gated above by `isAdmin`. The
          panel hides behind its own empty state when the invoice has
          no F5 payment + the F4 record-payment flow has not been used
          either, so non-paid drafts/issued invoices show a clean card. */}
      {!isDraft && (
        <div className="mt-4">
          {/* Suspense + extracted PaymentTimelineSkeleton primitive
              (R3-fix S4 2026-04-26). Shape fidelity + shimmer
              behaviour documented inside the component file. */}
          <Suspense fallback={<PaymentTimelineSkeleton />}>
            <PaymentTimeline
              invoice={{
                invoiceId: invoice.invoiceId,
                status: invoice.status,
                paidAt: invoice.paidAt,
                paymentRecordedByUserId: invoice.paymentRecordedByUserId,
              }}
              tenantId={tenantCtx.slug}
              isAdmin={isAdmin}
            />
          </Suspense>
        </div>
      )}
    </DetailContainer>
  );
}
