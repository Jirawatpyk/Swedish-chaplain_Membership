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
import { notFound } from 'next/navigation';
import {
  getFormatter,
  getLocale,
  getTranslations,
} from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { ArrowLeft, SearchX } from 'lucide-react';
import { buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { EmptyState } from '@/components/shell/empty-state';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { loadCycleDetail, makeRenewalsDeps } from '@/modules/renewals';
import { CycleDetailBadges, renderCycleDetailView } from './_components/cycle-detail-view';
import { PendingReactivationActions } from './_components/pending-reactivation-actions';
import { CycleAdminActions } from './_components/cycle-admin-actions';
import { isCycleCancellable } from './_components/cycle-admin-validation';
import { resolveLiveLinkedBill } from '../_lib/mark-paid-gate';
// Phase 6 review-round 2 A2 — display-data fetchers extracted to a
// testable module so unit tests can drive the C4 error semantics
// (null-vs-throw) + TD1 zod parse without booting Drizzle.
import {
  fetchMemberDisplay,
  fetchPlanDisplay,
} from './_lib/cycle-detail-fetchers';
import {
  getDateFormatLocale,
  formatLocalisedDate,
} from '@/lib/format-date-localised';

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
  const tBasis = await getTranslations('admin.renewals.terminationBasis');
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

  // Auth + role check — managers permitted on this read-only surface.
  const { user: currentUser } = await requirePagePermission('renewals.read');

  const { cycleId } = await params;
  const requestHeaders = await headers();
  const requestId = requestHeaders.get('x-request-id') ?? randomUUID();
  const tenantCtx = resolveTenantFromRequest({
    headers: requestHeaders,
    nextUrl: { hostname: requestHeaders.get('host') ?? '' },
  } as unknown as Parameters<typeof resolveTenantFromRequest>[0]);
  const renewalsDeps = makeRenewalsDeps(tenantCtx.slug);

  // 016 T030 — the LITERAL role (the old ternary demoted a promoted
  // super_admin to 'manager'); the page gate admits exactly the use-case
  // schema's population, so anything else here is a gate bug — 404 rather
  // than a coerced audit stamp.
  // rbac-narrow-ok: a TYPE narrow onto the use-case's population, mirroring
  // the gate above — it can only fire if the gate itself regressed.
  const sessionRole = currentUser.role;
  if (sessionRole !== 'admin' && sessionRole !== 'manager' && sessionRole !== 'super_admin') {
    notFound();
  }
  const result = await loadCycleDetail(renewalsDeps, {
    tenantId: tenantCtx.slug,
    cycleId,
    actorUserId: currentUser.id,
    actorRole: sessionRole,
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
              <Link href="/admin/renewals" className={buttonClass({ variant: 'secondary' })}>
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

  // UX-A Bug 2: a `pending_admin_reactivation` cycle that ALSO carries the
  // async reject-with-refund marker (migration 0243) has already been rejected
  // by an admin — an F5 refund is settling and the reconcile cron will converge
  // it to `cancelled`. Surface this as a DISTINCT persistent state (amber
  // notice + badge, actions hidden) so it never reads as a fresh, undecided
  // cycle awaiting an approve/reject decision.
  const rejectRefundSettling =
    c.status === 'pending_admin_reactivation' &&
    c.rejectRefundInitiatedAt !== null;

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
  // Tenant-TZ pin (#315 follow-up, server-UTC display class): these two
  // format timestamptz INSTANTS — the UTC Vercel runtime rendered them 7h
  // off (and the wrong day for instants ≥ 17:00 UTC). `fmtCalendarDate`
  // below stays UTC-pinned by design (already-Bangkok calendar dates).
  const dtFmtFull = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: env.tenant.timezone,
  });
  const dtFmtDay = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
    timeZone: env.tenant.timezone,
  });
  const fmtDate = (s: string | null | undefined): string =>
    s ? dtFmtFull.format(new Date(s)) : '—';
  const fmtDateOnly = (s: string | null | undefined): string =>
    s ? dtFmtDay.format(new Date(s)) : '—';
  // 066 S3 — a value that is ALREADY a Bangkok calendar date
  // (`YYYY-MM-DD`), not a timestamptz instant. Route it through the shared,
  // UTC-pinned `formatLocalisedDate` so `new Date('2026-01-15')` (UTC
  // midnight) never renders one day early on a negative-UTC-offset host
  // (local dev / CI TZ=America/*). The timestamptz fields keep `dtFmtDay`.
  const fmtCalendarDate = (s: string | null | undefined): string =>
    s
      ? formatLocalisedDate(s, locale, { dateStyle: 'long', timeZone: 'UTC' })
      : '—';

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

  // 066 S3 — termination BASIS (why the member was terminated), read off
  // the `renewal_lapsed` audit payload by load-cycle-detail. Non-null only
  // for a lapsed cycle carrying a basis; renders under the closed-reason
  // field. Loud-fall-back to the raw enum matches closedReason/tierLabel.
  const terminationBasis = v.lapseInfo?.terminationBasis ?? null;
  const terminationBasisLabel = terminationBasis
    ? tBasis.has(terminationBasis)
      ? tBasis(terminationBasis)
      : `${terminationBasis} (untranslated)`
    : null;
  const terminationBasisDueDate = v.lapseInfo?.dueDate ?? null;

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

  // The linked bill as the admin actions see it (live unless F4 reports it
  // void) — decides "Record payment on {bill}" vs "Mark paid offline".
  const liveLinkedBill = resolveLiveLinkedBill(
    c.linkedInvoiceId,
    v.linkedInvoice,
  );
  const breadcrumbLabel = member ? member.companyName : shortId;

  // The period card's rows: bounds and expiry for every cycle (day-grain,
  // I-1), plus the state's own dates and reasons.
  const period: Array<{ label: string; value: string }> = [
    { label: t('fields.periodFrom'), value: fmtDateOnly(c.periodFrom) },
    { label: t('fields.periodTo'), value: fmtDateOnly(c.periodTo) },
    { label: t('fields.expiresAt'), value: fmtDateOnly(c.expiresAt) },
  ];
  if (showEnteredPendingAt) {
    period.push({ label: t('fields.enteredPendingAt'), value: fmtDate(c.enteredPendingAt ?? null) });
  }
  if (showClosedAt) {
    period.push({ label: t('fields.closedAt'), value: fmtDate(c.closedAt ?? null) });
  }
  if (closedReasonLabel) {
    period.push({ label: t('fields.closedReason'), value: closedReasonLabel });
  }
  if (terminationBasisLabel) {
    period.push({
      label: t('fields.terminationBasis'),
      value: terminationBasisDueDate
        ? t('fields.terminationBasisWithDue', {
            basis: terminationBasisLabel,
            date: fmtCalendarDate(terminationBasisDueDate),
          })
        : terminationBasisLabel,
    });
  }

  // Staff-Review-2026-05-09 SUG-5: a failed F2/F3 lookup is said, with the
  // request id for support, rather than left as a silent "—".
  const lookupFailedMessage =
    memberResult.status === 'rejected' && planResult.status === 'rejected'
      ? t('lookupFailedBoth', { requestId })
      : memberResult.status === 'rejected'
        ? t('lookupFailedMember', { requestId })
        : planResult.status === 'rejected'
          ? t('lookupFailedPlan', { requestId })
          : null;

  // Mutations follow the routes' own permission ('renewals.write'); managers
  // view this page read-only (016 re-review D).
  const canWrite = canPerform(currentUser.role, 'renewals.write');

  const view = await renderCycleDetailView({
    status: c.status,
    refundSettling: rejectRefundSettling,
    lookupFailedMessage,
    memberPlan: {
      company: memberCompany,
      // I-2 (UX R3): the company links to the member record.
      memberHref: member ? `/admin/members/${c.memberId}` : null,
      primaryContact: member?.primaryContact ?? t('fields.primaryContactNone'),
      tier: c.tierAtCycleStart,
      planName,
      frozenPrice,
      term: c.frozenPlanTermMonths !== null ? String(c.frozenPlanTermMonths) : '—',
      currency: c.frozenPlanCurrency ?? '—',
      technicalIds: { cycleId: c.cycleId, memberId: c.memberId, planId: c.planIdAtCycleStart },
    },
    invoice: v.linkedInvoice
      ? {
          // R2 follow-up: an unnumbered invoice falls back to ITS OWN id
          // prefix, never the cycle's.
          number: v.linkedInvoice.invoiceNumber ?? v.linkedInvoice.invoiceId.slice(0, 8),
          status: v.linkedInvoice.status,
          statusLabel: invoiceStatusLabel ?? '—',
          total: invoiceTotal ?? '—',
          href: `/admin/invoices/${v.linkedInvoice.invoiceId}`,
        }
      : null,
    invoicePendingMessage,
    period,
    auditTimestamps: { createdAt: fmtDate(c.createdAt), updatedAt: fmtDate(c.updatedAt) },
    reminders: v.reminderHistory.map((r) => ({
      id: r.reminderEventId,
      stepId: r.stepId,
      status: r.status,
      statusLabel: tReminder.has(`status.${r.status}`)
        ? tReminder(`status.${r.status}`)
        : `${r.status} (untranslated)`,
      date: r.dispatchedAt !== null ? fmtDate(r.dispatchedAt) : null,
      channel: tChannel.has(`channel.${r.channel}`)
        ? tChannel(`channel.${r.channel}`)
        : `${r.channel} (untranslated)`,
    })),
    // PR #24 review-fix Round 3 — the role is always shown: dispatcher-made
    // tasks carry a role but no user.
    escalations: v.escalationTasks.map((task) => ({
      id: task.taskId,
      typeLabel: tTasks.has(`taskType.${task.taskType}`)
        ? tTasks(`taskType.${task.taskType}`)
        : task.taskType,
      status: task.status,
      statusLabel: tTasks.has(`status.${task.status}`)
        ? tTasks(`status.${task.status}`)
        : `${task.status} (untranslated)`,
      date: fmtDate(task.dueAt),
      role: tTasks.has(`assigneeRole.${task.assignedToRole}`)
        ? tTasks(`assigneeRole.${task.assignedToRole}`)
        : `${task.assignedToRole} (untranslated)`,
    })),
    // On a phone the destructive action leaves the header for the end of the
    // page (board Admin-renewal-cycle-mobile): Cancel cycle, or Reject &
    // refund on an undecided pending cycle.
    dangerZone: !canWrite
      ? null
      : c.status === 'pending_admin_reactivation' && !rejectRefundSettling ? (
          <PendingReactivationActions
            cycleId={c.cycleId}
            status={c.status}
            rejectRefundInitiatedAt={c.rejectRefundInitiatedAt}
            placement="dangerZone"
          />
        ) : isCycleCancellable(c.status) ? (
          <CycleAdminActions
            cycleId={c.cycleId}
            status={c.status}
            liveLinkedBill={liveLinkedBill}
            placement="dangerZone"
          />
        ) : null,
  });

  return (
    <DetailContainer>
      {/* N-6 (round 3): the breadcrumb names the member, not a UUID. */}
      <PlanBreadcrumbLabel segment={cycleId} label={breadcrumbLabel} />

      <PageHeader
        // C-2 (UX R3): the status pill sits beside the title.
        title={`${t('title')} · ${memberCompany}`}
        badge={
          <CycleDetailBadges
            status={c.status}
            statusLabel={t(`cycleStatus.${c.status}`)}
            statusSrSuffix={
              t.has(`statusSeverity.${c.status}`) ? t(`statusSeverity.${c.status}`) : null
            }
            refundSettlingLabel={rejectRefundSettling ? t('refundSettlingBadge') : null}
          />
        }
        // I-1 (UX R3): anchored on the state's most relevant date.
        subtitle={subtitle}
        // The cycle's actions, as the board draws them. Each component renders
        // only the controls its status allows (the routes' own guards):
        // approve / reject on an undecided pending cycle, else record payment
        // or mark paid, and cancel.
        actions={
          canWrite ? (
            <>
              {c.status === 'pending_admin_reactivation' && (
                <PendingReactivationActions
                  cycleId={c.cycleId}
                  status={c.status}
                  rejectRefundInitiatedAt={c.rejectRefundInitiatedAt}
                />
              )}
              <CycleAdminActions
                cycleId={c.cycleId}
                status={c.status}
                liveLinkedBill={liveLinkedBill}
              />
            </>
          ) : null
        }
      />

      {view}
    </DetailContainer>
  );
}
