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
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.meta');
  return { title: t('title') };
}
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { env } from '@/lib/env';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import {
  getInvoice,
  makeGetInvoiceDeps,
  Money,
  computeIsOverdue,
  displayDocumentNumber,
  invoiceStatusHasReceipt,
  resolveTaxDocumentKind,
  maybeEmitOverdueDetected,
  makeOverdueAuditPort,
  getInvoiceSupersession,
  makeGetInvoiceSupersessionDeps,
  refundCreditNoteWaiverReasonFor,
  type CreditNoteWaiverReason,
} from '@/modules/invoicing';
// Direct infra import for the settings read — same escape-hatch as
// the B2 settings page. This is a READ against the public port
// `getForIssue`, not a deep reach into internals.
 
import type { IssueTotalsByTreatment } from '../_lib/issue-summary-totals';
import { draftDisplayTotals } from './_lib/draft-display-totals';
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
import {
  asInvoiceId,
  getMemberMoneyRecipientStatus,
  makeMemberMoneyRecipientStatusDeps,
} from '@/modules/invoicing';
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
import { logger } from '@/lib/logger';
import { PaymentTimeline } from './_components/payment-timeline';
import { PaymentTimelineSkeleton } from './_components/payment-timeline-skeleton';
import { renderInvoiceDetailView } from './_components/invoice-detail-view';
import { computeRemainingRefundable } from '@/modules/payments';
// F5 UX D2 — tenant-scoped audit read for the failed-auto-refund alert. Same
// documented escape-hatch as the tenant-settings / credit-note reads above:
// a tenant-scoped infra read (RLS+FORCE), no Application use-case needed.
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { getInvoicePaymentActivity } from './_lib/cached-payment-activity';
import { describePaymentDetails } from './_lib/payment-details';
import { isSystemActor } from './_lib/system-actor';
import { latestSucceededPayment } from './_components/payment-timeline-format';
import { voidedBillNumber } from '../_lib/void-bill-number';

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.detail');
  const { user: currentUser } = await requirePagePermission('invoicing.read');
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
      role: currentUser.role,
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
  // 088 T017a / FR-027 — the RECORDED `members.is_vat_registered` flag drives the
  // pre-issue Head-Office / Branch preview + its warning (059 / PR-A Task 3: this
  // used to read `legal_entity_type` and guess). Loaded from the live member
  // (drafts only) alongside the display name; false for a non-member event draft
  // (which the review dialog treats as non-membership anyway).
  let buyerIsVatRegistrant = false;
  if (invoice.memberId !== null && !snapshotName) {
    const memberResult = await getMember(
      invoice.memberId as MemberId,
      { actorUserId: currentUser.id, requestId },
      buildMembersDeps(tenantCtx),
    );
    if (memberResult.ok) {
      const { member: liveMember } = memberResult.value;
      memberDisplayName = liveMember.companyName;
      buyerHasTaxId = liveMember.taxId !== null;
      buyerIsVatRegistrant = liveMember.isVatRegistered;
    }
  }

  // 108 FR-003 — this invoice's money emails go to the member's LIVE primary
  // contact, so the page has to know whether one exists.
  //
  // It asks a USE CASE, which asks the resolver. Two rules meet here. The
  // banner must decide with the same function the money path decides with —
  // the first version re-derived the predicate inline as
  // `isPrimary && removedAt === null`, missing the empty-address case, so
  // every money email was skipped while the banner rendered nothing. And
  // Presentation calls use cases only (Principle III, NON-NEGOTIABLE): the
  // second version fixed the first by wiring an infra adapter into a server
  // component, which is the same rule broken the other way.
  //
  // A failed READ is not the same fact as "no contact", so it is logged and
  // the banner hidden rather than shown — a warning that fires on a database
  // blip trains staff to ignore it.
  //
  // No `status !== 'archived'` gate here, unlike the member page: an archived
  // member's document can still be voided, credited or resent, and each of
  // those needs an address.
  //
  // The erased / archived exclusions live in the use case (round-5 #2): erasure
  // scrubs every contact, so this member is GUARANTEED to read as "no live
  // primary" and the banner used to fire on every invoice they ever had —
  // advising staff to re-introduce PII for an Art.17 data subject.
  let showNoPrimaryContactBanner = false;
  if (invoice.memberId !== null) {
    const recipientStatus = await getMemberMoneyRecipientStatus(
      makeMemberMoneyRecipientStatusDeps(),
      { tenantId: tenantCtx.slug, memberId: invoice.memberId },
    );
    if (recipientStatus.ok) {
      showNoPrimaryContactBanner = recipientStatus.value.shouldWarn;
    } else {
      logger.warn(
        { requestId, tenantId: tenantCtx.slug, memberId: invoice.memberId },
        'admin.invoices.detail.recipient_status_read_failed — banner suppressed',
      );
    }
  }

  // Resolve staff-user display names for the audit fields on the
  // paid / void sections. Showing a raw UUID in "Recorded by" tells
  // the admin nothing — email is the smallest humane identifier we
  // have today (TODO: add display_name when F1 user profile lands).
  // A system actor (the Stripe webhook's reserved UUID) is labelled as such —
  // looking it up returns the seeded internal e-mail, which means nothing to
  // staff. Mirrors the payment timeline's `isSystemActor()` mapping.
  async function resolveUserEmail(userId: string | null): Promise<string> {
    if (!userId) return '—';
    if (isSystemActor(userId)) return t('payment.recordedBySystem');
    const row = await userRepo.findById(asUserId(userId));
    return row?.email ?? userId;
  }
  const [paymentRecordedByEmail, voidedByEmail] = await Promise.all([
    resolveUserEmail(invoice.paymentRecordedByUserId),
    resolveUserEmail(invoice.voidedByUserId),
  ]);

  // Payment details for a Stripe-paid invoice: the rail comes from the
  // invoice's succeeded F5 payment (the F4 row only says 'other'). Shares the
  // request-cached activity read with the refund button + timeline below; a
  // failed read falls back to the rail named in the processor note.
  let onlineMethod: 'card' | 'promptpay' | null = null;
  if (invoice.paymentMethod === 'other' && invoice.paidAt !== null) {
    const activity = await getInvoicePaymentActivity(tenantCtx.slug, invoiceId);
    if (activity.ok) {
      onlineMethod = latestSucceededPayment(activity.value.payments)?.method ?? null;
    }
  }
  const paymentDetails = describePaymentDetails({
    paymentMethod: invoice.paymentMethod,
    paymentNotes: invoice.paymentNotes,
    paymentRecordedByUserId: invoice.paymentRecordedByUserId,
    onlineMethod,
  });

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

  // 121-void-supersede-links — the void-on-reissue link, read back from the
  // `invoice_voided` audit payload: "Replaced by" on a supersede-voided bill,
  // "Replaces" on the bill that superseded it. A manual void has no link, so
  // nothing renders. Best-effort: a failed read (logged in the use case) hides
  // the link rather than 500-ing the page.
  const supersession = await getInvoiceSupersession(makeGetInvoiceSupersessionDeps(), {
    tenantId: tenantCtx.slug,
    invoice: {
      invoiceId: invoice.invoiceId,
      status: invoice.status,
      memberId: invoice.memberId,
    },
  });
  const replacedBy = supersession.ok ? supersession.value.replacedBy : null;
  const replaces = supersession.ok ? supersession.value.replaces : [];
  // 016 re-review D — evaluator-derived ('invoicing.write'; OFF leg legacyAdminOnly
  // reproduces the admin-only affordance and admits a promoted super_admin).
  const isAdmin = canPerform(currentUser.role, 'invoicing.write');

  // Resend-eligibility gates — SHARED with InvoiceMoreMenu below so the
  // failure banner + the action menu stay in lockstep. Receipt-resend requires a
  // receipt-bearing invoice (092: paid / partially_credited / credited) with a
  // rendered receipt PDF. A paid invoice keeps its main PDF download + resend:
  // the retired pre-088 combined-mode rule that hid the "stale" issue-time PDF
  // of a paid invoice with no RC is gone (prod has no such rows and the 088
  // flag is permanently on).
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
          : invoice.status !== 'void' && Boolean(invoice.pdf),
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
  // preview from line totals + the invoice-settings VAT rate, through the
  // issue use case's own `computeIssuePricing` (a VAT-inclusive event draft's
  // total is its line sum). Issued invoices use their stored snapshots.
  let displaySubtotalSatang: bigint | null = invoice.subtotal?.satang ?? null;
  let displayVatSatang: bigint | null = invoice.vat?.satang ?? null;
  let displayTotalSatang: bigint | null = invoice.total?.satang ?? null;
  let displayVatRateBps: number | null =
    invoice.vatRate ? Number(invoice.vatRate.numerator) : null;
  // The Issue dialog shows the figures for the VAT treatment the admin picks,
  // so it gets the draft priced per treatment (same policy), not the
  // standard-rate figures above.
  let issueTotals: IssueTotalsByTreatment | null = null;

  if (isDraft) {
    let sub = Money.zero();
    for (const line of invoice.lines) sub = sub.add(line.total);

    // R7-B2 follow-up — source VAT from `tenant_invoice_settings`
    // (the `issue-invoice` use-case's source of truth, FR-009/011),
    // NOT from F2 `tenant_fee_config`. The two tables can drift and
    // the invoice will be snapshotted from invoice-settings at
    // issue time — the draft preview MUST match what issuance will
    // produce, otherwise admin sees one number and commits another.
    const invoiceSettings = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);
    const draft = draftDisplayTotals({
      lineSum: sub,
      vatInclusive: invoice.vatInclusive,
      standardRate: invoiceSettings?.vatRate ?? null,
    });
    displaySubtotalSatang = draft.subtotalSatang;
    displayVatSatang = draft.vatSatang;
    displayTotalSatang = draft.totalSatang;
    displayVatRateBps = draft.vatRateBps;
    issueTotals = draft.issueTotals;
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
  // A voided unpaid 088 bill never had a §87 tax-document number, so the void
  // panel says its SC bill number is kept rather than "retired".
  const voidedBill = voidedBillNumber(invoice, env.features.f088TaxAtPayment);

  // Load payment activity at page level so the Refund action button
  // can be rendered conditionally on succeeded-payment + remaining-
  // refundable presence. Shares the React `cache()`-deduplicated
  // loader with the Suspense'd PaymentTimeline panel below — one
  // DB roundtrip per request, not two.
  // A refund still settling on ANY of this invoice's payments blocks a manual
  // credit note server-side (8A `refund_in_progress`); the action is disabled
  // to match. A failed activity read leaves it enabled — the server guard
  // still refuses, with its dedicated message.
  let settlingRefundSatang: bigint | null = null;
  let refundButtonProps: {
    paymentId: string;
    remainingRefundableSatang: bigint;
    pendingRefundExists: boolean;
    paidAmountSatang: bigint | null;
    paidAt: string | null;
    creditNoteWaiverReason: CreditNoteWaiverReason | null;
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
      // The settling note shows the total still in flight (display only; the
      // refundable headroom below is computed without it, Gap E).
      const pending = activity.value.refunds.filter((r) => r.status === 'pending');
      settlingRefundSatang =
        pending.length > 0 ? pending.reduce((sum, r) => sum + r.amountSatang, 0n) : null;
      // Capped at the invoice's un-credited headroom — the same min(...) the
      // refund pre-flight enforces. Payment-side only would overstate the
      // max after a manual credit note (and the admin would submit into a 409).
      const remaining = computeRemainingRefundable(
        activity.value,
        invoice.total
          ? {
              totalSatang: invoice.total.satang,
              creditedTotalSatang: invoice.creditedTotal.satang,
            }
          : undefined,
      );
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
        // The refund dialog names the payment it returns ("… · {amount},
        // {date}") — the same succeeded payment `computeRemainingRefundable`
        // picked, looked up by id rather than re-sorted here.
        const refundedPayment = activity.value.payments.find((p) => p.id === remaining.paymentId);
        refundButtonProps = {
          paymentId: remaining.paymentId,
          remainingRefundableSatang: remaining.remainingSatang,
          pendingRefundExists,
          paidAmountSatang: refundedPayment?.amountSatang ?? null,
          paidAt: refundedPayment?.completedAt?.toISOString() ?? null,
          // The same F4 verdict the refund pre-flight reads: the dialog must
          // not promise a credit note for a waived document.
          creditNoteWaiverReason: refundCreditNoteWaiverReasonFor(invoice),
        };
      }
    }
  }

  return renderInvoiceDetailView({
    invoice,
    routeSegment: invoiceId,
    displayStatus,
    headerNumber,
    displayNumber,
    taxDocKind,
    voidedBill,
    memberDisplayName,
    planDisplayName,
    buyerHasTaxId,
    buyerIsVatRegistrant,
    showNoPrimaryContactBanner,
    paymentRecordedByEmail,
    voidedByEmail,
    paymentDetails,
    creditNotes,
    replacedBy,
    replaces,
    isAdmin,
    hasReceiptPdf,
    failedEmailBanners,
    autoRefund: {
      failed: autoRefundFailed,
      processorRefundId: autoRefundStatus?.processorRefundId ?? null,
    },
    totals: {
      subtotalSatang: displaySubtotalSatang,
      vatSatang: displayVatSatang,
      totalSatang: displayTotalSatang,
      vatRateBps: displayVatRateBps,
    },
    issueTotals,
    settlingRefundSatang,
    refund: refundButtonProps,
    bangkokTodayIso,
    taxAtPayment: env.features.f088TaxAtPayment,
    locale: userLocale,
    // F5 Phase 5 (T097–T099) — the payment activity timeline, for admin and
    // manager alike (the mutating actions are gated by `isAdmin` in the view).
    // It streams in its own Suspense; a draft has none.
    paymentActivity: isDraft ? null : (
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
          autoRefundFailed={autoRefundFailed}
        />
      </Suspense>
    ),
  });
}
