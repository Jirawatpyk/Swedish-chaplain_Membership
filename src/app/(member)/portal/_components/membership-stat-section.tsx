import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveMembershipStat } from '../_lib/dashboard-stats';
import { loadDashboardRenewalCycle } from './dashboard-reads';

/**
 * Chamber support/contact address for the lapsed-membership reactivation
 * mailto. Mirrors the portal's existing contact-admin affordance
 * (`invoices-summary-card.tsx`, which uses the same address). There is no
 * dedicated support-email env today; this single-tenant (SweCham) constant
 * should become a tenant-config value when Chamber-OS onboards a second tenant.
 */
const SUPPORT_CONTACT_EMAIL = 'info@swecham.se';

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
  const cycle = await loadDashboardRenewalCycle(tenantId, memberId);
  const stat = deriveMembershipStat(cycle, new Date());

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'error'
        ? t('errorValue')
        : stat.kind === 'lapsed'
          ? t('lapsedValue')
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
      : {};

  return (
    <StatCard
      label={t('label')}
      value={value}
      sub={sub}
      variant={stat.variant}
      {...variantProps}
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
