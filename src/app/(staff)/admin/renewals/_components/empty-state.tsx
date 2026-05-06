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
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('cta')}
          </Link>
          <Link
            href="/admin/renewals/settings/schedules"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('settingsLink')}
          </Link>
        </div>
      }
    />
  );
}
