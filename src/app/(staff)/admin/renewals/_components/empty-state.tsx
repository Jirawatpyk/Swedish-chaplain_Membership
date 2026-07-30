/**
 * Empty-state for `/admin/renewals`. Renders when zero members fall in
 * the 90-day pipeline window (FR-046a). Reuses the shared `EmptyState`
 * shell primitive — primary CTA links to members directory; K9 secondary
 * link guides admins to schedule settings so they can verify the
 * tier-bucket reminder ladders are configured (a common cause of
 * "no upcoming renewals" being a config gap rather than a real
 * emptiness signal).
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
import { buttonVariants } from '@/components/ui/button';
import { SuspendedBridgeStrip } from './suspended-bridge-strip';

export function RenewalsEmptyState({
  suspendedInWindowCount = 0,
  suspendedOutsideWindowCount = 0,
}: {
  /** `summary.suspendedInWindowGlobalCount` (tenant-global, #292 A3) — 0 by
   *  definition when this card shows (it requires totalInWindow===0 with no
   *  tier filter, and the unfiltered badge equals the global count). */
  readonly suspendedInWindowCount?: number;
  /** `summary.suspendedOutsideWindowCount` — first-bill collection cases. */
  readonly suspendedOutsideWindowCount?: number;
} = {}) {
  const t = useTranslations('admin.renewals.empty');
  const card = (
    <EmptyState
      icon={CalendarCheck2}
      title={t('title')}
      description={t('description')}
      action={
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <Link
            href="/admin/members"
            // K12-S (UX-K-5): primary CTA is `default` (solid) per
            // ux-standards.md § 3.1 — `outline` was a stylistic
            // mistake; primary actions ought to carry the most
            // visual weight. Secondary "settings" link below stays
            // muted text to preserve the hierarchy.
            className={buttonVariants({ variant: 'default', size: 'sm' })}
          >
            {t('cta')}
          </Link>
          <Link
            href="/admin/settings/renewals/schedules"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('settingsLink')}
          </Link>
        </div>
      }
    />
  );
  if (suspendedOutsideWindowCount <= 0) return card;
  return (
    <div className="flex flex-col gap-3">
      {card}
      <SuspendedBridgeStrip
        inWindowCount={suspendedInWindowCount}
        outsideWindowCount={suspendedOutsideWindowCount}
      />
    </div>
  );
}
