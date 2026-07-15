import { PauseCircle, TriangleAlert } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveMembershipStat } from '../_lib/dashboard-stats';
import { formatDueDate } from '../_lib/format-due-date';
import { findUnpaidMembershipInvoiceId, resolveSuspendedCtaTarget } from '../_lib/suspended-cta';
import { loadDashboardOutstanding, loadDashboardRenewalCycle } from './dashboard-reads';

/**
 * Chamber support/contact address for the lapsed-membership reactivation
 * mailto. Single source of truth is `SUPPORT_EMAIL` (env, defaulted to the
 * SweCham address) — the same value backs `invoices-summary-card.tsx`; override
 * per deployment / tenant-config at multi-tenant onboarding.
 */
const SUPPORT_CONTACT_EMAIL = env.supportEmail;

/**
 * 057 portal redesign §4.1 — Membership stat card section.
 *
 * Async server component — resolves the cached renewal cycle, derives
 * the display label/variant, and renders a `StatCard`. Wrap in Suspense
 * with `<StatSkeleton>` to stream this section independently.
 *
 * `StatCard` props used: `label` (already-localised), `value`, `sub`,
 * `variant`, `variantLabel` (required for non-neutral variants per spec
 * a11y-3 — colour alone is never the sole signal).
 */
export async function MembershipStatSection({
  tenantId,
  memberId,
}: {
  readonly tenantId: string;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.membership');
  const locale = await getLocale();
  const cycle = await loadDashboardRenewalCycle(tenantId, memberId);
  const stat = deriveMembershipStat(cycle, new Date());

  // 059-membership-suspension — the `suspended` kind needs the member's
  // unpaid MEMBERSHIP invoice (if any) for both the "invoice due {date}"
  // copy and the smart-CTA target. Reuses `loadDashboardOutstanding` (React
  // `cache()`-memoised per request) — the SAME read the Outstanding-balance
  // card already performs, so this never costs a second DB round-trip when
  // both sections render together.
  let suspendedInvoiceId: string | null = null;
  let suspendedInvoiceDueDate: string | null = null;
  if (stat.kind === 'suspended') {
    const outstanding = await loadDashboardOutstanding(tenantId, memberId);
    const invoices = outstanding.error ? [] : outstanding.inputs;
    suspendedInvoiceId = findUnpaidMembershipInvoiceId(invoices);
    suspendedInvoiceDueDate =
      suspendedInvoiceId !== null
        ? (invoices.find((i) => i.id === suspendedInvoiceId)?.dueDate ?? null)
        : null;
  }
  const suspendedIsPendingReview = stat.kind === 'suspended' && stat.reason === 'pending_review';

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'error'
        ? t('errorValue')
        : stat.kind === 'lapsed'
          ? t('lapsedValue')
          : stat.kind === 'suspended'
            ? suspendedIsPendingReview
              ? t('suspended.pendingReviewValue')
              : t('suspended.unpaidValue')
            : stat.kind === 'overdue'
              ? t('overdueValue')
              : stat.kind === 'due'
                ? t('renewDueValue')
                : t('activeValue');

  const sub =
    stat.kind === 'empty'
      ? t('emptySub')
      : stat.kind === 'error'
        ? t('errorSub')
        : stat.kind === 'lapsed'
          ? t('lapsedSub')
          : stat.kind === 'suspended'
            ? suspendedIsPendingReview
              ? t('suspended.pendingReviewSub')
              : suspendedInvoiceDueDate !== null
                ? t('suspended.unpaidSubWithDueDate', {
                    dueDate: formatDueDate(suspendedInvoiceDueDate, locale),
                  })
                : t('suspended.unpaidSubNoDueDate')
            : stat.kind === 'overdue' && stat.daysRemaining !== null
              ? t('overdueSub', { days: Math.abs(stat.daysRemaining) })
              : stat.daysRemaining !== null && stat.kind === 'due'
                ? t('daysRemainingSub', { days: stat.daysRemaining })
                : t('activeSub');

  // variantLabel mirrors the value text so the icon + text pair conveys
  // the same information (WCAG 1.4.1 — not colour alone).
  // Conditionally spread to satisfy exactOptionalPropertyTypes.
  const variantProps =
    stat.variant !== 'neutral' ? { variantLabel: value } : {};

  // 059-membership-suspension — distinct icons so `suspended` (amber
  // PauseCircle — "paused, not an accusation") and `lapsed`/terminated (red
  // TriangleAlert) are never visually confusable with the OTHER kind sharing
  // their variant tone (`due` keeps the default warning AlertTriangle;
  // `overdue` — retired, unreachable — keeps the default destructive
  // XCircle). Conditionally spread for exactOptionalPropertyTypes.
  const iconProps =
    stat.kind === 'suspended'
      ? { icon: PauseCircle }
      : stat.kind === 'lapsed'
        ? { icon: TriangleAlert }
        : {};

  // 067 — in-portal renewal CTA. When a NON-TERMINAL cycle is due/overdue the
  // card (which already shows that status) grows a "Renew now" button to the
  // renewal flow — the in-portal entry point that previously existed only in
  // the reminder email. Kept IN the card (not a separate banner) so the status
  // the card already shows isn't duplicated. Conditionally spread for
  // exactOptionalPropertyTypes.
  //
  // `lapsed` deliberately does NOT link to /portal/renewal/[memberId]: that
  // page resolves the member's cycle via findActiveForMember, which rejects
  // terminal cycles (lapsed/cancelled/completed) → the page redirect('/portal'),
  // a dead-end for exactly the lapsed cohort. Renewal of a lapsed member is
  // ADMIN-driven (adminRenewLapsedMember); there is no member self-serve path.
  //
  // Cluster 4 (2026-07-12) — instead of the prior dead "Renew to restore"
  // promise (a button that no-op'd), the lapsed card now surfaces a real next
  // step: a mailto contact-support CTA so the member can ask the chamber to
  // reactivate. Mirrors the portal's existing contact-admin affordance
  // (invoices-summary-card.tsx). Subject line is i18n-driven so members email
  // in their own language.
  const renewable = stat.kind === 'overdue' || stat.kind === 'due';

  // 059-membership-suspension — smart CTA for the `suspended` card (design
  // doc § "Smart CTA — must never dead-end"): pay the specific outstanding
  // invoice when one exists, else self-serve renew (which self-issues an
  // invoice on confirm). `pending_review` gets NO CTA — the member already
  // paid; prompting them again would be actively wrong.
  const suspendedCta =
    stat.kind === 'suspended'
      ? resolveSuspendedCtaTarget({
          reason: stat.reason === 'pending_review' ? 'pending_review' : 'unpaid',
          unpaidMembershipInvoiceId: suspendedInvoiceId,
          memberId,
        })
      : null;

  const actionProps = renewable
    ? {
        action: {
          href: `/portal/renewal/${memberId}`,
          label: t('renewNow'),
        },
      }
    : stat.kind === 'lapsed'
      ? {
          action: {
            href: `mailto:${SUPPORT_CONTACT_EMAIL}?subject=${encodeURIComponent(
              t('lapsedMailSubject'),
            )}`,
            label: t('contactToRenew'),
          },
        }
      : suspendedCta !== null
        ? {
            action: {
              href: suspendedCta.href,
              label: t('suspended.payCta'),
            },
          }
        : {};

  return (
    <StatCard
      label={t('label')}
      value={value}
      sub={sub}
      variant={stat.variant}
      {...variantProps}
      {...iconProps}
      {...actionProps}
    />
  );
}

/** Shimmer skeleton while the async section streams in. */
export function StatSkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true" className="h-full">
      <CardContent className="flex flex-col gap-2 py-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  );
}
