/**
 * `/admin/renewals/[cycleId]` server component — F8 cycle-detail view.
 *
 * Originally the GET API + `loadCycleDetail` use-case shipped (T057 +
 * T064) without a UI; the pipeline-table "Open" action 404'd in the
 * wild. This page closes that gap with locale-aware dates (Buddhist
 * Era on th-TH), F3 member + F2 plan display lookups, and forensic
 * UUIDs collapsed behind `<details>` so the primary scan path stays
 * focused on dates/status/tier.
 *
 * Authz: admin OR manager (read-only — mutations live on pipeline
 * row dropdowns).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  getFormatter,
  getLocale,
  getTranslations,
} from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { AlertCircle, ArrowLeft, BellOff, SearchX } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { EmptyState } from '@/components/shell/empty-state';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { loadCycleDetail, makeRenewalsDeps } from '@/modules/renewals';
import { CycleStatusBadge } from './_components/cycle-status-badge';
// Phase 6 review-round 2 A2 — display-data fetchers extracted to a
// testable module so unit tests can drive the C4 error semantics
// (null-vs-throw) + TD1 zod parse without booting Drizzle.
import {
  fetchMemberDisplay,
  fetchPlanDisplay,
} from './_lib/cycle-detail-fetchers';

// Locale → BCP47 mapping. Thai uses Buddhist Era via the
// `-u-ca-buddhist` calendar extension (CLAUDE.md: BE = CE + 543 is
// display-only for th-TH; storage stays Gregorian ISO). Verified
// pattern at `src/components/members/archived-banner.tsx:90`.
function bcp47For(locale: string): string {
  return locale === 'th' ? 'th-TH-u-ca-buddhist' : locale;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ cycleId: string }>;
}): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.cycleDetail');
  const { cycleId } = await params;
  // S-1 (UX R3): root `src/app/layout.tsx` applies the
  // `'%s · SweCham Membership'` title template, so the per-page
  // title must NOT add another ` · SweCham` suffix (that produced
  // the doubled "Cycle detail · SweCham · SweCham Membership"
  // tab title). shortId also dropped — admins don't recognise hex
  // prefixes; the in-page header carries the company name.
  return {
    title: t('title'),
    description: t('subtitle', { cycleId }),
  };
}

interface PageProps {
  readonly params: Promise<{ cycleId: string }>;
}

export default async function AdminCycleDetailPage({ params }: PageProps) {
  if (!env.features.f8Renewals) {
    notFound();
  }

  const t = await getTranslations('admin.renewals.cycleDetail');
  const tStatus = await getTranslations('admin.renewals.lapsedReason');
  const tTier = await getTranslations('admin.renewals.tierBadge');
  // C-1 (UX R3): translate F4 invoice status enums (`issued`, `paid`,
  // `partially_credited`, …) — previously rendered as raw lowercase
  // machine values which read as broken to admins.
  const tInvoiceStatus = await getTranslations(
    'admin.invoices.list.statuses',
  );
  // A4 — localize reminder + escalation enums in the activity section.
  // reminder.status is a new key set; channel/escalation status/role/taskType
  // reuse the existing tasks + schedule-stepCard maps.
  const tReminder = await getTranslations('admin.renewals.cycleDetail.reminders');
  const tTasks = await getTranslations('admin.renewals.tasks');
  const tChannel = await getTranslations(
    'admin.renewals.settings.schedules.stepCard',
  );
  const formatter = await getFormatter();
  const locale = await getLocale();
  const dateLocale = bcp47For(locale);

  // Auth + role check — managers permitted on this read-only surface.
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
    redirect('/portal');
  }

  const { cycleId } = await params;
  const requestHeaders = await headers();
  const requestId = requestHeaders.get('x-request-id') ?? randomUUID();
  const tenantCtx = resolveTenantFromRequest({
    headers: requestHeaders,
    nextUrl: { hostname: requestHeaders.get('host') ?? '' },
  } as unknown as Parameters<typeof resolveTenantFromRequest>[0]);
  const renewalsDeps = makeRenewalsDeps(tenantCtx.slug);

  const result = await loadCycleDetail(renewalsDeps, {
    tenantId: tenantCtx.slug,
    cycleId,
    actorUserId: currentUser.id,
    actorRole: currentUser.role === 'admin' ? 'admin' : 'manager',
    requestId,
    correlationId: requestId,
  });

  if (!result.ok) {
    if (result.error.kind === 'invalid_input') {
      notFound();
    }
    if (result.error.kind === 'cycle_not_found') {
      return (
        <DetailContainer>
          <PageHeader title={t('notFoundTitle')} />
          <EmptyState
            icon={SearchX}
            title={t('notFoundDescription')}
            action={
              <Link
                href="/admin/renewals"
                className="inline-flex items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t('backToPipeline')}
              </Link>
            }
          />
        </DetailContainer>
      );
    }
    // Phase 6 review-round 2 F7 — exhaustiveness guard via never
    // assertion. `LoadCycleDetailError` is `invalid_input | cycle_not_found`
    // (load-cycle-detail.ts:59); both arms above. If a new variant is
    // added later, TS fails this assignment and prevents shipping a
    // silently-cached 200. The throw routes to Next.js error boundary.
    const _exhaustive: never = result.error;
    logger.error(
      { errorId: 'F8.ADMIN.CYCLE_DETAIL_PAGE', err: _exhaustive, cycleId },
      '[admin/renewals/cycle-detail] unhandled loadCycleDetail error kind',
    );
    throw new Error(
      'F8.ADMIN.CYCLE_DETAIL_PAGE: loadCycleDetail unexpected error',
    );
  }

  const v = result.value;
  const c = v.cycle;
  const shortId = c.cycleId.slice(0, 8);

  // Parallel F3 member + F2 plan display lookups. Plan lookup uses
  // the SAME query shape as production `loadPlanFrozenFields`
  // (`plan-lookup-for-renewal-drizzle.ts`):
  // `WHERE planId = X AND deleted_at IS NULL ORDER BY plan_year DESC
  // LIMIT 1`. The cycle's `plan_id_at_cycle_start` is `text`
  // (migration 0113) matching F2's `plan_id` slug. No `planYear`
  // filter — most-recent active row wins, matching how production
  // resolves prices on plan-change-during-renewal.
  const [memberResult, planResult] = await Promise.allSettled([
    fetchMemberDisplay({
      tenantSlug: tenantCtx.slug,
      memberId: c.memberId,
      actorUserId: currentUser.id,
      requestId,
    }),
    fetchPlanDisplay({
      tenantSlug: tenantCtx.slug,
      planId: c.planIdAtCycleStart,
      locale,
    }),
  ]);
  const member =
    memberResult.status === 'fulfilled' ? memberResult.value : null;
  const planDisplay =
    planResult.status === 'fulfilled' ? planResult.value : null;
  if (memberResult.status === 'rejected') {
    logger.warn(
      { err: memberResult.reason, memberId: c.memberId },
      '[admin/renewals/cycle-detail] member display lookup failed; falling back to UUID-only',
    );
  }
  if (planResult.status === 'rejected') {
    logger.warn(
      { err: planResult.reason, planId: c.planIdAtCycleStart },
      '[admin/renewals/cycle-detail] plan display lookup failed; falling back to UUID-only',
    );
  }

  // Locale-aware date formatting via Intl.DateTimeFormat with the
  // BCP47 calendar extension for Thai BE. Day-grain only for
  // period bounds / expiry (I-1: showing UTC-midnight time misleads
  // admins). The Date constructor accepts any string and
  // `Intl.DateTimeFormat.format` returns "Invalid Date" for bad
  // input rather than throwing — no try/catch needed.
  const dtFmtFull = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const dtFmtDay = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
  });
  const fmtDate = (s: string | null | undefined): string =>
    s ? dtFmtFull.format(new Date(s)) : '—';
  const fmtDateOnly = (s: string | null | undefined): string =>
    s ? dtFmtDay.format(new Date(s)) : '—';

  const closedReason =
    c.status === 'lapsed' || c.status === 'cancelled'
      ? c.closedReason
      : null;
  const closedReasonLabel =
    closedReason && tStatus.has(closedReason)
      ? tStatus(closedReason)
      : closedReason
        ? `${closedReason} (untranslated)`
        : null;

  const invoiceTotal = v.linkedInvoice
    ? formatter.number(Number(v.linkedInvoice.totalSatang) / 100, {
        style: 'currency',
        currency: 'THB',
      })
    : null;
  const frozenPrice = c.frozenPlanPriceThb
    ? formatter.number(Number(c.frozenPlanPriceThb), {
        style: 'currency',
        currency: c.frozenPlanCurrency ?? 'THB',
      })
    : '—';

  // I-4 (UX R3): always render the invoice card so admins aren't left
  // wondering "where's the invoice section?". The body adapts to the
  // cycle's status so the absence is *explained* (upcoming/reminded =
  // not yet generated) rather than silently hidden.
  const invoicePendingMessage =
    c.status === 'upcoming' || c.status === 'reminded'
      ? t('noInvoiceYetUpcoming')
      : t('noLinkedInvoice');
  const showEnteredPendingAt = c.status === 'pending_admin_reactivation';
  const showClosedAt =
    c.status === 'lapsed' ||
    c.status === 'cancelled' ||
    c.status === 'completed';
  // I-1 follow-up: subtitle anchor depends on what state this cycle
  // is in. "Expires" is only correct for live cycles; closed cycles
  // (lapsed/cancelled/completed) are anchored on `closedAt`, and
  // pending cycles on `enteredPendingAt`. Falls back to expiresAt
  // when the status-appropriate timestamp is unexpectedly null
  // (defensive — schema permits NULL on closedAt + enteredPendingAt
  // outside their owning states).
  let subtitle: string;
  if (showClosedAt && c.closedAt) {
    subtitle = t('subtitleClosed', { date: fmtDateOnly(c.closedAt) });
  } else if (showEnteredPendingAt && c.enteredPendingAt) {
    subtitle = t('subtitlePendingSince', {
      date: fmtDateOnly(c.enteredPendingAt),
    });
  } else {
    subtitle = t('subtitleExpiry', { date: fmtDateOnly(c.expiresAt) });
  }
  // C-1 (UX R3): invoice-status enum → human-readable label. Falls
  // back to the raw value if a future F4 status lacks a translation
  // (loud-fail pattern matching closedReason / tierLabel).
  const invoiceStatusLabel = v.linkedInvoice
    ? tInvoiceStatus.has(v.linkedInvoice.status)
      ? tInvoiceStatus(v.linkedInvoice.status)
      : `${v.linkedInvoice.status} (untranslated)`
    : null;

  // Tier label via the existing F8 tier-badge i18n namespace. Falls
  // back to raw enum value if a future tier is added in domain but
  // not in i18n (loud-fail pattern matching closedReason).
  const tierKey = c.tierAtCycleStart;
  const tierLabel = tTier.has(tierKey)
    ? tTier(tierKey)
    : `${tierKey} (untranslated)`;

  const memberCompany = member
    ? member.companyName
    : t('fields.memberLookupFailed');
  // When F2 plan-name lookup returns null (cycle's
  // plan_id_at_cycle_start has no matching plan_id in `membership_plans`
  // — common with dev/test seed data that uses UUID-shaped placeholders
  // instead of real F2 plan slugs), render a neutral "—" rather than
  // an error-shaped "Couldn't load" message. Admin still gets the
  // human-meaningful info via Tier badge + frozen price/term.
  const planName = planDisplay ? planDisplay.localisedName : '—';
  const breadcrumbLabel = member ? member.companyName : shortId;

  return (
    <DetailContainer>
      {/* N-6 (round 3): replace raw UUID in breadcrumb with the
          member's company name. Falls back to shortId when F3 lookup
          failed (forensic-friendly without UUID-overflow horror). */}
      <PlanBreadcrumbLabel segment={cycleId} label={breadcrumbLabel} />

      <PageHeader
        // C-2 (UX R3): inline status badge in the header so admins
        // know in 5 seconds whether the cycle needs attention. The
        // pattern mirrors F4 invoice-detail
        // (`/admin/invoices/[invoiceId]/page.tsx:289-295`) which
        // keeps its status pill adjacent to the title — keeps the
        // three transactional detail surfaces visually consistent.
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{`${t('title')} · ${memberCompany}`}</span>
            <CycleStatusBadge
              status={c.status}
              label={t(`cycleStatus.${c.status}`)}
              srSuffix={
                t.has(`statusSeverity.${c.status}`)
                  ? t(`statusSeverity.${c.status}`)
                  : null
              }
            />
          </span>
        }
        // I-1 (UX R3): subtitle anchors on the most-relevant date for
        // the cycle's current state — "Expires" for live cycles,
        // "Closed" for lapsed/cancelled/completed, "Pending since"
        // for pending_admin_reactivation. All without a clock time
        // component (cycle dates are day-grain).
        subtitle={subtitle}
        // S-3 (UX R3): the "Back to pipeline" link was redundant
        // with the breadcrumb above — removed. The actions slot is
        // now empty on this surface because:
        //   - read-only role check at L98-101 means no mutations
        //     happen from this page (those live on the pipeline
        //     row dropdown).
        //   - `pending_admin_reactivation` cycles are not currently
        //     surfaced anywhere in `/admin/renewals` (the pipeline
        //     filters by `urgency`/`tier`, not `status`). Adding a
        //     "Review in pipeline" CTA before there is a destination
        //     for it would be a broken affordance — worse than no
        //     affordance. Re-introduce when a pending-cycles list
        //     ships.
      />

      {/* UX R5 / I3: hold-state notice for `pending_admin_reactivation`
          cycles. Status badge in PageHeader signals state, but admins
          arriving here from breadcrumb / direct URL need the next
          action spelled out — approve/reject lives on the row-action
          dropdown back in the pipeline (no list surface for this
          status yet). */}
      {c.status === 'pending_admin_reactivation' && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('pendingNoticeTitle')}</AlertTitle>
          <AlertDescription>{t('pendingNoticeBody')}</AlertDescription>
        </Alert>
      )}

      {/* Staff-Review-2026-05-09 SUG-5 fix: surface F2/F3 lookup
          failures via <Alert variant="warning"> instead of inline
          "—" fallback. Previously a Promise.allSettled rejection
          would silently render "—" in the dl, leaving the admin
          with no indication the lookup failed; the pino warn was
          only visible in Vercel logs. The alert tells the admin
          the data they see may be incomplete + points at the
          requestId for support escalation. */}
      {(memberResult.status === 'rejected' ||
        planResult.status === 'rejected') && (
        <Alert variant="default">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('lookupFailedTitle')}</AlertTitle>
          <AlertDescription>
            {memberResult.status === 'rejected' &&
              planResult.status === 'rejected'
              ? t('lookupFailedBoth', { requestId })
              : memberResult.status === 'rejected'
                ? t('lookupFailedMember', { requestId })
                : t('lookupFailedPlan', { requestId })}
          </AlertDescription>
        </Alert>
      )}

      {/* UX R5 / I7 + Staff-Review-2026-05-09 BLK-4 fix: section labelled
          by the card heading itself, not by the inner subsection h3 —
          previously the `region` landmark was announced as "Member" only,
          hiding the "Member & plan" parent context. Inner subsections
          keep their own h3-labelled regions, NESTED inside the parent
          h2-labelled region (closes WCAG 1.3.1 — content was orphan
          when the outer </section> closed immediately after the h2). */}
      <Card>
        <CardContent>
          {/* Staff-Review-2026-05-09 BLK-4 spacing fix: `space-y-4` lives
              on the wrapping <section> so direct children of the
              section (h2, inner sections, Separator, details) get the
              4-step gap. Previously space-y-4 sat on CardContent and
              applied to the orphan structure; after wrapping with one
              <section>, CardContent has only one direct child and
              inner items collapsed against each other. */}
          <section
            aria-labelledby="cycle-detail-card-heading"
            className="space-y-4"
          >
            <h2
              id="cycle-detail-card-heading"
              className="text-base font-semibold"
            >
              {t('sectionMemberPlan')}
            </h2>
            <section aria-labelledby="cycle-detail-member-heading">
              <h3
                id="cycle-detail-member-heading"
                className="mb-2 text-sm font-medium text-muted-foreground"
              >
                {t('subsectionMember')}
              </h3>
              <dl className="space-y-1">
                <Field
                  label={t('fields.companyName')}
                  // I-2 (UX R3): link the company name to its member
                  // detail page — admins investigating a lapsed cycle
                  // typically need contact info, payment history, or
                  // tier from the member record next.
                  valueNode={
                    member ? (
                      <Link
                        href={`/admin/members/${c.memberId}`}
                        className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                      >
                        {memberCompany}
                      </Link>
                    ) : (
                      <span>{memberCompany}</span>
                    )
                  }
                />
                <Field
                  label={t('fields.primaryContact')}
                  value={
                    member?.primaryContact ?? t('fields.primaryContactNone')
                  }
                />
                {/* C-2 (UX R3): status moved to PageHeader; this row
                    removed to avoid duplication. The tier label remains
                    here — it's a frozen-plan attribute, not a state. */}
                <Field label={t('fields.tier')} value={tierLabel} />
              </dl>
            </section>
            <Separator />
            <section aria-labelledby="cycle-detail-plan-heading">
              <h3
                id="cycle-detail-plan-heading"
                className="mb-2 text-sm font-medium text-muted-foreground"
              >
                {t('subsectionPlan')}
              </h3>
              <dl className="space-y-1">
                <Field label={t('fields.planName')} value={planName} />
                <Field label={t('fields.frozenPrice')} value={frozenPrice} />
                <Field
                  label={t('fields.frozenTerm')}
                  value={
                    c.frozenPlanTermMonths !== null
                      ? String(c.frozenPlanTermMonths)
                      : '—'
                  }
                />
                <Field
                  label={t('fields.frozenCurrency')}
                  value={c.frozenPlanCurrency ?? '—'}
                />
              </dl>
            </section>
            {/* Forensic UUIDs collapsible — admins rarely need raw IDs
                but support tickets do. <details> keeps them accessible
                without polluting the primary scan path.
                UX R5 / S6: `id` lets support tickets deep-link to this
                section (`#cycle-technical-ids`). */}
            <details
              id="cycle-technical-ids"
              className="rounded-md border border-dashed border-border p-3"
            >
              <summary className="cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
                {t('fields.showTechnicalIds')}
              </summary>
              <dl className="mt-3 space-y-1">
                <Field label={t('fields.cycleId')} value={c.cycleId} mono />
                <Field label={t('fields.memberId')} value={c.memberId} mono />
                <Field
                  label={t('fields.planId')}
                  value={c.planIdAtCycleStart}
                  mono
                />
              </dl>
            </details>
          </section>
        </CardContent>
      </Card>

      {/* I-4 (UX R3): always render — the body adapts to status so
          admins understand *why* an invoice is or isn't present.
          Phase 6 review-round 2 C2: section landmark for keyboard /
          SR navigation between cards (WCAG 1.3.1 + 2.4.6).
          Staff-Review-2026-05-09 BLK-4 spacing fix: space-y-3 lives on
          the wrapping <section> so h2 + body get the 3-step gap
          (was on CardContent — single direct child made the spacing
          a no-op once the section wrapped everything). */}
      <Card>
        <CardContent>
          <section
            aria-labelledby="cycle-detail-invoice-heading"
            className="space-y-3"
          >
            <h2
              id="cycle-detail-invoice-heading"
              className="text-base font-semibold"
            >
              {t('sectionInvoice')}
            </h2>
            {v.linkedInvoice ? (
              <div className="space-y-3">
                <dl className="space-y-1">
                  <Field
                    label={t('fields.invoiceNumber')}
                    value={v.linkedInvoice.invoiceNumber ?? '—'}
                  />
                  <Field
                    label={t('fields.invoiceStatus')}
                    value={invoiceStatusLabel ?? '—'}
                  />
                  <Field
                    label={t('fields.invoiceTotal')}
                    value={invoiceTotal ?? '—'}
                  />
                </dl>
                <Link
                  href={`/admin/invoices/${v.linkedInvoice.invoiceId}`}
                  className="inline-flex items-center gap-2 rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  {t('fields.viewInvoice', {
                    // R2 follow-up: fall back to the INVOICE's own
                    // UUID prefix (not the cycle's `shortId`) when
                    // `invoiceNumber` is null. Previously a draft /
                    // unnumbered / degraded-F4-fetch invoice would
                    // render the link as "View invoice <cycle-prefix>"
                    // — admins reading the label naturally interpret
                    // the placeholder as the invoice number, but it
                    // was the cycle id.
                    number:
                      v.linkedInvoice.invoiceNumber ??
                      v.linkedInvoice.invoiceId.slice(0, 8),
                  })}
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {invoicePendingMessage}
              </p>
            )}
          </section>
        </CardContent>
      </Card>

      {/* UX R5 follow-up: `space-y-4` matches the Member+Plan card so
          the "Show audit timestamps" disclosure has the same 16px gap
          above it as "Show technical IDs" does in the sibling card.
          The previous `space-y-3` (12px) made the disclosure visually
          crowd the period dl above it.
          Staff-Review-2026-05-09 BLK-4 spacing fix: space-y-4 lives on
          the wrapping <section> so dl + details get the 4-step gap. */}
      <Card>
        <CardContent>
          {/* Staff-Review-2026-05-09 BLK-4 fix: <section> wraps the
              entire dl + details so the period content lives inside the
              region landmark (was orphan content). */}
          <section
            aria-labelledby="cycle-detail-period-heading"
            className="space-y-4"
          >
            <h2
              id="cycle-detail-period-heading"
              className="text-base font-semibold"
            >
              {t('sectionPeriod')}
            </h2>
            <dl className="space-y-1">
              {/* I-1 (UX R3): period bounds + expiry are day-grain
                  concepts — render without a clock time. */}
              <Field
                label={t('fields.periodFrom')}
                value={fmtDateOnly(c.periodFrom)}
              />
              <Field
                label={t('fields.periodTo')}
                value={fmtDateOnly(c.periodTo)}
              />
              <Field
                label={t('fields.expiresAt')}
                value={fmtDateOnly(c.expiresAt)}
              />
              {showEnteredPendingAt && (
                <Field
                  label={t('fields.enteredPendingAt')}
                  value={fmtDate(c.enteredPendingAt ?? null)}
                />
              )}
              {showClosedAt && (
                <Field
                  label={t('fields.closedAt')}
                  value={fmtDate(c.closedAt ?? null)}
                />
              )}
              {closedReasonLabel && (
                <Field
                  label={t('fields.closedReason')}
                  value={closedReasonLabel}
                />
              )}
            </dl>
            {/* S-2 (UX R3): audit timestamps are forensic-only — collapsed
                behind <details> so the primary scan path stays focused on
                the period bounds + expiry that admins actually care about. */}
            <details className="rounded-md border border-dashed border-border p-3">
              <summary className="cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
                {t('fields.showAuditTimestamps')}
              </summary>
              <dl className="mt-3 space-y-1">
                <Field
                  label={t('fields.createdAt')}
                  value={fmtDate(c.createdAt)}
                />
                <Field
                  label={t('fields.updatedAt')}
                  value={fmtDate(c.updatedAt)}
                />
              </dl>
            </details>
          </section>
        </CardContent>
      </Card>

      {/* PR #24 review-fix Round 2 — render hydrated reminderHistory +
          escalationTasks. `loadCycleDetail` populates both arrays via
          existing port reads (reminderEventRepo.listForCycle +
          escalationTaskRepo.listForCycle); the previous unconditional
          EmptyState was wasting two DB reads per page load.
          Round 3 — bounded-scope claim corrected: reminderHistory
          scales with `steps × years_in_cycle` (regular tier ~6,
          premium/partnership ~9 per year per migration 0089); a
          2-year premium cycle could reach ~18 reminder events.
          escalationTasks stays small (created only on failures, ~5
          typical). Flat <ul> still appropriate at SweCham scale —
          revisit pagination only if a single cycle accumulates >50
          events. */}
      <Card>
        <CardContent>
          <section aria-labelledby="cycle-detail-activity-heading">
            <h2
              id="cycle-detail-activity-heading"
              className="mb-3 text-base font-semibold"
            >
              {t('sectionActivity')}
            </h2>
            {v.reminderHistory.length === 0 &&
            v.escalationTasks.length === 0 ? (
              <EmptyState
                icon={BellOff}
                title={t('noActivityTitle')}
                description={t('noActivityDescription')}
              />
            ) : (
              <div className="space-y-4">
                {v.reminderHistory.length > 0 && (
                  <section aria-labelledby="cycle-detail-reminders-heading">
                    <h3
                      id="cycle-detail-reminders-heading"
                      className="mb-2 text-sm font-semibold text-muted-foreground"
                    >
                      {t('reminders.heading')}
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {v.reminderHistory.map((r) => (
                        <li
                          key={r.reminderEventId}
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                        >
                          <span className="font-medium">{r.stepId}</span>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">
                            {tReminder.has(`status.${r.status}`)
                              ? tReminder(`status.${r.status}`)
                              : `${r.status} (untranslated)`}
                          </span>
                          {r.dispatchedAt !== null && (
                            <span className="text-muted-foreground">
                              {fmtDate(r.dispatchedAt)}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {tChannel.has(`channel.${r.channel}`)
                              ? tChannel(`channel.${r.channel}`)
                              : `${r.channel} (untranslated)`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {v.escalationTasks.length > 0 && (
                  <>
                    {v.reminderHistory.length > 0 && <Separator />}
                    <section aria-labelledby="cycle-detail-escalations-heading">
                      <h3
                        id="cycle-detail-escalations-heading"
                        className="mb-2 text-sm font-semibold text-muted-foreground"
                      >
                        {t('escalations.heading')}
                      </h3>
                      <ul className="space-y-1.5 text-sm">
                        {v.escalationTasks.map((task) => (
                          <li
                            key={task.taskId}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                          >
                            <span className="font-medium">
                              {tTasks.has(`taskType.${task.taskType}`)
                                ? tTasks(`taskType.${task.taskType}`)
                                : task.taskType}
                            </span>
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">
                              {tTasks.has(`status.${task.status}`)
                                ? tTasks(`status.${task.status}`)
                                : `${task.status} (untranslated)`}
                            </span>
                            <span className="text-muted-foreground">
                              {fmtDate(task.dueAt)}
                            </span>
                            {/* PR #24 review-fix Round 3 — `assignedToRole`
                                is non-nullable on the Domain type and is
                                always present (dispatcher-created tasks
                                set role but no specific user). The earlier
                                guard on `assignedToUserId !== null` hid
                                the role label for every system-generated
                                task. Render the role unconditionally so
                                admins always see the assignment target. */}
                            <span className="text-xs text-muted-foreground">
                              {tTasks.has(`assigneeRole.${task.assignedToRole}`)
                                ? tTasks(`assigneeRole.${task.assignedToRole}`)
                                : `${task.assignedToRole} (untranslated)`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </>
                )}
              </div>
            )}
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}

function Field({
  label,
  value,
  valueNode,
  mono = false,
}: {
  readonly label: string;
  readonly value?: string;
  readonly valueNode?: React.ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-x-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          mono ? 'font-mono text-xs [overflow-wrap:anywhere]' : 'break-words'
        }
      >
        {valueNode ?? value ?? '—'}
      </dd>
    </div>
  );
}
