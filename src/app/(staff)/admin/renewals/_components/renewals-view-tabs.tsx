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

import { HelpCircleIcon } from 'lucide-react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

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
    <div className="flex items-center gap-1.5">
      <Tabs value={current} onValueChange={handleChange}>
        <TabsList aria-label={t('pendingReview.tab')}>
          <TabsTrigger value={PIPELINE_VALUE}>{t('title')}</TabsTrigger>
          <TabsTrigger value={PENDING_REVIEW_VALUE}>
            {t('pendingReview.tab')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* Tap-discoverable help explaining what the pipeline lists. A Popover
          (not a hover Tooltip) so it works on touch — same pattern as
          `company-section.tsx`. Placed BESIDE the tab strip, never nested in a
          TabsTrigger (which would break the tablist's roving-tabindex a11y). */}
      <Popover>
        <PopoverTrigger
          type="button"
          aria-label={t('pipelineHelp.ariaLabel')}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircleIcon className="size-4" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          className="w-80 max-w-[calc(100vw-2rem)] text-sm"
          sideOffset={4}
        >
          <p className="font-medium">{t('pipelineHelp.title')}</p>
          <p className="mt-1.5 text-muted-foreground">{t('pipelineHelp.body')}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
