/**
 * F8 Phase 3 Wave H4 · T069 — Empty-state for `/admin/renewals`.
 *
 * Renders when zero members fall in the 90-day pipeline window
 * (FR-046a). Reuses the shared `EmptyState` shell primitive.
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
        <Link href="/admin/members" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('cta')}
        </Link>
      }
    />
  );
}
