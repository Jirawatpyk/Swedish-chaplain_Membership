/**
 * Empty-state for `/admin/renewals`. Renders when zero members fall in
 * the 90-day pipeline window (FR-046a). Reuses the shared `EmptyState`
 * shell primitive — primary CTA links to members directory; K9 secondary
 * link guides admins to schedule settings so they can verify the
 * tier-bucket reminder ladders are configured (a common cause of
 * "no upcoming renewals" being a config gap rather than a real
 * emptiness signal).
 */
import Link from 'next/link';
import { CalendarCheck2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/shell/empty-state';
import { buttonVariants } from '@/components/ui/button';

export function RenewalsEmptyState() {
  const t = useTranslations('admin.renewals.empty');
  return (
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
}
