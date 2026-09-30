/**
 * Empty-state for `/admin/renewals`. Renders when zero members fall in
 * the 90-day pipeline window (FR-046a). Reuses the shared `EmptyState`
 * shell primitive — primary CTA links to members directory; K9 secondary
 * link guides admins to schedule settings so they can verify the
 * tier-bucket reminder ladders are configured (a common cause of
 * "no upcoming renewals" being a config gap rather than a real
 * emptiness signal). That link targets a `settings.renewal_schedules`
 * page, so it only renders for a viewer holding that permission — a
 * manager following it would 404.
 *
 * A2 (renewals-suspended-visibility-audit UX review) — the empty state
 * used to SWALLOW the suspended-population bridge: with
 * `totalInWindow===0 && lapsedCount===0` this card replaces the whole
 * pipeline lens (urgency tabs included), which is exactly the
 * launch-shaped state — every member a first-bill collection case
 * OUTSIDE the window — where the bridge matters most. The optional
 * suspended counts render the SAME `SuspendedBridgeStrip` (same copy +
 * honest link) beneath the card; both props absent/0 keeps the render
 * byte-identical for the true-empty tenant. `shouldShowRenewalsEmptyState`
 * deliberately does NOT gate on the count — "no renewals due in the
 * window" stays true; the bridge line ADDS the missing context instead
 * of tearing out the empty state.
 */
import Link from 'next/link';
import { CalendarCheck2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/shell/empty-state';
import { buttonClass } from '@jirawatpyk/aura-react/server';
import { SuspendedBridgeStrip } from './suspended-bridge-strip';

export function RenewalsEmptyState({
  canManageSchedules,
  suspendedInWindowCount = 0,
  suspendedOutsideWindowCount = 0,
}: {
  /** `canPerform(role, 'settings.renewal_schedules')` — the gate on the
   *  schedule-settings page the secondary link targets. */
  readonly canManageSchedules: boolean;
  /** `summary.suspendedInWindowGlobalCount` (tenant-global, #292 A3) — 0 by
   *  definition when this card shows (it requires totalInWindow===0 with no
   *  tier filter, and the unfiltered badge equals the global count). */
  readonly suspendedInWindowCount?: number;
  /** `summary.suspendedOutsideWindowCount` — first-bill collection cases. */
  readonly suspendedOutsideWindowCount?: number;
}) {
  const t = useTranslations('admin.renewals.empty');
  const card = (
    <EmptyState
      icon={CalendarCheck2}
      title={t('title')}
      description={t('description')}
      // 122 US7a (`Admin-state-renewals-empty`): the primary button in its
      // own row, the settings link stacked beneath it.
      action={
        <div className="flex flex-col items-center gap-[var(--aura-space-3)]">
          <div className="flex flex-wrap justify-center gap-[var(--aura-space-2)]">
            <Link href="/admin/members" className={buttonClass({ variant: 'primary' })}>
              {t('cta')}
            </Link>
          </div>
          {canManageSchedules ? (
            <Link
              href="/admin/settings/renewals/schedules"
              className="text-sm font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
            >
              {t('settingsLink')}
            </Link>
          ) : null}
        </div>
      }
    />
  );
  if (suspendedOutsideWindowCount <= 0) return card;
  return (
    <div className="flex flex-col gap-[var(--aura-space-3)]">
      {card}
      <SuspendedBridgeStrip
        inWindowCount={suspendedInWindowCount}
        outsideWindowCount={suspendedOutsideWindowCount}
      />
    </div>
  );
}
