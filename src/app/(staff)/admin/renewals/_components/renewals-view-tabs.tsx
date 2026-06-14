/**
 * 070 F8 item #18 — `RenewalsViewTabs`.
 *
 * Top-level view toggle for `/admin/renewals`: the default urgency
 * pipeline vs the "Pending review" discovery list (cycles in
 * `pending_admin_reactivation` awaiting an admin approve/reject decision).
 *
 * A thin tab strip (mirrors `urgency-bucket-tabs.tsx` styling) that pushes
 * `?view=pending-review` (or clears it for the pipeline). Switching view
 * drops the pipeline-specific `urgency`/`tier`/`cursor` params so the two
 * surfaces don't leak filter state into each other.
 */
'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const PIPELINE_VALUE = 'pipeline';
const PENDING_REVIEW_VALUE = 'pending-review';

export interface RenewalsViewTabsProps {
  /** `'pending-review'` when that view is active, else `'pipeline'`. */
  readonly current: 'pipeline' | 'pending-review';
}

export function RenewalsViewTabs({ current }: RenewalsViewTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('admin.renewals');

  function handleChange(value: string) {
    if (value !== PIPELINE_VALUE && value !== PENDING_REVIEW_VALUE) return;
    const next = new URLSearchParams(params.toString());
    // Switching view resets the pipeline-only filter state.
    next.delete('cursor');
    if (value === PENDING_REVIEW_VALUE) {
      next.delete('urgency');
      next.delete('tier');
      next.set('view', PENDING_REVIEW_VALUE);
    } else {
      next.delete('view');
    }
    const qs = next.toString();
    router.push(qs.length > 0 ? `${pathname}?${qs}` : pathname);
  }

  return (
    <Tabs value={current} onValueChange={handleChange}>
      <TabsList aria-label={t('pendingReview.tab')}>
        <TabsTrigger value={PIPELINE_VALUE}>{t('title')}</TabsTrigger>
        <TabsTrigger value={PENDING_REVIEW_VALUE}>
          {t('pendingReview.tab')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
